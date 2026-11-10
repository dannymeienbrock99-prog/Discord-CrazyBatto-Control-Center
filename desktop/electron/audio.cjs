'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const LIMIT=8*1024*1024;
function audioMime(bytes){
  if(bytes.length<12)throw Error('Diese Datei enthält keine unterstützte Audioaufnahme.');
  if(bytes.subarray(0,4).toString()==='OggS')return'audio/ogg';
  if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return'audio/webm';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return'audio/wav';
  if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0)return'audio/mpeg';
  throw Error('Bitte eine Ogg-, WebM-, MP3- oder WAV-Audiodatei wählen.');
}
async function pickAudio({dialog,getWindow,fsImpl=fs}){
  const selection=await dialog.showOpenDialog(getWindow(),{title:'Sprachnachricht auswählen',properties:['openFile'],filters:[{name:'Audio bis 8 MB',extensions:['ogg','opus','webm','mp3','wav']}]});
  if(selection.canceled)return{canceled:true};
  if(!Array.isArray(selection.filePaths)||selection.filePaths.length!==1)throw Error('Bitte eine Audiodatei auswählen.');
  const file=selection.filePaths[0],stat=await fsImpl.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1||stat.size<12||stat.size>LIMIT)throw Error('Bitte eine reguläre Audiodatei mit höchstens 8 MB wählen.');
  const handle=await fsImpl.open(file,'r');let bytes;
  try{const current=await handle.stat();if(current.ino!==stat.ino||current.size!==stat.size||current.mtimeMs!==stat.mtimeMs)throw Error('Die Audiodatei wurde inzwischen verändert.');const buffer=Buffer.alloc(stat.size+1);let read=0;while(read<buffer.length){const part=await handle.read(buffer,read,buffer.length-read,read);if(!part.bytesRead)break;read+=part.bytesRead;}const after=await handle.stat();if(read!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Die Audiodatei wurde inzwischen verändert.');bytes=buffer.subarray(0,read);}finally{await handle.close();}
  return{name:path.basename(file).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120),mime:audioMime(bytes),dataBase64:bytes.toString('base64'),bytes:bytes.length};
}
function createAudioPermission({getWindow,getRendererUrl,now=Date.now}){
  let until=0;
  const trusted=(contents)=>{const win=getWindow();return win&&!win.isDestroyed()&&contents===win.webContents&&contents.mainFrame?.url===getRendererUrl();};
  return{arm(){until=now()+30000;return{allowed:true};},clear(){until=0;return{allowed:false};},
    check(contents,permission,_origin,details={}){return until>now()&&trusted(contents)&&permission==='media'&&details.isMainFrame===true&&details.mediaType==='audio'&&(!details.requestingUrl||details.requestingUrl===getRendererUrl());},
    request(contents,permission,callback,details={}){const allowed=until>now()&&trusted(contents)&&permission==='media'&&details.isMainFrame===true&&(!details.requestingUrl||details.requestingUrl===getRendererUrl())&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length===1&&details.mediaTypes[0]==='audio';callback(allowed);}};
}
module.exports={pickAudio,audioMime,createAudioPermission};
