import crypto from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { Vault, sha256 } from './store.mjs';
import { pushSubscription, pushEndpoint, sendPush } from './chat-push.mjs';

const TYPES = new Set(['member_registered','pc_ticket','pc_order','robot_order','gaming_setup','community_report','test']);
const REVIEW_TYPES = new Set(['gaming_setup','community_report']);
const TEXT = { member_registered:'Eine neue Website-Registrierung wartet auf dich.', pc_ticket:'Eine neue PC-Problemmeldung ist eingegangen.', pc_order:'Eine PC-Auftragsanfrage wartet auf deine Entscheidung.', robot_order:'Ein Robot-SchichtLog-Eintrag wurde synchronisiert.', gaming_setup:'Ein Gaming-Setup wartet auf deine Freigabe.', community_report:'Eine Mitgliedermeldung wartet auf deine Prüfung.', test:'Benachrichtigungen für dein Control Center sind eingeschaltet.' };
const MAX_AGE = 7 * 86400_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const NOTICE_SCHEMA = `CREATE TABLE IF NOT EXISTS control_notice_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(type,target_id,revision));`;

export async function controlJson(req, limit = 8192) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte JSON senden.', 'validation',415);
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;assert(size<=limit,'Die Anfrage ist zu groß.','validation',413);parts.push(part);}
  let result;try{result=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError('validation','Ungültige JSON-Angaben.');}
  assert(result && typeof result==='object'&&!Array.isArray(result),'Bitte gültige Angaben senden.');return result;
}
const fields=(value,allowed)=>assert(Object.keys(value).every(k=>allowed.includes(k))&&allowed.every(k=>Object.hasOwn(value,k)),'Unvollständige oder unbekannte Angaben.');
export class ControlPush {
  constructor(accounts,{transport=sendPush,autoStart=true}={}){
    this.accounts=accounts;this.store=accounts.store;this.now=accounts.now;this.transport=transport;this.autoStart=autoStart;
    this.vault=new Vault(accounts.config.encryptionKey);this.running=false;this.closed=false;
    this.store.db.exec(NOTICE_SCHEMA+`
      CREATE TABLE IF NOT EXISTS control_push_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,subscription TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control_push_capabilities(device_id TEXT PRIMARY KEY REFERENCES control_push_devices(id) ON DELETE CASCADE,setup_push_version INTEGER NOT NULL DEFAULT 0 CHECK(setup_push_version IN (0,1)));
      CREATE TABLE IF NOT EXISTS control_push_deliveries(event_id TEXT NOT NULL REFERENCES control_notice_events(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES control_push_devices(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_status INTEGER,PRIMARY KEY(event_id,device_id));
      CREATE INDEX IF NOT EXISTS control_push_due ON control_push_deliveries(status,next_attempt_at);`);
    // The original devices table keeps its five columns for older app rollbacks.
    // Older capability writes name their columns, so this additive column is safe.
    if(!this.store.all('PRAGMA table_info(control_push_capabilities)').some(column=>column.name==='report_push_version'))this.store.db.exec('ALTER TABLE control_push_capabilities ADD COLUMN report_push_version INTEGER NOT NULL DEFAULT 0 CHECK(report_push_version IN (0,1))');
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS control_push_delivery_history(event_id TEXT NOT NULL,device_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,type TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,last_status INTEGER,updated_at INTEGER NOT NULL,PRIMARY KEY(event_id,device_id,user_id));
      CREATE TABLE IF NOT EXISTS control_push_device_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,reason TEXT NOT NULL,http_status INTEGER,created_at INTEGER NOT NULL);`);
    this.store.run('INSERT OR IGNORE INTO control_push_delivery_history SELECT q.event_id,q.device_id,d.user_id,e.type,q.status,q.attempts,q.last_status,? FROM control_push_deliveries q JOIN control_push_devices d ON d.id=q.device_id JOIN control_notice_events e ON e.id=q.event_id',this.now());
    if(autoStart)this.schedule(5000);
  }
  close(){this.closed=true;clearTimeout(this.timer);this.aborter?.abort();}
  operator(context){return this.accounts.suiteLicense.requireOperator(context);}
  currentOperator(){try{return this.accounts.suiteLicense.operator();}catch{return null;}}
  keys(){return this.accounts.community.push.keys();}
  status(userId){const enabled=!!this.accounts.community?.push?.enabled;return {enabled,publicKey:enabled?this.keys().publicKey:null,registeredDevices:this.store.get('SELECT COUNT(*) AS n FROM control_push_devices WHERE user_id=?',userId).n};}
  setupNoticeState(event){try{return this.accounts.gamingSetups?.reviewNoticeState(event)||'paused';}catch{return 'paused';}}
  reviewNoticeState(event){try{return event.type==='community_report'?(this.accounts.communityControl?.reportNoticeState(event)||'paused'):this.setupNoticeState(event);}catch{return 'paused';}}
  rememberDelivery(row,status,lastStatus=row.last_status,attempts=row.attempts){
    this.store.run(`INSERT INTO control_push_delivery_history(event_id,device_id,user_id,type,status,attempts,last_status,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(event_id,device_id,user_id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,last_status=excluded.last_status,updated_at=excluded.updated_at
      WHERE control_push_delivery_history.status!='delivered' OR excluded.status='delivered'`,row.event_id,row.device_id,row.user_id,row.type,status,attempts??0,lastStatus??null,this.now());
  }
  forgetDevice(id,reason,httpStatus=null){
    const device=this.store.get('SELECT user_id FROM control_push_devices WHERE id=?',id);if(!device)return false;
    for(const row of this.store.all('SELECT q.*,e.type,d.user_id FROM control_push_deliveries q JOIN control_notice_events e ON e.id=q.event_id JOIN control_push_devices d ON d.id=q.device_id WHERE q.device_id=?',id))this.rememberDelivery(row,row.status==='pending'?(reason==='provider_expired'||reason==='subscription_expired'?'expired':'cancelled'):row.status,row.status==='pending'?httpStatus:row.last_status);
    this.store.run('INSERT INTO control_push_device_events VALUES(?,?,?,?,?)',crypto.randomUUID(),device.user_id,reason,httpStatus,this.now());
    this.store.run('DELETE FROM control_push_devices WHERE id=?',id);return true;
  }
  decrypt(row){
    const raw=this.vault.open(JSON.parse(row.subscription));
    assert(raw.purpose==='control-push-v1'&&raw.id===row.id&&raw.userId===row.user_id,'Geräteanmeldung ungültig.','unconfigured',503);
    const sub=pushSubscription(raw.subscription);assert(sha256(sub.endpoint)===row.id,'Geräteanmeldung ungültig.');return sub;
  }
  register(context,input,{setupPushVersion=0,reportPushVersion=0}={}){
    assert([0,1].includes(setupPushVersion)&&[0,1].includes(reportPushVersion),'Die Geräteversion ist ungültig.');
    const user=this.operator(context),subscription=pushSubscription(input),id=sha256(subscription.endpoint),now=this.now();
    assert(!subscription.expirationTime||subscription.expirationTime>now,'Die Geräteanmeldung ist abgelaufen.');this.keys();
    this.store.transaction(()=>{
      const old=this.store.get('SELECT * FROM control_push_devices WHERE id=?',id);
      if(old&&old.user_id!==user.id){const previous=this.decrypt(old);assert(previous.keys.auth===subscription.keys.auth&&previous.keys.p256dh===subscription.keys.p256dh,'Dieses Gerät gehört zu einer anderen Anmeldung.','conflict',409);this.forgetDevice(id,'operator_changed');}
      assert(old?.user_id===user.id||this.store.get('SELECT COUNT(*) AS n FROM control_push_devices WHERE user_id=?',user.id).n<10,'Höchstens zehn Geräte sind erlaubt.','conflict',409);
      const sealed=JSON.stringify(this.vault.seal({purpose:'control-push-v1',id,userId:user.id,subscription}));
      this.store.run(`INSERT INTO control_push_devices(id,user_id,subscription,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,subscription=excluded.subscription,updated_at=excluded.updated_at`,id,user.id,sealed,now,now);
      this.store.run('INSERT INTO control_push_capabilities(device_id,setup_push_version,report_push_version) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET setup_push_version=MAX(control_push_capabilities.setup_push_version,excluded.setup_push_version),report_push_version=MAX(control_push_capabilities.report_push_version,excluded.report_push_version)',id,setupPushVersion,reportPushVersion);
      if(!old||old.user_id!==user.id)this.store.run('INSERT INTO control_push_device_events VALUES(?,?,?,?,?)',crypto.randomUUID(),user.id,'registered',null,now);
    });const capability=this.store.get('SELECT setup_push_version,report_push_version FROM control_push_capabilities WHERE device_id=?',id);return {...this.status(user.id),setupPushVersion:capability.setup_push_version,reportPushVersion:capability.report_push_version};
  }
  check(context,endpoint,{setupPushVersion=0,reportPushVersion=0}={}){
    assert([0,1].includes(setupPushVersion)&&[0,1].includes(reportPushVersion),'Die Geräteversion ist ungültig.');
    const user=this.operator(context),id=sha256(pushEndpoint(endpoint));
    // No response from an old page/worker is not evidence of a downgrade. A
    // confirmed capability is monotonic for the lifetime of this subscription.
    this.store.run('INSERT INTO control_push_capabilities(device_id,setup_push_version,report_push_version) SELECT id,?,? FROM control_push_devices WHERE id=? AND user_id=? ON CONFLICT(device_id) DO UPDATE SET setup_push_version=MAX(control_push_capabilities.setup_push_version,excluded.setup_push_version),report_push_version=MAX(control_push_capabilities.report_push_version,excluded.report_push_version)',setupPushVersion,reportPushVersion,id,user.id);
    const device=this.store.get('SELECT c.setup_push_version,c.report_push_version FROM control_push_devices d JOIN control_push_capabilities c ON c.device_id=d.id WHERE d.id=? AND d.user_id=?',id,user.id);
    return {registered:!!device,setupPushVersion:device?.setup_push_version||0,reportPushVersion:device?.report_push_version||0};
  }
  remove(context,endpoint){const user=this.operator(context),id=sha256(pushEndpoint(endpoint));this.store.transaction(()=>{if(this.store.get('SELECT 1 FROM control_push_devices WHERE id=? AND user_id=?',id,user.id))this.forgetDevice(id,'user_removed');});return {ok:true,...this.status(user.id)};}
  test(context){const user=this.operator(context),id=crypto.randomUUID();this.accounts.limit('control-push-test:'+user.id,5,3600_000);this.store.run('INSERT INTO control_notice_events VALUES(?,?,?,?,?)',id,'test',user.id,this.now(),this.now());if(this.autoStart)this.schedule(0);return {queued:true,eventId:id};}
  async handle(req,res){
    const route=new URL(req.url,'http://control.invalid').pathname;
    if(!route.startsWith('/api/control-mobile/'))return false;
    const mutation=!['GET','HEAD'].includes(req.method);
    const context=await this.accounts.authenticateRequest(req,{mutation,requireAdmin:true});const user=this.operator(context);
    assert(context.session.kind==='browser'&&!req.headers.authorization,'Bitte im Browser der Handy-App anmelden.','forbidden',403);
    let data;
    if(route==='/api/control-mobile/session'&&req.method==='GET')data={user:{id:user.id,name:user.name},csrfToken:context.csrfToken};
    else if(route==='/api/control-mobile/push'&&req.method==='GET')data=this.status(user.id);
    else if(route==='/api/control-mobile/push/check'&&req.method==='POST'){const value=await controlJson(req);fields(value,['endpoint',...['setupPushVersion','reportPushVersion'].filter(key=>Object.hasOwn(value,key))]);data=this.check(context,value.endpoint,value);}
    else if(route==='/api/control-mobile/push'&&req.method==='POST'){this.accounts.limit('control-push:'+user.id,30,3600_000);const value=await controlJson(req);fields(value,['subscription',...['setupPushVersion','reportPushVersion'].filter(key=>Object.hasOwn(value,key))]);data=this.register(context,value.subscription,value);}
    else if(route==='/api/control-mobile/push'&&req.method==='DELETE'){const value=await controlJson(req);fields(value,['endpoint']);data=this.remove(context,value.endpoint);}
    else if(route==='/api/control-mobile/push/test'&&req.method==='POST'){const value=await controlJson(req);fields(value,['confirm']);assert(value.confirm===true,'Test nicht bestätigt.');data=this.test(context);}
    else throw new AppError('not_found','Unbekannte Handy-App-Aktion.',404);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','Vary':'Cookie'});res.end(JSON.stringify(data));return true;
  }
  schedule(delay){if(this.closed||this.running||!this.autoStart)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.drain().catch(()=>{});},delay);this.timer.unref?.();}
  async drain(){
    if(this.running||this.closed)return;this.running=true;
    try{
      const now=this.now(),owner=this.currentOperator();
      this.store.run("DELETE FROM control_notice_events WHERE created_at<? AND type NOT IN ('gaming_setup','community_report')",now-MAX_AGE);
      this.store.run('DELETE FROM control_push_delivery_history WHERE updated_at<? AND event_id NOT IN (SELECT id FROM control_notice_events)',now-90*86400_000);
      this.store.run('DELETE FROM control_push_device_events WHERE created_at<?',now-90*86400_000);
      // Pending approvals stay available when the first phone is registered late.
      // Keep their original event/receipt rather than recreating a weekly notice.
      for(const event of this.store.all("SELECT * FROM control_notice_events WHERE type IN ('gaming_setup','community_report') AND created_at<?",now-MAX_AGE))if(this.reviewNoticeState(event)==='obsolete')this.store.run('DELETE FROM control_notice_events WHERE id=?',event.id);
      if(!owner||!this.accounts.community?.push?.enabled)return;
      this.store.run(`INSERT OR IGNORE INTO control_push_deliveries(event_id,device_id,next_attempt_at)
        SELECT e.id,d.id,? FROM (SELECT * FROM control_notice_events WHERE created_at>=? OR type IN ('gaming_setup','community_report') ORDER BY created_at DESC,id DESC LIMIT 1000) e
        JOIN control_push_devices d ON d.user_id=? LEFT JOIN control_push_capabilities c ON c.device_id=d.id
        WHERE ((e.type='gaming_setup' AND COALESCE(c.setup_push_version,0)>=1) OR (e.type='community_report' AND COALESCE(c.report_push_version,0)>=1) OR (e.type NOT IN ('gaming_setup','community_report') AND e.created_at>=d.created_at))
        AND NOT EXISTS(SELECT 1 FROM control_push_delivery_history h WHERE h.event_id=e.id AND h.device_id=d.id AND h.user_id=d.user_id AND h.status='delivered')`,now,now-MAX_AGE,owner);
      const rows=this.store.all(`SELECT q.*,e.type,e.target_id,e.revision,d.user_id FROM control_push_deliveries q JOIN control_notice_events e ON e.id=q.event_id JOIN control_push_devices d ON d.id=q.device_id WHERE q.status='pending' AND q.next_attempt_at<=? ORDER BY e.created_at,e.id LIMIT 12`,now);
      for(const row of rows){
        if(this.closed)break;
        if(row.user_id!==this.currentOperator()||!TYPES.has(row.type)||!UUID.test(row.target_id)){this.store.run("UPDATE control_push_deliveries SET status='discarded' WHERE event_id=? AND device_id=?",row.event_id,row.device_id);this.rememberDelivery(row,'discarded');continue;}
        if(REVIEW_TYPES.has(row.type)){
          const state=this.reviewNoticeState(row);
          if(state==='obsolete'){this.store.run("UPDATE control_push_deliveries SET status='discarded' WHERE event_id=? AND device_id=?",row.event_id,row.device_id);this.rememberDelivery(row,'discarded');continue;}
          if(state!=='ready'){this.store.run('UPDATE control_push_deliveries SET next_attempt_at=? WHERE event_id=? AND device_id=?',now+30000,row.event_id,row.device_id);continue;}
        }
        const device=this.store.get('SELECT d.*,COALESCE(c.setup_push_version,0) AS setup_push_version,COALESCE(c.report_push_version,0) AS report_push_version FROM control_push_devices d LEFT JOIN control_push_capabilities c ON c.device_id=d.id WHERE d.id=? AND d.user_id=?',row.device_id,row.user_id);if(!device)continue;
        if((row.type==='gaming_setup'&&device.setup_push_version<1)||(row.type==='community_report'&&device.report_push_version<1)){this.store.run('UPDATE control_push_deliveries SET next_attempt_at=? WHERE event_id=? AND device_id=?',now+30000,row.event_id,row.device_id);continue;}
        try{
          const sub=this.decrypt(device);if(sub.expirationTime&&sub.expirationTime<=this.now()){this.store.transaction(()=>this.forgetDevice(device.id,'subscription_expired'));continue;}
          const section=row.type==='member_registered'?'members':row.type==='robot_order'?'robot':row.type==='gaming_setup'?'setups':row.type==='community_report'?'reports':'support';
          const payload=JSON.stringify({kind:'control-center',eventId:row.event_id,recipientId:row.user_id,title:'Crazy_Batto · Control Center',body:TEXT[row.type],url:'/control-center/?view='+section,tag:'cb-control-'+row.type+'-'+row.target_id});
          this.aborter=new AbortController();
          await this.transport(sub,payload,{vapidDetails:{subject:new URL('/kontakt.html',this.accounts.config.publicOrigin).href,...this.keys()},TTL:86400,urgency:'high',contentEncoding:'aes128gcm',topic:sha256(row.event_id).slice(0,32)},this.aborter.signal);
          if(!this.closed)this.store.transaction(()=>{this.store.run("UPDATE control_push_deliveries SET status='delivered',last_status=201 WHERE event_id=? AND device_id=?",row.event_id,row.device_id);this.rememberDelivery(row,'delivered',201);});
        }catch(error){
          if(this.closed)break;const status=Number(error.statusCode)||0;
          if([404,410].includes(status))this.store.transaction(()=>this.forgetDevice(row.device_id,'provider_expired',status));
          else {const permanent=(status>=300&&status<400)||[400,413].includes(status)||row.attempts>=11;
            const retry=/^\d+$/.test(String(error.retryAfter||''))?Math.min(3600_000,Number(error.retryAfter)*1000):0;
            this.store.transaction(()=>{this.store.run('UPDATE control_push_deliveries SET status=?,attempts=attempts+1,last_status=?,next_attempt_at=? WHERE event_id=? AND device_id=?',permanent?'failed':'pending',status,this.now()+Math.max(retry,Math.min(3600_000,15000*2**Math.min(8,row.attempts))),row.event_id,row.device_id);this.rememberDelivery(row,permanent?'failed':'pending',status,row.attempts+1);});}
        }finally{this.aborter=null;}
      }
    }finally{this.running=false;if(!this.closed)this.schedule(5000);}
  }
}
