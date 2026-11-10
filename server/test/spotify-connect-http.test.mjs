import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createHttpServer} from '../src/http.mjs';

test('real HTTP serves the Spotify connection page and allowlisted module/styles with exact bytes',async t=>{
  const server=createHttpServer({config:{},now:Date.now},{rateLimits:false});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  for(const [route,file,type] of [
    ['/media-player.html','media-player.html','text/html; charset=utf-8'],
    ['/assets/spotify-connect.js','assets/spotify-connect.js','text/javascript; charset=utf-8'],
    ['/assets/spotify-connect.css','assets/spotify-connect.css','text/css; charset=utf-8'],
  ]){
    const response=await fetch(base+route),bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200,route);assert.equal(response.headers.get('content-type'),type);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(bytes,fs.readFileSync(new URL('../public/showcase/'+file,import.meta.url)),route);
    const head=await fetch(base+route,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.text()).length,0);
  }
  const missing=await fetch(base+'/assets/spotify-connect-private.json');assert.equal(missing.status,404);
});
