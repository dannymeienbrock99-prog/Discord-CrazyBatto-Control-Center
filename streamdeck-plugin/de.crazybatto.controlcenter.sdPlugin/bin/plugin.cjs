'use strict';
const {Controller}=require('./core.cjs');
function readArgs(args){const out={};for(let i=0;i<args.length;i+=2){if(!['-port','-pluginUUID','-registerEvent','-info'].includes(args[i])||!args[i+1])throw Error('Invalid launch arguments');out[args[i]]=args[i+1];}const port=Number(out['-port']);if(!Number.isInteger(port)||port<1||port>65535||!/^registerPlugin$/.test(out['-registerEvent'])||!/^[A-Za-z0-9_-]{1,200}$/.test(out['-pluginUUID']||''))throw Error('Missing launch arguments');return {port,uuid:out['-pluginUUID'],event:out['-registerEvent']};}
function start(args,{WebSocketClass=globalThis.WebSocket,setIntervalFn=setInterval,setTimeoutFn=setTimeout,clearIntervalFn=clearInterval}={}){
  const registration=readArgs(args);let stopped=false,socket=null,retry=0,timer=null;
  const send=value=>{if(socket?.readyState===1)socket.send(JSON.stringify(value));};
  const controller=new Controller({send,uuid:registration.uuid});
  const connect=()=>{if(stopped)return;socket=new WebSocketClass('ws://127.0.0.1:'+registration.port);socket.addEventListener('open',()=>{retry=0;send({event:registration.event,uuid:registration.uuid});send({event:'getGlobalSettings',context:registration.uuid});timer=setIntervalFn(()=>{if(controller.keys.size)controller.poll().catch(()=>{});},1000);timer.unref?.();});socket.addEventListener('message',event=>{if(typeof event.data!=='string'||event.data.length>512*1024)return;try{Promise.resolve(controller.receive(JSON.parse(event.data))).catch(()=>{});}catch{}});socket.addEventListener('error',()=>{});socket.addEventListener('close',()=>{clearIntervalFn(timer);timer=null;controller.keys.clear();controller.inspectors.clear();controller.lastPress.clear();if(!stopped)setTimeoutFn(connect,Math.min(30000,1000*2**Math.min(retry++,5)));});};
  connect();return {controller,stop(){stopped=true;clearIntervalFn(timer);socket?.close();}};
}
if(require.main===module){try{const running=start(process.argv.slice(2));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{running.stop();process.exit(0);});}catch{process.stderr.write('Crazy_Batto: Stream Deck konnte die Erweiterung nicht starten.\n');process.exitCode=1;}}
module.exports={readArgs,start};
