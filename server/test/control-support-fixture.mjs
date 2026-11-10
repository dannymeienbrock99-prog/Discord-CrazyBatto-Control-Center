import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {AccountStore,accountView} from '../src/account-store.mjs';
import {AppError} from '../src/errors.mjs';

// The decoder tests use a known complete 1px raster, never a network resource.
export const IMAGE=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0sAAAAASUVORK5CYII=','base64');
export function supportFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'control-support-test-')),store=new AccountStore(directory);
  const state={now:1794300000000,revoked:false,readHook:null,putHook:null,images:new Map(),reads:0,puts:0};
  const add=(options={})=>{const id=options.id||randomUUID();store.run('INSERT INTO accounts(id,email,name,confirmed,is_admin,suspended,created_at) VALUES (?,?,?,?,?,?,?)',id,options.email||id+'@fixture.test',options.name||'Fixture Member',options.confirmed===false?0:1,options.admin?1:0,options.suspended?1:0,options.createdAt??state.now);return{user:{id}};};
  const admin=add({admin:true,name:'Fixture Admin'}),user=add({name:'Alice'}),other=add({name:'Bob'});
  let queue=Promise.resolve();
  const accounts={store,now:()=>state.now,limit(){},gallery:{exclusive(fn){const task=queue.then(fn,fn);queue=task.catch(()=>{});return task;}},
    imageStorage:{async put(id,bytes,meta){state.puts++;await state.putHook?.();state.images.set(id,{bytes,meta});},async read(id){state.reads++;await state.readHook?.();const item=state.images.get(id);if(!item)throw new AppError('not_found','Bild fehlt.',404);return item.bytes;}},
    assertCurrent(context,{admin:requireAdmin=false}={}){const row=store.get('SELECT * FROM accounts WHERE id=?',context?.user?.id||'');if(state.revoked||!row?.confirmed||row.suspended)throw new AppError('auth','Keine gültige Anmeldung.',401);if(requireAdmin&&!row.is_admin)throw new AppError('forbidden','Keine Administratorfreigabe.',403);return accountView(row);},
    async authenticateRequest(req,{mutation=false,requireAdmin=false}={}){if(!req.headers.authorization)throw new AppError('auth','Bitte anmelden.',401);const context={user:{id:req.headers.authorization}};this.assertCurrent(context,{admin:requireAdmin});if(mutation&&req.headers['x-csrf-token']!=='valid')throw new AppError('csrf','Seitenschutz fehlt.',403);return context;},
    authorizeAdmin(req){return this.authenticateRequest(req,{mutation:!['GET','HEAD'].includes(req.method),requireAdmin:true});}
  };
  const service={accounts,config:{publicOrigin:'https://crazybatto.test'}};
  t.after(()=>{store.close();const full=path.resolve(directory);assert(full.startsWith(path.resolve(os.tmpdir())+path.sep+'control-support-test-'));fs.rmSync(full,{recursive:true,force:true});});
  return{accounts,service,store,state,admin,user,other,add};
}
export function imageRequest(bytes=IMAGE,overrides={}) {const req=Readable.from([bytes]);req.headers={'content-type':'image/png','content-length':String(bytes.length),'x-file-name':'problem.png',...overrides};return req;}
export async function httpCall(module,route,{method='GET',body,user,csrf='valid'}={}) {
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body)),req=Readable.from(bytes?[bytes]:[]);
  Object.assign(req,{url:route,method,headers:{...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{}),...(user?{authorization:user.user.id}:{}),'x-csrf-token':csrf},socket:{remoteAddress:'fixture'}});
  const res={status:0,writeHead(status,headers){this.status=status;this.headers=headers;},end(value){this.raw=value;this.body=this.headers['Content-Type'].startsWith('application/json')?JSON.parse(value):value;}};
  res.handled=await module.handle(req,res);return res;
}
