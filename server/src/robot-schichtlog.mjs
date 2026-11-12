import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { renderLoginPage, renderRobotPage, robotCss, robotJs } from './robot-schichtlog-ui.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX = 40 * 1024 * 1024;
const ROOT = '/robot-schichtlog';
const API = '/api/robot-schichtlog/photos';
const stores = new WeakMap();
const hash = input => createHash('sha256').update(input).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { status: code, robotError: true }); };
const KEY_AS_LABEL=/^[A-Za-z0-9_-]{43}$/;
export const robotDeviceLabel=value=>KEY_AS_LABEL.test(String(value).trim())?'Handy · Gerätenamen prüfen':value;
// SQLite's default trim only removes ASCII spaces; order data uses JS trim.
export const photoIdentifier=column=>'trim('+column+',char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))';

function privateDir(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  if (!fs.lstatSync(directory).isDirectory()) fail(503, 'Privater Bildspeicher nicht verfügbar.');
  return directory;
}
function tokenInput(req) {
  return /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
}
function decodeField(value, optional) {
  if ((value === undefined || value === '') && optional) return '';
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'Ungültige Artikel- oder Auftragsnummer.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || bytes.length > 256) fail(400, 'Ungültige Artikel- oder Auftragsnummer.');
  let result;
  try { result = new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { fail(400, 'Ungültige Zeichenkodierung.'); }
  if (!result.trim() || /[\p{Cc}]/u.test(result)) fail(400, 'Ungültige Artikel- oder Auftragsnummer.');
  return result;
}
function segment(input) {
  if (!input) return '(ohne Artikel)';
  if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,75}$/.test(input) && !input.endsWith('.') && !/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(input)) return input;
  return (input.replace(/[^A-Za-z0-9_.-]+/g,'_').replace(/^[.]+/,'').slice(0,48) || 'Wert') + '~' + hash(input).slice(0,24);
}
function metadata(req) {
  const h=req.headers, id=h['x-photo-id'], day=h['x-photo-day'], sha=h['x-photo-sha256'];
  if (typeof id !== 'string' || !UUID.test(id) || typeof sha !== 'string' || !SHA.test(sha)) fail(400,'Foto-ID oder Prüfsumme ungültig.');
  if (typeof day !== 'string' || !DAY.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day) fail(400,'Ungültiges Fotodatum.');
  return { id, day, sha, article:decodeField(h['x-photo-article'],true), orderNo:decodeField(h['x-photo-order'],false) };
}
function imageType(b) {
  if (b.length>=24 && b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && b.toString('ascii',12,16)==='IHDR') return ['png','image/png'];
  if (b.length>=4 && b[0]===255 && b[1]===216 && b[2]===255) return ['jpg','image/jpeg'];
  if (b.length>=12 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP') return ['webp','image/webp'];
  if (['GIF89a','GIF87a'].includes(b.toString('ascii',0,6))) return ['gif','image/gif'];
  if (b.length>=26 && b.toString('ascii',0,2)==='BM') return ['bmp','image/bmp'];
  if (b.length>=16 && b.toString('ascii',4,8)==='ftyp') {
    const boxEnd=Math.min(b.readUInt32BE(0),b.length), brands=[b.toString('ascii',8,12)];
    for(let i=16;i+4<=boxEnd;i+=4) brands.push(b.toString('ascii',i,i+4));
    if (brands.some(x=>['avif','avis'].includes(x))) return ['avif','image/avif'];
    if (brands.some(x=>['heic','heix','hevc','hevx'].includes(x))) return ['heic','image/heic'];
    if (brands.some(x=>['mif1','msf1'].includes(x))) return ['heif','image/heif'];
  }
  fail(415,'Dieses Bildformat wird nicht unterstützt.');
}

async function inspectFile(file) {
  const digest = createHash('sha256'); let bytes=0, head=Buffer.alloc(0);
  const flags=fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  for await (const piece of fs.createReadStream(file,{flags})) {
    if (head.length<256) head=Buffer.concat([head,piece.subarray(0,256-head.length)]);
    bytes+=piece.length; if(bytes>MAX) fail(413,'Foto zu groß.');
    digest.update(piece);
  }
  return { sha:digest.digest('hex'), bytes, type:imageType(head) };
}

function fsyncDir(directory) {
  // The production image runs on Linux; Windows lacks directory handles for fsync.
  if(process.platform==='win32') return;
  const fd=fs.openSync(directory,'r'); try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function openStore(service) {
  if (stores.has(service)) return stores.get(service);
  const base=service.config.dataDir;
  if (!base || !fs.lstatSync(base).isDirectory()) fail(503,'Privater Datenträger nicht verfügbar.');
  const directory=privateDir(path.join(base,'robot-schichtlog'));
  const incoming=privateDir(path.join(directory,'.incoming'));
  const photos=privateDir(path.join(directory,'Fotos'));
  const database=path.join(directory,'index.sqlite');
  const db=new DatabaseSync(database); fs.chmodSync(database,0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;" +
    "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, label TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, revoked INTEGER);" +
    "CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, day TEXT NOT NULL, article TEXT NOT NULL, order_no TEXT NOT NULL, sha TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL, file TEXT NOT NULL UNIQUE, ready INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);" +
    "CREATE INDEX IF NOT EXISTS photos_by_day ON photos(ready,day DESC,created DESC,id);");
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'can_read')) {
      db.exec('ALTER TABLE devices ADD COLUMN can_read INTEGER NOT NULL DEFAULT 0 CHECK(can_read IN (0,1))');
    }
    db.exec('CREATE INDEX IF NOT EXISTS photos_by_order ON photos(order_no,article,ready,day DESC,created DESC,id DESC)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK'); db.close(); throw error;
  }
  // Abandoned request buffers can only exist after process exit. Allow other instances time to finish.
  for(const item of fs.readdirSync(incoming,{withFileTypes:true})){
    const location=path.join(incoming,item.name);
    if(item.isFile() && UUID.test(item.name) && Date.now()-fs.statSync(location).mtimeMs > 24*3600000) fs.rmSync(location,{force:true});
  }
  const store={directory,incoming,photos,db,active:0,downloads:new Map()};
  stores.set(service,store); return store;
}
function browserOwner(service,req,mutation) {
  if (!service.accounts || !service.accounts.suiteLicense) fail(503,'Betreiberkonto nicht verfügbar.');
  if(req.headers.authorization) fail(403,'Bitte das Betreiberkonto im Browser verwenden.');
  return service.accounts.authenticateRequest(req,{mutation,requireAdmin:true}).then(context=>{
    if(context.session.kind!=='browser') fail(403,'Browseranmeldung erforderlich.');
    if(mutation && req.headers.origin !== service.config.publicOrigin) fail(403,'Ungültiger Ursprung.');
    const user=service.accounts.suiteLicense.requireOperator(context); return {user,context};
  });
}
export function checkDevice(service,store,token) {
  if(!token) fail(401,'Geräteschlüssel erforderlich.');
  const device=store.db.prepare('SELECT * FROM devices WHERE hash=? AND revoked IS NULL').get(hash(token));
  if(!device) fail(401,'Geräteschlüssel ungültig oder widerrufen.');
  // Ownership transfer or suspension also disables keys created by the previous owner.
  const owner=service.accounts?.suiteLicense?.operator();
  if(!owner || owner!==device.owner) fail(403,'Geräteschlüssel nicht freigegeben.');
  return device;
}
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function jsonFields(req){
  if((req.headers['content-type']||'').split(';')[0].trim()!=='application/json') fail(415,'JSON erforderlich.');
  const chunks=[]; let size=0;for await(const b of req){size+=b.length;if(size>2048)fail(413,'Eingabe zu groß.');chunks.push(b);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail(400,'Ungültige Eingabe.');}
}
async function upload(service,store,req,res){
  const token=tokenInput(req), device=checkDevice(service,store,token);
  if(req.method==='HEAD'){res.writeHead(204,{'X-Schichtlog-Paired':'1','X-Schichtlog-Photo-Read':String(device.can_read)});res.end();return;}
  if(req.method!=='POST') fail(405,'Diese Methode ist nicht vorgesehen.');
  const m=metadata(req); const stated=Number(req.headers['content-length']);
  if(stated>MAX) fail(413,'Fotos dürfen höchstens 40 MiB groß sein.');
  if(store.active>=4) fail(429,'Weitere Uploads laufen. Bitte erneut versuchen.');
  store.active++; const temporary=path.join(store.incoming,randomUUID()); let created;
  try{
    let count=0;
    const guard=new Transform({transform(data,_,next){count+=data.length;
      if(count>MAX)return next(Object.assign(new Error('Foto zu groß.'),{status:413,robotError:true}));next(null,data);}});
    await pipeline(req,guard,fs.createWriteStream(temporary,{flags:'wx',mode:0o600}));
    const file=await fs.promises.open(temporary,'r+');try{await file.sync();}finally{await file.close();}
    const checked=await inspectFile(temporary);
    if(!count || checked.bytes!==count || checked.sha!==m.sha) fail(422,'Prüfsumme stimmt nicht mit den Bilddaten überein.');
    const [ext,mime]=checked.type;
    const given=(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(given && given!=='application/octet-stream' && given!=='image/*' && given!==mime && !(given==='image/heif'&&mime==='image/heic') && !(given==='image/heic'&&mime==='image/heif') && !(given==='image/jpg'&&mime==='image/jpeg')) fail(415,'Bilddaten und Dateityp passen nicht zusammen.');
    checkDevice(service,store,token);
    const relative=[m.day,segment(m.article),segment(m.orderNo),m.id+'.'+ext].join('/');
    const inserted=store.db.prepare('INSERT INTO photos(id,day,article,order_no,sha,bytes,mime,file,created) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(m.id,m.day,m.article,m.orderNo,m.sha,count,mime,relative,Date.now()).changes;
    const previous=store.db.prepare('SELECT * FROM photos WHERE id=?').get(m.id);
    if(previous.sha!==m.sha || previous.day!==m.day || previous.article!==m.article || previous.order_no!==m.orderNo || previous.file!==relative || previous.bytes!==count) fail(409,'Diese Foto-ID gehört zu anderen Daten.');
    let dir=store.photos;
    for(const part of relative.split('/').slice(0,3)){ const parent=dir; dir=privateDir(path.join(parent,part)); fsyncDir(parent); }
    const dest=path.join(store.photos,relative);
    try{fs.linkSync(temporary,dest);fsyncDir(dir);}
    catch(err){
      if(err.code!=='EEXIST') throw err;
      const existing=await inspectFile(dest);if(existing.sha!==m.sha || existing.bytes!==count) fail(503,'Die gespeicherte Datei konnte nicht bestätigt werden.');
    }
    checkDevice(service,store,token);
    store.db.prepare('UPDATE photos SET ready=1 WHERE id=?').run(m.id);
    created=Boolean(inserted);
  }finally{store.active--;await fs.promises.rm(temporary,{force:true}).catch(()=>{});}
  json(res,created?201:200,{id:m.id,sha256:m.sha});
}
async function sendFile(req,res,filename,mime,name,options={}){
  let f;try{f=await fs.promises.open(filename,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));}
  catch(err){if(err.code==='ENOENT')fail(404,'Datei noch nicht verfügbar.');throw err;}
  try{
    const stat=await f.stat();if(!stat.isFile()) fail(404,'Datei nicht verfügbar.');
    options.authorize?.();
    if(options.size !== undefined && stat.size !== options.size) fail(503,'Gespeicherte Dateigröße stimmt nicht überein.');
    const headers={'Content-Type':mime,'Content-Length':stat.size};
    if(options.sha) headers['X-Photo-SHA256']=options.sha;
    if(name)headers['Content-Disposition']='attachment; filename="'+name+'"';
    res.writeHead(200,headers);
    if(req.method==='HEAD')res.end();else await pipeline(f.createReadStream(),res,{signal:options.signal});
  }finally{await f.close();}
}

function abortDeviceReads(store,deviceId) {
  for (const controller of store.downloads.get(deviceId) || []) controller.abort();
}
function readableDevice(service,store,token) {
  const device=checkDevice(service,store,token);
  if (!device.can_read) fail(403,'Die Bildansicht ist für dieses Handy nicht freigegeben.');
  return device;
}
async function readOrderPhotos(service,store,req,res,url,photoId) {
  const token=tokenInput(req), device=readableDevice(service,store,token);
  if(typeof req.headers['x-photo-article'] !== 'string') fail(400,'Artikelnummer muss ausdrücklich angegeben werden.');
  const article=decodeField(req.headers['x-photo-article'],true), order=decodeField(req.headers['x-photo-order'],false);
  if(req.method !== 'GET') fail(405,'Diese Adresse unterstützt nur den Fotoabruf.');
  res.setHeader('Vary','Authorization, X-Photo-Order, X-Photo-Article');
  const scoped='ready=1 AND '+photoIdentifier('order_no')+'=? AND '+photoIdentifier('article')+'=?', args=[order.trim(),article.trim()];
  if (photoId) {
    const photo=store.db.prepare('SELECT file,bytes,sha,mime FROM photos WHERE '+scoped+' AND id=?').get(...args,photoId);
    if(!photo) fail(404,'Foto nicht gefunden.');
    const controller=new AbortController();
    const running=store.downloads.get(device.id) || new Set();
    running.add(controller);store.downloads.set(device.id,running);
    try {
      await sendFile(req,res,path.join(store.photos,photo.file),photo.mime,null,{
        authorize:()=>readableDevice(service,store,token),signal:controller.signal,sha:photo.sha,size:photo.bytes
      });
    } finally {
      running.delete(controller); if(!running.size) store.downloads.delete(device.id);
    }
    return;
  }
  let condition='';
  if(url.searchParams.has('cursor')){
    const encoded=url.searchParams.get('cursor');
    if(!/^[A-Za-z0-9_-]{48}$/.test(encoded)) fail(400,'Ungültige Foto-Folgeseite.');
    const cursor=Buffer.from(encoded,'base64url').toString('ascii');
    if(!UUID.test(cursor) || Buffer.from(cursor).toString('base64url')!==encoded) fail(400,'Ungültige Foto-Folgeseite.');
    const prior=store.db.prepare('SELECT day,created,id FROM photos WHERE '+scoped+' AND id=?').get(...args,cursor);
    if(!prior) fail(400,'Ungültige Foto-Folgeseite.');
    condition=' AND (day,created,id)<(?,?,?)';args.push(prior.day,prior.created,prior.id);
  }
  const rows=store.db.prepare('SELECT id,sha AS sha256,bytes AS size,mime,day FROM photos WHERE '+scoped+condition+
    ' ORDER BY day DESC,created DESC,id DESC LIMIT 33').all(...args);
  const photos=rows.slice(0,32);
  json(res,200,{photos,nextCursor:rows.length>32?Buffer.from(photos[31].id).toString('base64url'):null});
}

export async function handleRobotSchichtlog(service,req,res,url,apkFile='/app/private/robot-schichtlog/app.apk') {
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Vary','Cookie, Authorization');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  try {
    if(url.pathname===API){
      const store=openStore(service);
      if(req.method==='GET') await readOrderPhotos(service,store,req,res,url,null);
      else await upload(service,store,req,res);
      return;
    }
    const appPhoto=/^\/api\/robot-schichtlog\/photos\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(appPhoto && UUID.test(appPhoto[1])){await readOrderPhotos(service,openStore(service),req,res,url,appPhoto[1]);return;}
    if(url.pathname.startsWith('/api/'))fail(404,'Unbekannte Adresse.');
    const mutation=!['GET','HEAD'].includes(req.method);
    const {user,context}=await browserOwner(service,req,mutation);
    const recheck=()=>service.accounts.suiteLicense.requireOperator(context);
    if(['/robot-schichtlog/style.css','/robot-schichtlog/app.js'].includes(url.pathname) && ['GET','HEAD'].includes(req.method)){
      const css=url.pathname.endsWith('.css');
      res.writeHead(200,{'Content-Type':css?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});
      res.end(req.method==='HEAD'?undefined:css?robotCss:robotJs);return;
    }
    const store=openStore(service), db=store.db;
    if((url.pathname===ROOT || url.pathname===ROOT+'/') && req.method==='GET'){
      const page=Math.max(0,Math.min(1000000,Number(url.searchParams.get('page'))||0))|0;
      const devices=db.prepare('SELECT id,label,created,revoked,can_read FROM devices WHERE owner=? ORDER BY (revoked IS NULL) DESC,created DESC LIMIT 100').all(user.id).map(device=>({...device,label:robotDeviceLabel(device.label)}));
      const filters={day:url.searchParams.get('day')||'',article:url.searchParams.get('article')||'',order:url.searchParams.get('order')||''};
      if(filters.day && !DAY.test(filters.day)) fail(400,'Ungültiges Datum.');
      const columns={day:'day',article:'article',order:'order_no'}, where=['ready=1'], values=[];
      for(const [key,value] of Object.entries(filters)){
        if(value.length>256) fail(400,'Suchbegriff zu lang.');
        if(value){where.push(columns[key]+'=?');values.push(value);}
      }
      const photos=db.prepare('SELECT id,day,article,order_no,bytes FROM photos WHERE '+where.join(' AND ')+' ORDER BY day DESC,created DESC,id DESC LIMIT 41 OFFSET ?').all(...values,page*40);
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(renderRobotPage({devices,photos,page,csrf:context.csrfToken,filters}));return;
    }
    if(url.pathname===ROOT+'/devices' && req.method==='POST'){
      const body=await jsonFields(req); recheck();
      const label=typeof body?.label==='string' ? body.label.trim() : '';
      if(!label || label.length>80 || /[\p{Cc}]/u.test(label)) fail(400,'Bitte einen Gerätenamen mit höchstens 80 Zeichen eingeben.');
      if(KEY_AS_LABEL.test(label))fail(400,'Als Gerätenamen bitte z. B. „Mein Handy“ eingeben, keinen Geräteschlüssel.');
      if(body.canRead!==undefined && typeof body.canRead!=='boolean') fail(400,'Ungültige Bildfreigabe.');
      if(db.prepare('SELECT COUNT(*) AS num FROM devices WHERE owner=? AND revoked IS NULL').get(user.id).num>=50) fail(429,'Höchstens 50 aktive Geräte.');
      const key=randomBytes(32).toString('base64url'), id=randomUUID();
      const canRead=body.canRead===true;
      db.prepare('INSERT INTO devices(id,owner,label,hash,created,can_read) VALUES(?,?,?,?,?,?)').run(id,user.id,label,hash(key),Date.now(),Number(canRead));
      json(res,201,{id,token:key,canRead});return;
    }
    const device=/^\/robot-schichtlog\/devices\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(device && req.method==='PATCH'){
      const body=await jsonFields(req);recheck();
      if(typeof body?.canRead!=='boolean') fail(400,'Ungültige Bildfreigabe.');
      const changed=db.prepare('UPDATE devices SET can_read=? WHERE id=? AND owner=? AND revoked IS NULL')
        .run(Number(body.canRead),device[1],user.id);
      if(!changed.changes)fail(404,'Aktives Gerät nicht gefunden.');
      if(!body.canRead)abortDeviceReads(store,device[1]);
      json(res,200,{id:device[1],canRead:body.canRead});return;
    }
    if(device && req.method==='DELETE'){
      recheck(); const result=db.prepare('UPDATE devices SET revoked=COALESCE(revoked,?) WHERE id=? AND owner=?').run(Date.now(),device[1],user.id);
      if(!result.changes)fail(404,'Gerät nicht gefunden.');
      abortDeviceReads(store,device[1]);json(res,200,{revoked:true});return;
    }
    if(url.pathname===ROOT+'/app.apk' && ['GET','HEAD'].includes(req.method)){
      await sendFile(req,res,apkFile,'application/vnd.android.package-archive','Robot-SchichtLog.apk');return;
    }
    const photo=/^\/robot-schichtlog\/photos\/([a-f0-9-]{36})$/.exec(url.pathname);
    if(photo && ['GET','HEAD'].includes(req.method)){
      const row=db.prepare('SELECT file,mime FROM photos WHERE id=? AND ready=1').get(photo[1]);if(!row)fail(404,'Foto nicht gefunden.');
      await sendFile(req,res,path.join(store.photos,row.file),row.mime,url.searchParams.has('download')?path.basename(row.file):null);return;
    }
    fail(404,'Unbekannte Adresse.');
  }catch(err){
    if(res.destroyed||res.writableEnded)return;
    if(res.headersSent){res.destroy();return;}
    const status=Number(err.status)||503;
    if(status===401 && req.method==='GET' && [ROOT,ROOT+'/'].includes(url.pathname)){
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      res.writeHead(401,{'Content-Type':'text/html; charset=utf-8'});res.end(renderLoginPage());return;
    }
    json(res,status,{error:err.robotError?err.message:status===401?'Anmeldung erforderlich.':status===403?'Zugriff verweigert.':'Bildspeicher momentan nicht verfügbar.'});
  }
}

