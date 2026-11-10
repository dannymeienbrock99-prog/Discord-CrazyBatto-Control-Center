'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {WebSocketServer}=require('ws');
const id='de.crazybatto.controlcenter',token='synthetic_pairing_token_for_protocol_fixture_123456789';
const waitFor=async(predicate,label)=>{const until=Date.now()+5000;while(!predicate()){if(Date.now()>until)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,20));}};
test('packaged runtime performs real Stream Deck registration, authenticated HTTP action, status update and reconnect',async t=>{
  const requests=[],messages=[],sockets=[];let playing=false,registrations=0,stderr='';
  const bridge=http.createServer(async(req,res)=>{
    assert.equal(req.socket.remoteAddress,'127.0.0.1');assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.headers.origin,undefined);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();requests.push({method:req.method,path:req.url,body});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/action'){assert.equal(req.method,'POST');assert.deepEqual(JSON.parse(body),{action:'spotify.toggle'});playing=!playing;res.end(JSON.stringify({ok:true,message:'Wiedergabe geändert.'}));}
    else{assert.equal(req.url,'/v1/status');assert.equal(req.method,'GET');res.end(JSON.stringify({ok:true,app:{connected:true,version:'3.6.0'},spotify:{connected:true,isPlaying:playing,track:'Fixture song',artist:'Fixture artist',volume:40,devices:[],shuffle:false,repeat:'off'},music:{connected:false,playing:false,title:'',channelName:'',volume:20},pages:[]}));}
  });
  bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  const streamdeck=new WebSocketServer({port:0,host:'127.0.0.1'});await once(streamdeck,'listening');
  streamdeck.on('connection',socket=>{sockets.push(socket);socket.on('message',raw=>{const value=JSON.parse(raw.toString());messages.push(value);if(value.event==='registerPlugin'){assert.equal(value.uuid,'fixture-registration');registrations++;}if(value.event==='getGlobalSettings'){socket.send(JSON.stringify({event:'didReceiveGlobalSettings',payload:{settings:{token}}}));socket.send(JSON.stringify({event:'willAppear',action:id+'.spotify.toggle',context:'fixture-key-'+registrations,payload:{settings:{}}}));}});});
  const child=spawn(process.execPath,['--require',path.join(__dirname,'fixtures/loopback-redirect.cjs'),path.join(__dirname,'../de.crazybatto.controlcenter.sdPlugin/bin/plugin.cjs'),'-port',String(streamdeck.address().port),'-pluginUUID','fixture-registration','-registerEvent','registerPlugin','-info','{}'],{windowsHide:true,env:{...process.env,CB_FIXTURE_PORT:String(bridge.address().port)},stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',b=>{stderr+=b.toString()});child.stdout.on('data',b=>{assert(!b.toString().includes(token))});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}for(const socket of sockets)socket.terminate();await new Promise(r=>streamdeck.close(r));bridge.closeAllConnections();await new Promise(r=>bridge.close(r));});
  await waitFor(()=>messages.some(v=>v.event==='setTitle'&&v.payload.title.includes('Fixture song')),'initial state');
  sockets[0].send(JSON.stringify({event:'keyDown',action:id+'.spotify.toggle',context:'fixture-key-1',payload:{settings:{}}}));
  await waitFor(()=>messages.some(v=>v.event==='showOk'),'action success');
  await waitFor(()=>messages.some(v=>v.event==='setTitle'&&v.payload.title.startsWith('Pause')),'updated actual state');
  assert.equal(requests.filter(r=>r.path==='/v1/action').length,1);
  sockets[0].close();await waitFor(()=>registrations===2,'re-registration');
  await waitFor(()=>messages.some(v=>v.event==='setTitle'&&v.context==='fixture-key-2'),'fresh action context');
  assert.equal(stderr,'');assert(!messages.some(v=>v.event==='sendToPropertyInspector'&&JSON.stringify(v).includes(token)));
});
