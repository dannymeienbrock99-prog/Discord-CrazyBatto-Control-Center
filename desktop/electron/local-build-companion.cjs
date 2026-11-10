'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
function renderCompanion(core,runtime){
  if(typeof core!=='string'||typeof runtime!=='string'||!core.includes('module.exports=')||!runtime.includes('module.exports=function createCompanion'))throw Error('Invalid original companion sources');
  const requires=[...core.matchAll(/\brequire\s*\(([^)]*)\)/g)].map(match=>match[1]);
  if(requires.some(name=>!/^['"](?:fs|path|crypto)['"]$/.test(name.trim()))||/\brequire\s*\(/.test(runtime))throw Error('Companion sources may only import BetterDiscord built-ins');
  if(/\beval\s*\(|\bnew\s+Function\s*\(/.test(core+'\n'+runtime))throw Error('Companion source cannot dynamically compile code');
  return `/**
 * @name CrazyBattoControl
 * @author Crazy_Batto
 * @version 3.4.0
 * @description Verbindet ausschließlich das lokale Control Center mit deinen vorhandenen Plugins. Keine Netzwerkverbindung, keine Discord-Token.
 * @crazybatto-original-bridge 1
 * @crazybatto-single-file 1
 * @coreSha256 ${digest(core)}
 * @runtimeSha256 ${digest(runtime)}
 */
'use strict';
// Generated from our own local-discord-core.cjs and local-companion-runtime.cjs.
// Static source only: no external helper imports or runtime code compilation.
const core=(()=>{
  const module={exports:{}};
${core}
  return module.exports;
})();
const createCompanion=(()=>{
  const module={exports:{}};
${runtime}
  return module.exports;
})();
module.exports=createCompanion(core);
`;
}
function build(){
  const core=fs.readFileSync(path.join(__dirname,'local-discord-core.cjs'),'utf8');
  const runtime=fs.readFileSync(path.join(__dirname,'local-companion-runtime.cjs'),'utf8');
  const contents=renderCompanion(core,runtime),target=path.join(__dirname,'betterdiscord','CrazyBattoControl.plugin.js');
  if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==contents)fs.writeFileSync(target,contents);
  return {bytes:Buffer.byteLength(contents),sha256:digest(contents)};
}
if(require.main===module)console.log(JSON.stringify({companionBuilt:true,...build()}));
module.exports={renderCompanion,build};
