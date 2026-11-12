import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {handleRobotOrders,robotOrderTesting} from '../src/robot-orders.mjs';
import {handleRobotSchichtlog} from '../src/robot-schichtlog.mjs';

const sample=()=>({robot:1,orderNumber:'A-100',articleNumber:'Artikel',programInfo:'P2',missingParts:'',quantity:4,timestamp:1790000000000,shift:'Früh',eventType:'Kein Ereignis',important:false,note:'Notiz',handoverNote:'',startedAt:0,endedAt:0,source:'Eintrag',personnelNumber:'0007'});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-orders-')),owner=randomUUID(),token=randomBytes(32).toString('base64url'),device=randomUUID();let allowed=true;
 const accountDb=new DatabaseSync(':memory:');const service={config:{dataDir:dir,publicOrigin:'https://crazybatto.de'},accounts:{store:{db:accountDb,run:(sql,...args)=>accountDb.prepare(sql).run(...args)},authenticateRequest:async(req)=>{if(req.headers.authorization!=='Bearer admin'||!allowed)throw Object.assign(new Error(),{status:401});return {user:{id:owner}};},assertCurrent(){if(!allowed)throw Object.assign(new Error(),{status:401});},suiteLicense:{requireOperator:()=>{if(!allowed)throw Object.assign(new Error(),{status:403});return{id:owner};},operator:()=>owner}}};
 const store=robotOrderTesting.storeFor(service),db=store.db;
 db.prepare('INSERT INTO devices(id,owner,label,hash,created) VALUES(?,?,?,?,?)').run(device,owner,'Test-Handy',createHash('sha256').update(token).digest('hex'),Date.now());
 t.after(()=>{db.close();accountDb.close();const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^robot-orders-/);fs.rmSync(resolved,{recursive:true,force:true});});
 async function req(method,route,payload,auth='admin'){
   const request=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);request.method=method;request.headers={authorization:'Bearer '+(auth==='device'?token:auth),'content-type':'application/json'};
   let result={};const response={headersSent:false,setHeader(){},writeHead(status,headers){this.headersSent=true;result.status=status;result.headers=headers;},end(bytes){result.body=bytes===undefined?null:result.headers?.['Content-Type']?.startsWith('image/')?bytes:JSON.parse(String(bytes));},destroy(){throw Error('Unexpected destroy');}};
   await handleRobotOrders(service,request,response,new URL(route,'https://crazybatto.de'));return result;
 }
 const change=(overrides={})=>({id:randomUUID(),mutationId:randomUUID(),baseRevision:0,deleted:false,data:sample(),...overrides});
 const sync=changes=>req('POST','/api/robot-schichtlog/orders/sync',{protocol:1,cursor:0,changes},'device');
 const grant=()=>req('PATCH','/api/admin/robot/devices/'+device,{canSync:true});
 async function photoUpload(id,image,order,article){
   const request=Readable.from([image]);request.method='POST';request.headers={authorization:'Bearer '+token,'content-type':'image/png','content-length':String(image.length),'x-photo-id':id,'x-photo-day':'2026-11-12','x-photo-sha256':createHash('sha256').update(image).digest('hex'),'x-photo-order':Buffer.from(order).toString('base64url'),'x-photo-article':Buffer.from(article).toString('base64url')};
   const result={};const response={headersSent:false,setHeader(){},writeHead(status){this.headersSent=true;result.status=status;},end(bytes){result.body=bytes?JSON.parse(String(bytes)):null;},destroy(){throw Error('Unexpected destroy');}};
   await handleRobotSchichtlog(service,request,response,new URL('https://crazybatto.de/api/robot-schichtlog/photos'));return result;
 }
 return {db,accountDb,service,store,owner,device,req,sync,change,grant,photoUpload,revoke:()=>{allowed=false;}};
}
test('existing photo devices cannot silently sync; explicit operator grant is required',async t=>{
 const f=fixture(t),entry=f.change();assert.equal((await f.sync([entry])).status,403);assert.equal((await f.req('GET','/api/admin/robot/orders',undefined,'stranger')).status,401);
 assert.equal((await f.grant()).body.device.canSync,true);assert.equal((await f.sync([entry])).status,200);assert.equal((await f.req('GET','/api/admin/robot/orders')).body.total,1);
 await f.req('PATCH','/api/admin/robot/devices/'+f.device,{canSync:false});assert.equal((await f.sync([])).status,403);
});
test('mutation replay returns same revision and payload reuse cannot overwrite data',async t=>{
 const f=fixture(t);await f.grant();const change=f.change();const first=await f.sync([change]),again=await f.sync([change]);
 assert.equal(first.body.accepted[0].order.revision,1);assert.deepEqual(again.body.accepted,first.body.accepted);
 assert.equal((await f.sync([{...change,data:{...change.data,note:'different'}}])).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM robot_order_changes').get().n,1);
 assert.equal(f.accountDb.prepare('SELECT COUNT(*) n FROM control_notice_events').get().n,1);
});
test('admin revisions, reversible deletion, restoration and device pull preserve data',async t=>{
 const f=fixture(t);await f.grant();const change=f.change();await f.sync([change]);const endpoint='/api/admin/robot/orders/'+change.id;
 let result=await f.req('PATCH',endpoint,{expectedRevision:1,changes:{note:'Nacharbeit',quantity:8}});assert.equal(result.body.order.revision,2);
 assert.equal((await f.req('DELETE',endpoint,{expectedRevision:1})).status,409);
 result=await f.req('DELETE',endpoint,{expectedRevision:2});assert.equal(result.body.order.deleted,true);
 assert.equal((await f.req('GET','/api/admin/robot/orders?state=deleted')).body.total,1);
 result=await f.req('POST',endpoint+'/restore',{expectedRevision:3});assert.equal(result.body.order.note,'Nacharbeit');assert.equal(result.body.order.deleted,false);
 assert.equal((await f.sync([])).body.changes[0].revision,4);
});
test('concurrent phone edits become explicit conflicts and admin resolves either exact version',async t=>{
 const f=fixture(t);await f.grant();const change=f.change();await f.sync([change]);const endpoint='/api/admin/robot/orders/'+change.id;
 await f.req('PATCH',endpoint,{expectedRevision:1,changes:{note:'Center'}});
 const phone={...change,mutationId:randomUUID(),baseRevision:1,data:{...change.data,note:'Handy'}};
 const conflict=(await f.sync([phone])).body.conflicts[0];assert.equal(conflict.order.note,'Center');
 const detail=(await f.req('GET',endpoint)).body;assert.equal(detail.conflicts[0].data.note,'Handy');
 assert.equal((await f.req('POST',endpoint+'/conflicts/'+conflict.conflictId+'/resolve',{expectedRevision:1,decision:'device'})).status,409);
 const resolved=(await f.req('POST',endpoint+'/conflicts/'+conflict.conflictId+'/resolve',{expectedRevision:2,decision:'device'})).body.order;
 assert.equal(resolved.note,'Handy');assert.ok(resolved.resolvedMutations.includes(phone.mutationId));assert.equal((await f.req('GET',endpoint)).body.conflicts.length,0);
});
test('foreign device cannot edit existing IDs; malformed batches commit nothing',async t=>{
 const f=fixture(t);await f.grant();const c=f.change();await f.sync([c]);f.db.prepare('UPDATE robot_orders SET device_id=? WHERE id=?').run(randomUUID(),c.id);
 assert.equal((await f.sync([{...c,mutationId:randomUUID(),baseRevision:1}])).status,403);
 const count=f.db.prepare('SELECT COUNT(*) n FROM robot_orders').get().n;
 assert.equal((await f.sync([f.change(),f.change({data:{...sample(),quantity:-1}})])).status,400);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM robot_orders').get().n,count);
});
test('administrator edits reject unexpected keys and unsafe field bounds',async t=>{
 const f=fixture(t);await f.grant();const c=f.change();await f.sync([c]);const endpoint='/api/admin/robot/orders/'+c.id;
 for(const changes of [{robot:0},{quantity:1.1},{personnelNumber:'x'.repeat(81)},{source:'a\0b'},{owner:'other'},{orderNumber:''}])assert.equal((await f.req('PATCH',endpoint,{expectedRevision:1,changes})).status,400);
 assert.equal((await f.req('GET','/api/admin/robot/orders?unknown=x')).status,400);
 f.revoke();assert.equal((await f.req('PATCH',endpoint,{expectedRevision:1,changes:{note:'no'}})).status,401);
});
test('photo associations survive renamed orders and private preview validates bytes',async t=>{
 const f=fixture(t);await f.grant();const c=f.change();await f.sync([c]);const photo=randomUUID(),image=Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex');
 const file=photo+'.png';fs.writeFileSync(path.join(f.store.photos,file),image);
 f.db.prepare('INSERT INTO photos(id,day,article,order_no,sha,bytes,mime,file,ready,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(photo,'2026-11-10',c.data.articleNumber,c.data.orderNumber,createHash('sha256').update(image).digest('hex'),image.length,'image/png',file,1,Date.now());
 const endpoint='/api/admin/robot/orders/'+c.id;await f.req('PATCH',endpoint,{expectedRevision:1,changes:{orderNumber:'Umbenannt'}});
 const detail=(await f.req('GET',endpoint)).body;assert.equal(detail.order.photoCount,1);assert.equal(detail.photos[0].id,photo);
 assert.equal((await f.req('GET','/api/admin/robot/photos/'+photo+'/preview')).body.mimeType,'image/png');
 fs.writeFileSync(path.join(f.store.photos,file),Buffer.alloc(image.length));assert.equal((await f.req('GET','/api/admin/robot/photos/'+photo+'/preview')).status,503);
});
test('search treats percent and underscore literally and device revocation invalidates sync',async t=>{
 const f=fixture(t);await f.grant();const c=f.change();await f.sync([c]);
 assert.equal((await f.req('GET','/api/admin/robot/orders?q=A-100')).body.total,1);
 assert.equal((await f.req('GET','/api/admin/robot/orders?q=%25')).body.total,0);
 f.db.prepare('UPDATE devices SET revoked=? WHERE id=?').run(Date.now(),f.device);assert.equal((await f.sync([])).status,401);
});

test('all photos paginate without loss and cursors cannot cross order scopes',async t=>{
 const f=fixture(t);await f.grant();const entry=f.change();await f.sync([entry]);
 const insert=f.db.prepare('INSERT INTO photos(id,day,article,order_no,sha,bytes,mime,file,ready,created) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const expected=[];for(let i=0;i<87;i++){const id=randomUUID();expected.push(id);insert.run(id,'2026-11-12',' Artikel ',' A-100 ','0'.repeat(64),24,'image/png',id+'.png',1,1000+i);}
 const unrelated=randomUUID();insert.run(unrelated,'2026-11-12','Artikel','Other','0'.repeat(64),24,'image/png',unrelated+'.png',1,1000);
 const endpoint='/api/admin/robot/orders/'+entry.id;let cursor=null;const seen=[];
 do{const response=await f.req('GET',endpoint+(cursor?'?photoCursor='+cursor:''));assert.equal(response.status,200);const detail=response.body;assert.equal(detail.order.photoCount,87);assert.equal(detail.order.revision,1);assert.ok(detail.photos.length<=40);seen.push(...detail.photos.map(p=>p.id));cursor=detail.photosNextCursor;}while(cursor);
 assert.deepEqual(seen,expected.reverse());assert.equal(new Set(seen).size,87);
 for(const suffix of ['?photoCursor='+unrelated,'?photoCursor=bad','?photoCursor=','?extra=1','?photoCursor='+seen[0]+'&photoCursor='+seen[1]])assert.equal((await f.req('GET',endpoint+suffix)).status,400);
});

test('durable real photo uploads associate before and after order sync, retry and rename',async t=>{
 const f=fixture(t),image=Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001','hex'),id=randomUUID();
 assert.equal((await f.photoUpload(id,image,'\u00a0A-100\u3000',' Artikel ')).status,201);
 assert.equal((await f.photoUpload(id,image,'\u00a0A-100\u3000',' Artikel ')).status,200);
 const entry=f.change();assert.equal((await f.sync([entry])).status,403);await f.grant();await f.sync([entry]);
 const endpoint='/api/admin/robot/orders/'+entry.id;
 assert.equal((await f.req('GET',endpoint)).body.photos[0].id,id);
 await f.req('PATCH',endpoint,{expectedRevision:1,changes:{orderNumber:'Umbenannt',articleNumber:'Neu'}});
 const second=randomUUID();assert.equal((await f.photoUpload(second,image,'Umbenannt','Neu')).status,201);
 const detail=(await f.req('GET',endpoint)).body;assert.equal(detail.order.photoCount,2);assert.equal(detail.photosNextCursor,null);
 assert.deepEqual(new Set(detail.photos.map(p=>p.id)),new Set([id,second]));
 assert.equal((await f.req('GET','/api/admin/robot/photos/'+id+'/preview')).body.dataUrl,'data:image/png;base64,'+image.toString('base64'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE ready=1').get().n,2);
});

test('device names which resemble a secret are redacted in list and order views',async t=>{
 const f=fixture(t);await f.grant();const entry=f.change();await f.sync([entry]);const synthetic='x'.repeat(43);
 f.db.prepare('UPDATE devices SET label=? WHERE id=?').run(synthetic,f.device);
 const list=(await f.req('GET','/api/admin/robot/orders')).body;assert.equal(list.devices[0].label,'Handy · Gerätenamen prüfen');assert.equal(list.orders[0].deviceLabel,'Handy · Gerätenamen prüfen');
 assert.ok(!JSON.stringify(list).includes(synthetic));assert.equal(f.db.prepare('SELECT label FROM devices WHERE id=?').get(f.device).label,synthetic);
});
