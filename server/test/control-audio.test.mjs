import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { decodeAudio, prepareVoiceAudio, oggDuration, pcmWaveform, AUDIO_MAX_BYTES } from '../src/control-audio.mjs';

function ogg(seconds=2){
  const head=Buffer.alloc(47);head.write('OggS');head[5]=2;head.writeUInt32LE(42,14);head[26]=1;head[27]=19;head.write('OpusHead',28);head[36]=1;head[37]=1;head.writeUInt16LE(312,38);
  const end=Buffer.alloc(29);end.write('OggS');end[5]=4;end.writeBigUInt64LE(BigInt(seconds*48000+312),6);end.writeUInt32LE(42,14);end[26]=1;end[27]=1;return Buffer.concat([head,end]);
}
const input=()=>({name:'voice.ogg',mime:'audio/ogg',dataBase64:ogg().toString('base64')});
function fakeProcess(outputs,calls){return function(command,args,options){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};
  child.stdin=new Writable({write(chunk,encoding,done){done();},final(done){queueMicrotask(()=>{child.stdout.end(outputs.shift());child.emit('close',0);});done();}});
  calls.push({command,args,options,child});return child;
};}
test('audio decodes only bounded canonical base64 and matching supported magic',()=>{
  assert.equal(decodeAudio(input()).format,'ogg');
  for(const change of [{dataBase64:'data:audio/ogg;base64,AAAA'},{dataBase64:input().dataBase64+'\n'},{dataBase64:Buffer.from('#EXTM3U\nhttps://example.test/audio').toString('base64')},{dataBase64:Buffer.alloc(AUDIO_MAX_BYTES+1).toString('base64')},{mime:'audio/mpeg'},{mime:'text/plain'},{name:'unsafe\nname.ogg'}])assert.throws(()=>decodeAudio({...input(),...change}));
  const webm=Buffer.alloc(16);webm.writeUInt32BE(0x1a45dfa3);assert.equal(decodeAudio({name:'recording.webm',mime:'audio/webm;codecs=opus',dataBase64:webm.toString('base64')}).format,'matroska');
});
test('Opus duration comes from terminal granule minus pre-skip, not supplied metadata',()=>{
  assert.equal(oggDuration(ogg(2)),2);assert.throws(()=>oggDuration(ogg().subarray(0,47)));const bad=ogg();bad.writeUInt32LE(99,47+14);assert.throws(()=>oggDuration(bad));
  assert.equal(Buffer.from(pcmWaveform(Buffer.alloc(16000)), 'base64').length,10);assert.equal(Buffer.from(pcmWaveform(Buffer.alloc(16000)), 'base64').every(value=>value===0),true);
});
test('processing uses fixed pipe-only demuxers, server metadata and no shell or file paths',async()=>{
  const calls=[],pcm=Buffer.alloc(32000);pcm.writeInt16LE(16000,0);
  const result=await prepareVoiceAudio(input(),{spawnImpl:fakeProcess([ogg(2),pcm],calls)});
  assert.equal(result.mime,'audio/ogg');assert.equal(result.durationSeconds,2);assert.equal(calls.length,2);assert.equal(result.waveform,pcmWaveform(pcm));
  for(const call of calls){assert.equal(call.command,'ffmpeg');assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.args[call.args.indexOf('-protocol_whitelist')+1],'pipe');assert.equal(call.args[call.args.indexOf('-i')+1],'pipe:0');assert.equal(call.args.at(-1),'pipe:1');}
  assert.equal(calls[0].args[calls[0].args.indexOf('-f')+1],'ogg');assert.equal(calls[0].args[calls[0].args.indexOf('-t')+1],'301');
});
test('audio over 300 seconds is rejected before waveform generation, never silently shortened',async()=>{
  const calls=[];await assert.rejects(prepareVoiceAudio(input(),{spawnImpl:fakeProcess([ogg(301)],calls)}),{status:413});assert.equal(calls.length,1);
});
test('missing FFmpeg and invalid decoder output fail clearly without leaking stderr',async()=>{
  const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};queueMicrotask(()=>child.emit('error',Object.assign(Error('private path'),{code:'ENOENT'})));return child;};
  await assert.rejects(prepareVoiceAudio(input(),{spawnImpl}),{status:503});await assert.rejects(prepareVoiceAudio(input(),{spawnImpl:fakeProcess([Buffer.from('invalid')],[])}));
});
