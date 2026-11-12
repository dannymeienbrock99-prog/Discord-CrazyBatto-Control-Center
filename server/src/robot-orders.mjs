import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openStore, checkDevice, robotDeviceLabel, photoIdentifier } from './robot-schichtlog.mjs';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_BODY=256*1024, MAX_IMAGE=8*1024*1024;
const initialized=new WeakSet();
// Retain historical raw metadata for idempotent upload retries, but compare the
// same trimmed identifiers used by order edits (including existing photo rows).
const photoMatch='p.ready=1 AND EXISTS(SELECT 1 FROM robot_order_photo_keys k WHERE k.order_id=? AND k.order_no='+photoIdentifier('p.order_no')+' AND k.article='+photoIdentifier('p.article')+')';
const limits={orderNumber:256,articleNumber:256,programInfo:2000,missingParts:4000,shift:80,eventType:120,note:8000,handoverNote:8000,source:120,personnelNumber:80};
const numbers={robot:[1,999],quantity:[0,100000000],timestamp:[1,4102444800000],startedAt:[0,4102444800000],endedAt:[0,4102444800000]};
const fields=[...Object.keys(limits),...Object.keys(numbers),'important'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status,robotError:true});};
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed)=>{if(!plain(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail(400,'Ungültige Auftragsangaben.');};
const revision=value=>{if(!Number.isSafeInteger(value)||value<0)fail(400,'Ungültiger Änderungsstand.');return value;};
function data(input,partial=false){
  keys(input,fields);const out={};
  for(const key of fields){
    if(!Object.hasOwn(input,key)){if(partial)continue;fail(400,'Auftragsangabe fehlt: '+key);}
    const value=input[key];
    if(key==='important'){if(typeof value!=='boolean')fail(400,'Ungültige Wichtig-Markierung.');out[key]=value;}
    else if(numbers[key]){const [min,max]=numbers[key];if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,'Ungültiger Zahlenwert: '+key);out[key]=value;}
    else {if(typeof value!=='string'||value.length>limits[key]||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))fail(400,'Ungültiger Text: '+key);out[key]=value.trim();if(key==='orderNumber'&&!out[key])fail(400,'Auftragsnummer fehlt.');}
  }
  if(!partial&&out.endedAt&&out.startedAt&&out.endedAt<out.startedAt)fail(400,'Auftragsende liegt vor dem Beginn.');
  return out;
}
async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')||req.headers['content-encoding'])fail(415,'JSON erforderlich.');
  let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>MAX_BODY)fail(413,'Zu viele Auftragsdaten.');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts));}catch{fail(400,'Ungültiges JSON.');}
}
function storeFor(service){
  const store=openStore(service);if(initialized.has(store))return store;
  const db=store.db;db.exec('BEGIN IMMEDIATE');
  try{
    const columns=db.prepare('PRAGMA table_info(devices)').all();
    if(!columns.some(c=>c.name==='can_sync'))db.exec('ALTER TABLE devices ADD COLUMN can_sync INTEGER NOT NULL DEFAULT 0 CHECK(can_sync IN(0,1))');
    if(!columns.some(c=>c.name==='last_sync_at'))db.exec('ALTER TABLE devices ADD COLUMN last_sync_at INTEGER');
    db.exec(`CREATE TABLE IF NOT EXISTS robot_orders (
      id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,revision INTEGER NOT NULL,
      data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS robot_orders_owner ON robot_orders(owner,deleted,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS robot_order_photo_keys(order_id TEXT NOT NULL,order_no TEXT NOT NULL,article TEXT NOT NULL,PRIMARY KEY(order_id,order_no,article));
      INSERT OR IGNORE INTO robot_order_photo_keys(order_id,order_no,article) SELECT id,json_extract(data,'$.orderNumber'),json_extract(data,'$.articleNumber') FROM robot_orders;
      CREATE TABLE IF NOT EXISTS robot_order_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,device_id TEXT NOT NULL,order_id TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS robot_changes_device ON robot_order_changes(owner,device_id,seq);
      CREATE TABLE IF NOT EXISTS robot_order_mutations(device_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(device_id,id));
      CREATE TABLE IF NOT EXISTS robot_order_notice_outbox(order_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(order_id,revision));
      CREATE TABLE IF NOT EXISTS robot_order_conflicts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,device_id TEXT NOT NULL,mutation_id TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL,base_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,resolved_at INTEGER,UNIQUE(device_id,mutation_id));`);
    db.exec('COMMIT');initialized.add(store);return store;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
function orderView(db,row){
  if(!row)return null;const value=JSON.parse(row.data);
  return {...value,id:row.id,revision:row.revision,deleted:!!row.deleted,updatedAt:row.updated_at,
    deviceLabel:robotDeviceLabel(db.prepare('SELECT label FROM devices WHERE id=?').get(row.device_id)?.label||'Nicht mehr verbundenes Handy'),
    resolvedMutations:db.prepare('SELECT mutation_id FROM robot_order_conflicts WHERE order_id=? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 100').all(row.id).map(c=>c.mutation_id),
    photoCount:db.prepare('SELECT COUNT(*) AS n FROM photos p WHERE '+photoMatch).get(row.id).n};
}
const rowFor=(db,id,owner)=>db.prepare('SELECT * FROM robot_orders WHERE id=? AND owner=?').get(id,owner);
const deviceView=row=>({id:row.id,label:robotDeviceLabel(row.label),canSync:!!row.can_sync,revoked:row.revoked,lastSyncAt:row.last_sync_at||null});
function write(db,row,owner,deviceId,id,value,deleted,now){
  const rev=(row?.revision||0)+1;
  db.prepare(`INSERT INTO robot_orders(id,owner,device_id,revision,data,deleted,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,deleted=excluded.deleted,updated_at=excluded.updated_at`)
    .run(id,owner,deviceId,rev,JSON.stringify(value),Number(deleted),now);
  db.prepare('INSERT INTO robot_order_changes(owner,device_id,order_id,revision) VALUES(?,?,?,?)').run(owner,deviceId,id,rev);
  db.prepare('INSERT OR IGNORE INTO robot_order_photo_keys(order_id,order_no,article) VALUES(?,?,?)').run(id,value.orderNumber,value.articleNumber);
  return orderView(db,rowFor(db,id,owner));
}
function flushNotices(service,store){
  const accounts=service.accounts.store;if(!accounts?.run||!accounts?.db)return;
  accounts.db.exec('CREATE TABLE IF NOT EXISTS control_notice_events(id TEXT PRIMARY KEY,type TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(type,target_id,revision))');
  for(const row of store.db.prepare('SELECT * FROM robot_order_notice_outbox ORDER BY created_at LIMIT 100').all()){
    accounts.run('INSERT OR IGNORE INTO control_notice_events(id,type,target_id,revision,created_at) VALUES(?,?,?,?,?)','robot:'+row.order_id+':'+row.revision,'robot_order',row.order_id,row.revision,row.created_at);
    store.db.prepare('DELETE FROM robot_order_notice_outbox WHERE order_id=? AND revision=?').run(row.order_id,row.revision);
  }
}
function currentDevice(service,store,req){
  const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
  const device=checkDevice(service,store,token);if(!device.can_sync)fail(403,'Auftragssynchronisierung im Control Center für dieses Handy freigeben.');return device;
}
async function sync(service,store,req){
  const first=currentDevice(service,store,req);service.accounts.limit?.('robot-orders:'+first.id,120,60000);
  const input=await body(req);keys(input,['protocol','cursor','changes']);
  if(input.protocol!==1||!Array.isArray(input.changes)||input.changes.length>25)fail(400,'Ungültige Synchronisierung.');
  const cursor=revision(input.cursor),prepared=input.changes.map(change=>{
    keys(change,['id','baseRevision','mutationId','deleted','data']);
    if(!UUID.test(change.id)||!UUID.test(change.mutationId)||typeof change.deleted!=='boolean')fail(400,'Ungültige Änderung.');
    return {...change,baseRevision:revision(change.baseRevision),data:data(change.data)};
  });
  if(new Set(prepared.map(c=>c.id)).size!==prepared.length||new Set(prepared.map(c=>c.mutationId)).size!==prepared.length)fail(400,'Doppelte Auftragsänderung.');
  const db=store.db,accepted=[],conflicts=[];db.exec('BEGIN IMMEDIATE');
  try{
    const device=currentDevice(service,store,req);if(device.id!==first.id)fail(403,'Gerät wurde geändert.');
    for(const change of prepared){
      const digest=sha(JSON.stringify(change)),saved=db.prepare('SELECT hash,result FROM robot_order_mutations WHERE device_id=? AND id=?').get(device.id,change.mutationId);
      if(saved){if(saved.hash!==digest)fail(409,'Die Änderungskennung wurde bereits anders verwendet.');const prior=JSON.parse(saved.result);(prior.conflict?conflicts:accepted).push(prior);continue;}
      const existing=db.prepare('SELECT * FROM robot_orders WHERE id=?').get(change.id);
      if(existing&&(existing.owner!==device.owner||existing.device_id!==device.id))fail(403,'Dieser Eintrag gehört zu einem anderen Handy.');
      let result;
      if((existing?.revision||0)!==change.baseRevision){
        if(!existing)fail(409,'Der bekannte Auftrag ist nicht vorhanden.');
        const conflictId=randomUUID();db.prepare('INSERT INTO robot_order_conflicts(id,order_id,device_id,mutation_id,data,deleted,base_revision,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(conflictId,change.id,device.id,change.mutationId,JSON.stringify(change.data),Number(change.deleted),change.baseRevision,Date.now());
        result={id:change.id,mutationId:change.mutationId,conflict:true,conflictId,order:orderView(db,existing)};conflicts.push(result);
      }else{
        result={id:change.id,mutationId:change.mutationId,conflict:false,order:write(db,existing,device.owner,device.id,change.id,change.data,change.deleted,Date.now())};accepted.push(result);
        store.db.prepare('INSERT OR IGNORE INTO robot_order_notice_outbox(order_id,revision,created_at) VALUES(?,?,?)').run(change.id,result.order.revision,Date.now());
        db.prepare('UPDATE robot_order_conflicts SET resolved_at=? WHERE order_id=? AND device_id=? AND resolved_at IS NULL').run(Date.now(),change.id,device.id);
      }
      db.prepare('INSERT INTO robot_order_mutations(device_id,id,hash,result) VALUES(?,?,?,?)').run(device.id,change.mutationId,digest,JSON.stringify(result));
    }
    const events=db.prepare('SELECT seq,order_id FROM robot_order_changes WHERE owner=? AND device_id=? AND seq>? ORDER BY seq LIMIT 101').all(device.owner,device.id,cursor);
    const page=events.slice(0,100),ids=[...new Set(page.map(e=>e.order_id))];
    const changes=ids.map(id=>orderView(db,rowFor(db,id,device.owner)));
    db.prepare('UPDATE devices SET last_sync_at=? WHERE id=?').run(Date.now(),device.id);db.exec('COMMIT');
    return {protocol:1,accepted,conflicts,changes,cursor:page.at(-1)?.seq??cursor,hasMore:events.length>100};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
async function operator(service,req){
  const context=await service.accounts.authenticateRequest(req,{mutation:!['GET','HEAD'].includes(req.method),requireAdmin:true});
  const user=service.accounts.suiteLicense.requireOperator(context);
  return {user,recheck:()=>{service.accounts.assertCurrent(context);return service.accounts.suiteLicense.requireOperator(context);}};
}
async function photoBytes(store,photo,maximum){
  const file=path.resolve(store.photos,photo.file);if(!file.startsWith(path.resolve(store.photos)+path.sep))fail(404,'Foto nicht gefunden.');
  if(!/^image\/(?:png|jpeg|webp|gif|bmp|avif|heic|heif)$/.test(photo.mime))fail(415,'Bildformat wird nicht unterstützt.');
  for(let folder=path.dirname(file);;folder=path.dirname(folder)){
    const directory=await fs.lstat(folder);if(!directory.isDirectory()||directory.isSymbolicLink())fail(503,'Foto konnte nicht geprüft werden.');
    if(folder===path.resolve(store.photos))break;
  }
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==photo.bytes)fail(503,'Foto konnte nicht geprüft werden.');
  if(stat.size>maximum)fail(413,'preview_too_large');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const before=await handle.stat();if(!before.isFile()||before.size!==stat.size||before.ino!==stat.ino)fail(503,'Foto wurde während des Lesens geändert.');
    const buffer=Buffer.alloc(before.size+1);let count=0;
    while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,null);if(!read.bytesRead)break;count+=read.bytesRead;}
    const after=await handle.stat(),bytes=buffer.subarray(0,count);
    if(count!==photo.bytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||sha(bytes)!==photo.sha)fail(503,'Foto konnte nicht geprüft werden.');return bytes;
  }finally{await handle.close();}
}
function photosFor(db,order,cursor){
  const args=[order.id];let after='';
  if(cursor!==null){
    if(!UUID.test(cursor))fail(400,'Ungültige Foto-Folgeseite.');
    const prior=db.prepare('SELECT p.day,p.created,p.id FROM photos p WHERE '+photoMatch+' AND p.id=?').get(order.id,cursor);
    if(!prior)fail(400,'Ungültige Foto-Folgeseite.');
    after=' AND (p.day,p.created,p.id)<(?,?,?)';args.push(prior.day,prior.created,prior.id);
  }
  const rows=db.prepare('SELECT p.id,p.day,p.mime,p.bytes FROM photos p WHERE '+photoMatch+after+' ORDER BY p.day DESC,p.created DESC,p.id DESC LIMIT 41').all(...args);
  return {photos:rows.slice(0,40).map(p=>({...p,url:'/api/admin/robot/photos/'+p.id,browserUrl:'/robot-schichtlog/photos/'+p.id})),photosNextCursor:rows.length>40?rows[39].id:null};
}
async function admin(service,store,req,url){
  const {user,recheck}=await operator(service,req),db=store.db,route=url.pathname;
  if(route==='/api/admin/robot/orders'&&req.method==='GET'){
    if([...url.searchParams.keys()].some(k=>!['state','q','cursor'].includes(k)))fail(400,'Unbekannter Filter.');
    const state=url.searchParams.get('state')||'active',q=url.searchParams.get('q')||'',cursor=url.searchParams.get('cursor')||'';
    if(!['active','deleted'].includes(state)||q.length>256||cursor&&!UUID.test(cursor))fail(400,'Ungültiger Filter.');
    const args=[user.id,Number(state==='deleted')],where=['owner=?','deleted=?'];
    if(q){where.push("(json_extract(data,'$.orderNumber') LIKE ? ESCAPE '\\' OR json_extract(data,'$.articleNumber') LIKE ? ESCAPE '\\' OR json_extract(data,'$.note') LIKE ? ESCAPE '\\')");const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';args.push(term,term,term);}
    const total=db.prepare('SELECT COUNT(*) AS n FROM robot_orders WHERE '+where.join(' AND ')).get(...args).n;
    if(cursor){const old=rowFor(db,cursor,user.id);if(!old)fail(400,'Ungültige Folgeseite.');where.push('(updated_at,id)<(?,?)');args.push(old.updated_at,old.id);}
    const rows=db.prepare('SELECT * FROM robot_orders WHERE '+where.join(' AND ')+' ORDER BY updated_at DESC,id DESC LIMIT 51').all(...args),selected=rows.slice(0,50);
    return {orders:selected.map(r=>orderView(db,r)),nextCursor:rows.length>50?selected.at(-1).id:null,total,devices:db.prepare('SELECT * FROM devices WHERE owner=? ORDER BY created DESC LIMIT 100').all(user.id).map(deviceView),syncNotice:'Aufträge erscheinen nach Freigabe des Handys und erfolgreicher Synchronisierung mit Robot SchichtLog 1.8 oder neuer.'};
  }
  const device=/^\/api\/admin\/robot\/devices\/([a-f0-9-]{36})$/.exec(route);
  if(device&&UUID.test(device[1])&&req.method==='PATCH'){
    const input=await body(req);keys(input,['canSync']);if(typeof input.canSync!=='boolean')fail(400,'Ungültige Synchronisierungsfreigabe.');recheck();
    const result=db.prepare('UPDATE devices SET can_sync=? WHERE id=? AND owner=? AND revoked IS NULL').run(Number(input.canSync),device[1],user.id);if(!result.changes)fail(404,'Aktives Handy nicht gefunden.');
    return {device:deviceView(db.prepare('SELECT * FROM devices WHERE id=?').get(device[1]))};
  }
  const photo=/^\/api\/admin\/robot\/photos\/([a-f0-9-]{36})(\/preview)?$/.exec(route);
  if(photo&&UUID.test(photo[1])&&req.method==='GET'){
    const row=db.prepare('SELECT * FROM photos WHERE ready=1 AND id=?').get(photo[1]);if(!row)fail(404,'Foto nicht gefunden.');
    const bytes=await photoBytes(store,row,photo[2]?MAX_IMAGE:40*1024*1024);recheck();
    if(photo[2])return {mimeType:row.mime,dataUrl:'data:'+row.mime+';base64,'+bytes.toString('base64')};
    return {raw:bytes,mime:row.mime};
  }
  const resolve=/^\/api\/admin\/robot\/orders\/([a-f0-9-]{36})\/conflicts\/([a-f0-9-]{36})\/resolve$/.exec(route);
  if(resolve&&UUID.test(resolve[1])&&UUID.test(resolve[2])&&req.method==='POST'){
    const input=await body(req);keys(input,['expectedRevision','decision']);revision(input.expectedRevision);
    if(!['server','device'].includes(input.decision))fail(400,'Bitte einen Konfliktstand auswählen.');recheck();db.exec('BEGIN IMMEDIATE');
    try{
      const row=rowFor(db,resolve[1],user.id),conflict=db.prepare('SELECT * FROM robot_order_conflicts WHERE id=? AND order_id=? AND resolved_at IS NULL').get(resolve[2],resolve[1]);
      if(!row||!conflict)fail(404,'Offener Konflikt nicht gefunden.');if(row.revision!==input.expectedRevision)fail(409,'Der Eintrag wurde inzwischen geändert. Bitte neu laden.');
      db.prepare('UPDATE robot_order_conflicts SET resolved_at=? WHERE id=?').run(Date.now(),conflict.id);
      const chosen=input.decision==='device',order=write(db,row,user.id,row.device_id,row.id,JSON.parse(chosen?conflict.data:row.data),!!(chosen?conflict.deleted:row.deleted),Date.now());
      db.exec('COMMIT');return {order};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  const match=/^\/api\/admin\/robot\/orders\/([a-f0-9-]{36})(\/restore)?$/.exec(route);
  if(!match||!UUID.test(match[1]))fail(404,'Unbekannte Auftragsadresse.');
  const existing=rowFor(db,match[1],user.id);if(!existing)fail(404,'Auftragseintrag nicht gefunden.');
  if(req.method==='GET'&&!match[2]){
    if([...url.searchParams.keys()].some(k=>k!=='photoCursor')||url.searchParams.getAll('photoCursor').length>1)fail(400,'Unbekannter Foto-Filter.');
    const order=orderView(db,existing);
    return {order,...photosFor(db,order,url.searchParams.get('photoCursor')),conflicts:db.prepare('SELECT id,data,deleted,base_revision,created_at FROM robot_order_conflicts WHERE order_id=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20').all(existing.id).map(c=>({id:c.id,data:JSON.parse(c.data),deleted:!!c.deleted,baseRevision:c.base_revision,createdAt:c.created_at}))};
  }
  if(!(['PATCH','DELETE'].includes(req.method)&&!match[2]||req.method==='POST'&&match[2]))fail(405,'Diese Auftragsaktion wird nicht unterstützt.');
  const input=await body(req);keys(input,req.method==='PATCH'?['expectedRevision','changes']:['expectedRevision']);revision(input.expectedRevision);
  const value=req.method==='PATCH'?data({...JSON.parse(existing.data),...data(input.changes,true)}):JSON.parse(existing.data);recheck();
  db.exec('BEGIN IMMEDIATE');try{
    const current=rowFor(db,existing.id,user.id);if(current.revision!==input.expectedRevision)fail(409,'Der Eintrag wurde inzwischen geändert. Bitte neu laden.');
    if(req.method==='PATCH'&&current.deleted)fail(409,'Gelöschten Eintrag zuerst wiederherstellen.');
    const deleted=req.method==='DELETE'?true:match[2]?false:!!current.deleted;
    const order=write(db,current,user.id,current.device_id,current.id,value,deleted,Date.now());db.exec('COMMIT');return {order};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export async function handleRobotOrders(service,req,res,url){
  if(!url.pathname.startsWith('/api/admin/robot/')&&!url.pathname.startsWith('/api/robot-schichtlog/orders/'))return false;
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Cookie, Authorization');
  try{
    const store=storeFor(service);let result;
    if(url.pathname==='/api/robot-schichtlog/orders/sync'&&req.method==='POST')result=await sync(service,store,req);
    else if(url.pathname.startsWith('/api/admin/robot/'))result=await admin(service,store,req,url);
    else fail(404,'Unbekannte Auftragsadresse.');
    // Separate durable databases cannot commit atomically. Retain the local outbox
    // until the idempotent account notification insert succeeds, then retry next request.
    try{flushNotices(service,store);}catch{}
    if(result.raw){res.writeHead(200,{'Content-Type':result.mime,'Content-Length':result.raw.length});res.end(result.raw);}
    else{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));}
  }catch(error){if(res.headersSent){res.destroy();return true;}const status=Number(error.status)||503;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:error.robotError?error.message:status===401?'Anmeldung erforderlich.':status===403?'Zugriff verweigert.':'Auftragsverwaltung momentan nicht verfügbar.',code:error.message==='preview_too_large'?'preview_too_large':undefined}));}
  return true;
}
export const robotOrderTesting={data,storeFor,orderView};
