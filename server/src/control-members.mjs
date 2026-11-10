import { randomUUID } from 'node:crypto';
import { AppError, assert, errorBody } from './errors.mjs';
import { accountView } from './account-store.mjs';
import { readBody } from './multipart.mjs';

export const CONTROL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CUTOVER = 'control_members_cutover_v1';
export function controlFields(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value,key)), 'Die Angaben sind unvollständig oder enthalten unbekannte Felder.');
}
export function controlText(value, max, min = 0) {
  assert(typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value), 'Ein Text enthält ungültige Zeichen oder ist zu lang.');
  const result = value.trim(); assert(result.length >= min, 'Bitte alle Pflichtangaben ausfüllen.'); return result;
}
export async function controlBody(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte JSON senden.', 'validation', 415);
  let result; try { result = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch (error) { if(error instanceof AppError)throw error; throw new AppError('validation','Die Anfrage enthält kein gültiges JSON.'); }
  assert(result && typeof result === 'object' && !Array.isArray(result), 'Die Angaben sind ungültig.'); return result;
}
export function controlResponse(res, value, status = 200) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie, Authorization'}); res.end(JSON.stringify(value));
}
export function ensureControlNotices(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS control_notice_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(type,target_id,revision));`);
}
export function controlNotice(store, type, targetId, revision, now) {
  assert(['member_registered','pc_ticket','pc_order','robot_order','gaming_setup','community_report'].includes(type) && CONTROL_UUID.test(targetId) && Number.isSafeInteger(revision) && revision >= 0, 'Die Benachrichtigung ist ungültig.');
  store.run('INSERT OR IGNORE INTO control_notice_events(id,type,target_id,revision,created_at) VALUES (?,?,?,?,?)',randomUUID(),type,targetId,revision,now);
}
export function controlPage(input, { statuses, kinds = null, defaultLimit = 50 } = {}) {
  const allowed = ['limit','cursor','status','search',...(kinds?['kind']:[])]; controlFields(input,allowed,[]);
  const limit = input.limit ?? defaultLimit, status = input.status ?? 'all', search = controlText(input.search ?? '',100);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && statuses.includes(status), 'Die Listenabfrage ist ungültig.');
  const kind = kinds ? input.kind ?? 'all' : null; if(kinds)assert(kinds.includes(kind),'Die Anfrageart ist ungültig.');
  let cursor = null;
  if(input.cursor != null && input.cursor !== '') {
    assert(typeof input.cursor === 'string' && /^[A-Za-z0-9_-]{1,400}$/.test(input.cursor),'Der Listen-Cursor ist ungültig.');
    try { cursor = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')); } catch { throw new AppError('validation','Der Listen-Cursor ist ungültig.'); }
    assert(Array.isArray(cursor) && cursor.length === 2 && Number.isSafeInteger(cursor[0]) && cursor[0] >= 0 && CONTROL_UUID.test(cursor[1]),'Der Listen-Cursor ist ungültig.');
  }
  return {limit,status,search,kind,cursor};
}
export const controlNextCursor = (rows, limit, timestamp) => rows.length > limit ? Buffer.from(JSON.stringify([rows[limit-1][timestamp],rows[limit-1].id])).toString('base64url') : null;

export class ControlMembers {
  constructor(accounts,{now=accounts.now || Date.now}={}) {
    this.accounts=accounts;this.store=accounts.store;this.now=now;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS control_member_approvals(
      user_id TEXT PRIMARY KEY REFERENCES accounts(id),status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
      revision INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',reviewed_at INTEGER,reviewed_by TEXT REFERENCES accounts(id),
      legacy INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);`);
    ensureControlNotices(this.store);
    this.store.transaction(()=>{
      if(this.store.setting(CUTOVER))return;
      // The migration marks exactly the accounts present at cutover. It never reruns
      // based on provider timestamps, which could otherwise approve new accounts.
      this.store.run(`INSERT OR IGNORE INTO control_member_approvals(user_id,status,revision,legacy,created_at)
        SELECT id,'approved',0,1,created_at FROM accounts`);
      this.store.setSetting(CUTOVER,String(this.now()));
    });
  }
  current(context) { return this.accounts.assertCurrent(context,{admin:true}); }
  status(userId) {
    const row=this.store.get('SELECT * FROM control_member_approvals WHERE user_id=?',userId);
    return row ? {status:row.status,revision:row.revision,reason:row.reason,reviewedAt:row.reviewed_at,reviewedBy:row.reviewed_by,legacy:!!row.legacy} : {status:'pending',revision:0,reason:'',reviewedAt:null,reviewedBy:null,legacy:false};
  }
  observe(userId) {
    assert(CONTROL_UUID.test(userId),'Ungültiges Mitglied.');
    const account=this.store.get('SELECT * FROM accounts WHERE id=?',userId);assert(account,'Dieses Konto ist nicht vorhanden.','not_found',404);
    this.store.transaction(()=>{
      this.store.run("INSERT OR IGNORE INTO control_member_approvals(user_id,status,revision,legacy,created_at) VALUES (?,'pending',0,0,?)",userId,account.created_at);
      const approval=this.status(userId);
      if(account.confirmed && !account.suspended && approval.status==='pending')controlNotice(this.store,'member_registered',userId,0,this.now());
    });
    return this.status(userId);
  }
  assertApproved(context) {
    // Deliberately does not call assertCurrent: the account service may invoke this
    // guard from its own authorization routine without introducing recursion.
    const account=this.store.get('SELECT * FROM accounts WHERE id=?',context?.user?.id || '');
    assert(account,'Bitte zuerst anmelden.','auth',401);
    if(account.is_admin)return;
    const status=this.status(account.id).status;
    assert(status==='approved',status==='rejected'?'Deine Registrierung wurde nicht freigegeben.':'Deine Registrierung wartet noch auf die Freigabe durch das Team.','registration_'+status,403);
  }
  view(row) { return {...accountView(row),createdAt:row.created_at,verifiedAt:row.verified_at,approval:this.status(row.id)}; }
  list(context,input={}) {
    this.current(context);const query=controlPage(input,{statuses:['all','pending','approved','rejected'],defaultLimit:100});
    const where=[],args=[];
    if(query.status!=='all'){where.push("COALESCE(p.status,'pending')=?");args.push(query.status);}
    if(query.search){where.push('(instr(lower(a.name),lower(?))>0 OR instr(lower(a.email),lower(?))>0)');args.push(query.search,query.search);}
    if(query.cursor){where.push('(a.created_at<? OR (a.created_at=? AND a.id<?))');args.push(query.cursor[0],query.cursor[0],query.cursor[1]);}
    const rows=this.store.all(`SELECT a.* FROM accounts a LEFT JOIN control_member_approvals p ON p.user_id=a.id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,...args,query.limit+1);
    const counts=this.store.get(`SELECT COUNT(*) AS total,COALESCE(SUM(COALESCE(p.status,'pending')='pending'),0) AS pending,
      COALESCE(SUM(p.status='approved'),0) AS approved,COALESCE(SUM(p.status='rejected'),0) AS rejected,COALESCE(SUM(a.confirmed=0),0) AS unconfirmed
      FROM accounts a LEFT JOIN control_member_approvals p ON p.user_id=a.id`);
    return {members:rows.slice(0,query.limit).map(row=>this.view(row)),nextCursor:controlNextCursor(rows,query.limit,'created_at'),counts,cutoverAt:Number(this.store.setting(CUTOVER))};
  }
  review(context,userId,input) {
    const actor=this.current(context);assert(CONTROL_UUID.test(userId),'Dieses Mitglied ist nicht vorhanden.','not_found',404);
    controlFields(input,['expectedRevision','decision','reason','confirm']);assert(input.confirm===true && ['approve','reject'].includes(input.decision) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision>=0,'Bitte eine gültige Entscheidung bestätigen.');
    const reason=controlText(input.reason,1000,input.decision==='reject'?3:0);
    this.observe(userId);
    this.store.transaction(()=>{
      this.current(context);const target=this.store.get('SELECT * FROM accounts WHERE id=?',userId),before=this.status(userId);
      assert(before.revision===input.expectedRevision,'Das Mitglied wurde inzwischen geprüft. Bitte neu laden.','conflict',409);
      if(input.decision==='approve')assert(target.confirmed&&!target.suspended && ['pending','rejected'].includes(before.status),'Nur bestätigte und nicht gesperrte Anmeldungen können neu freigegeben werden.','conflict',409);
      else assert(before.status==='pending' && !target.is_admin && actor.id!==target.id,'Dieses Konto kann hier nicht abgelehnt werden.','forbidden',403);
      this.store.run('UPDATE control_member_approvals SET status=?,revision=revision+1,reason=?,reviewed_at=?,reviewed_by=? WHERE user_id=?',input.decision==='approve'?'approved':'rejected',reason,this.now(),actor.id,userId);
      this.store.audit(actor.id,'registration.'+input.decision,userId,{revision:before.revision+1},this.now());
    });
    return {member:this.view(this.store.get('SELECT * FROM accounts WHERE id=?',userId))};
  }
  async handle(req,res) {
    const route=new URL(req.url,'http://local.invalid').pathname,review=/^\/api\/admin\/control-members\/([0-9a-f-]{36})\/review$/i.exec(route);
    if(route!=='/api/admin/control-members/query' && route!=='/api/account/approval' && !review)return false;
    try {
      if(route==='/api/account/approval') {
        assert(req.method==='GET','Diese Methode ist nicht erlaubt.','method',405);
        const context=await this.accounts.authenticateRequest(req,{allowPending:true});controlResponse(res,{approval:this.status(context.user.id)});return true;
      }
      assert(req.method==='POST','Diese Methode ist nicht erlaubt.','method',405);
      const context=await this.accounts.authorizeAdmin(req);this.accounts.limit('control-members:'+context.user.id,60);
      const body=await controlBody(req);controlResponse(res,review?this.review(context,review[1],body):this.list(context,body));
    } catch(error) { controlResponse(res,errorBody(error),error instanceof AppError?error.status:500); }
    return true;
  }
}
