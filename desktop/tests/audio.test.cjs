'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {pickAudio,audioMime,createAudioPermission}=require('../electron/audio.cjs');
test('audio picker uses selected file bytes, rejects nonaudio, limits size and cancels cleanly',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cb-audio-'));try{
    const file=path.join(dir,'voice.wav'),bytes=Buffer.alloc(44);bytes.write('RIFF');bytes.write('WAVE',8);await fs.writeFile(file,bytes);
    const options={dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[file]})},getWindow:()=>null};
    const result=await pickAudio(options);assert.equal(result.mime,'audio/wav');assert.equal(result.name,'voice.wav');assert.equal(result.dataBase64,bytes.toString('base64'));assert.ok(!JSON.stringify(result).includes(dir));
    await fs.writeFile(file,'not audio file');await assert.rejects(pickAudio(options));
    await fs.writeFile(file,Buffer.alloc(8*1024*1024+1));await assert.rejects(pickAudio(options),/8 MB/);
    assert.deepEqual(await pickAudio({...options,dialog:{showOpenDialog:async()=>({canceled:true})}}),{canceled:true});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('microphone access requires explicit recent action and exact main application frame',()=>{
  let now=1000;const wc={mainFrame:{url:'file:///app/index.html'}},win={isDestroyed:()=>false,webContents:wc};const gate=createAudioPermission({getWindow:()=>win,getRendererUrl:()=>wc.mainFrame.url,now:()=>now});
  const detail={mediaType:'audio',isMainFrame:true,requestingUrl:wc.mainFrame.url};assert.equal(gate.check(wc,'media','file://',detail),false);gate.arm();assert.equal(gate.check(wc,'media','file://',detail),true);
  for(const [contents,permission,details] of [[{},'media',detail],[wc,'notifications',detail],[wc,'media',{...detail,mediaType:'video'}],[wc,'media',{...detail,requestingUrl:'https://evil.test'}],[wc,'media',{...detail,isMainFrame:false}]])assert.equal(gate.check(contents,permission,'file://',details),false);
  let allowed;gate.request(wc,'media',v=>allowed=v,{...detail,mediaTypes:['audio']});assert.equal(allowed,true);gate.request(wc,'media',v=>allowed=v,{...detail,mediaTypes:['audio','video']});assert.equal(allowed,false);
  now+=30001;assert.equal(gate.check(wc,'media','file://',detail),false);gate.arm();gate.clear();assert.equal(gate.check(wc,'media','file://',detail),false);
});

test('every delivered content policy allows local audio previews without remote media', async()=>{
  for(const file of ['index.html','electron/main.cjs']){
    const text=await fs.readFile(path.join(__dirname,'..',file),'utf8');
    const policy=text.match(/media-src ([^;]+);/);
    assert.ok(policy,`${file} must permit the local audio preview`);
    assert.match(policy[1],/blob:/);assert.match(policy[1],/data:/);assert.doesNotMatch(policy[1],/https?:|\*/);
  }
});
