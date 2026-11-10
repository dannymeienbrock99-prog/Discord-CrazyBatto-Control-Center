import crypto from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { Vault, sha256 } from './store.mjs';
import { pushSubscription, pushEndpoint, sendPush } from './chat-push.mjs';

const TYPES = new Set(['member_registered','pc_ticket','pc_order','robot_order','test']);
const TEXT = { member_registered:'Eine neue Website-Registrierung wartet auf dich.', pc_ticket:'Eine neue PC-Problemmeldung ist eingegangen.', pc_order:'Eine PC-Auftragsanfrage wartet auf deine Entscheidung.', robot_order:'Ein Robot-SchichtLog-Eintrag wurde synchronisiert.', test:'Benachrichtigungen für dein Control Center sind eingeschaltet.' };
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
      CREATE TABLE IF NOT EXISTS control_push_deliveries(event_id TEXT NOT NULL REFERENCES control_notice_events(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES control_push_devices(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_status INTEGER,PRIMARY KEY(event_id,device_id));
      CREATE INDEX IF NOT EXISTS control_push_due ON control_push_deliveries(status,next_attempt_at);`);
    if(autoStart)this.schedule(5000);
  }
  close(){this.closed=true;clearTimeout(this.timer);this.aborter?.abort();}
  operator(context){return this.accounts.suiteLicense.requireOperator(context);}
  currentOperator(){try{return this.accounts.suiteLicense.operator();}catch{return null;}}
  keys(){return this.accounts.community.push.keys();}
  status(userId){return {enabled:!!this.accounts.community?.push?.enabled,publicKey:this.keys().publicKey,registeredDevices:this.store.get('SELECT COUNT(*) AS n FROM control_push_devices WHERE user_id=?',userId).n};}
  decrypt(row){
    const raw=this.vault.open(JSON.parse(row.subscription));
    assert(raw.purpose==='control-push-v1'&&raw.id===row.id&&raw.userId===row.user_id,'Geräteanmeldung ungültig.','unconfigured',503);
    const sub=pushSubscription(raw.subscription);assert(sha256(sub.endpoint)===row.id,'Geräteanmeldung ungültig.');return sub;
  }
  register(context,input){
    const user=this.operator(context),subscription=pushSubscription(input),id=sha256(subscription.endpoint),now=this.now();
    assert(!subscription.expirationTime||subscription.expirationTime>now,'Die Geräteanmeldung ist abgelaufen.');this.keys();
    this.store.transaction(()=>{
      const old=this.store.get('SELECT * FROM control_push_devices WHERE id=?',id);
      if(old&&old.user_id!==user.id){const previous=this.decrypt(old);assert(previous.keys.auth===subscription.keys.auth&&previous.keys.p256dh===subscription.keys.p256dh,'Dieses Gerät gehört zu einer anderen Anmeldung.','conflict',409);this.store.run('DELETE FROM control_push_devices WHERE id=?',id);}
      assert(old?.user_id===user.id||this.store.get('SELECT COUNT(*) AS n FROM control_push_devices WHERE user_id=?',user.id).n<10,'Höchstens zehn Geräte sind erlaubt.','conflict',409);
      const sealed=JSON.stringify(this.vault.seal({purpose:'control-push-v1',id,userId:user.id,subscription}));
      this.store.run(`INSERT INTO control_push_devices VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,subscription=excluded.subscription,updated_at=excluded.updated_at`,id,user.id,sealed,now,now);
    });return this.status(user.id);
  }
  remove(context,endpoint){const user=this.operator(context);this.store.run('DELETE FROM control_push_devices WHERE id=? AND user_id=?',sha256(pushEndpoint(endpoint)),user.id);return {ok:true,...this.status(user.id)};}
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
    else if(route==='/api/control-mobile/push/check'&&req.method==='POST'){const value=await controlJson(req);fields(value,['endpoint']);this.operator(context);data={registered:!!this.store.get('SELECT id FROM control_push_devices WHERE id=? AND user_id=?',sha256(pushEndpoint(value.endpoint)),user.id)};}
    else if(route==='/api/control-mobile/push'&&req.method==='POST'){this.accounts.limit('control-push:'+user.id,30,3600_000);const value=await controlJson(req);fields(value,['subscription']);data=this.register(context,value.subscription);}
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
      this.store.run('DELETE FROM control_notice_events WHERE created_at<?',now-MAX_AGE);
      if(!owner)return;
      this.store.run(`INSERT OR IGNORE INTO control_push_deliveries(event_id,device_id,next_attempt_at)
        SELECT e.id,d.id,? FROM (SELECT * FROM control_notice_events WHERE created_at>=? ORDER BY created_at DESC,id DESC LIMIT 1000) e
        JOIN control_push_devices d ON d.user_id=? AND e.created_at>=d.created_at`,now,now-MAX_AGE,owner);
      const rows=this.store.all(`SELECT q.*,e.type,e.target_id,d.user_id FROM control_push_deliveries q JOIN control_notice_events e ON e.id=q.event_id JOIN control_push_devices d ON d.id=q.device_id WHERE q.status='pending' AND q.next_attempt_at<=? ORDER BY e.created_at,e.id LIMIT 12`,now);
      for(const row of rows){
        if(this.closed)break;
        if(row.user_id!==this.currentOperator()||!TYPES.has(row.type)||!UUID.test(row.target_id)){this.store.run("UPDATE control_push_deliveries SET status='discarded' WHERE event_id=? AND device_id=?",row.event_id,row.device_id);continue;}
        const device=this.store.get('SELECT * FROM control_push_devices WHERE id=? AND user_id=?',row.device_id,row.user_id);if(!device)continue;
        try{
          const sub=this.decrypt(device);if(sub.expirationTime&&sub.expirationTime<=this.now()){this.store.run('DELETE FROM control_push_devices WHERE id=?',device.id);continue;}
          const section=row.type==='member_registered'?'members':row.type==='robot_order'?'robot':'support';
          const payload=JSON.stringify({kind:'control-center',eventId:row.event_id,recipientId:row.user_id,title:'Crazy_Batto · Control Center',body:TEXT[row.type],url:'/control-center/?view='+section,tag:'cb-control-'+row.type+'-'+row.target_id});
          this.aborter=new AbortController();
          await this.transport(sub,payload,{vapidDetails:{subject:new URL('/kontakt.html',this.accounts.config.publicOrigin).href,...this.keys()},TTL:86400,urgency:'high',contentEncoding:'aes128gcm',topic:sha256(row.event_id).slice(0,32)},this.aborter.signal);
          if(!this.closed)this.store.run("UPDATE control_push_deliveries SET status='delivered',last_status=201 WHERE event_id=? AND device_id=?",row.event_id,row.device_id);
        }catch(error){
          if(this.closed)break;const status=Number(error.statusCode)||0;
          if([404,410].includes(status))this.store.run('DELETE FROM control_push_devices WHERE id=?',row.device_id);
          else {const permanent=(status>=300&&status<400)||[400,413].includes(status)||row.attempts>=11;
            const retry=/^\d+$/.test(String(error.retryAfter||''))?Math.min(3600_000,Number(error.retryAfter)*1000):0;
            this.store.run('UPDATE control_push_deliveries SET status=?,attempts=attempts+1,last_status=?,next_attempt_at=? WHERE event_id=? AND device_id=?',permanent?'failed':'pending',status,this.now()+Math.max(retry,Math.min(3600_000,15000*2**Math.min(8,row.attempts))),row.event_id,row.device_id);}
        }finally{this.aborter=null;}
      }
    }finally{this.running=false;if(!this.closed)this.schedule(5000);}
  }
}
