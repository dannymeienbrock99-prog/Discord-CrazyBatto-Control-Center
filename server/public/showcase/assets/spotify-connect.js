import {api,getSession,errorText} from './account-client.js';

const node=id=>document.getElementById(id);
let user=null,connection=null,generation=0,busy=false;
function message(text,error=false){node('spotifyConnectStatus').textContent=text;node('spotifyConnectStatus').classList.toggle('is-error',error);}
function eligible(){return Boolean(user?.confirmed&&!user.suspended);}
function render(){
  const ready=connection?.connected&&connection?.controllerReady;
  node('spotifyConnectButton').hidden=Boolean(ready);
  node('spotifyConnectButton').disabled=busy||!eligible()||!connection?.configured||Boolean(connection?.previewOnly);
  node('spotifyConnectButton').textContent=connection?.connected?'Spotify erneut freigeben':'Spotify verbinden';
  node('spotifyConnectRefresh').disabled=busy;
  node('spotifyConnectLogin').hidden=eligible();
  node('spotifyConnectIdentity').textContent=ready?`Verbunden mit ${connection.spotifyUser?.displayName||'deinem Spotify-Konto'}`:connection?.connected?'Erneute Spotify-Freigabe benötigt':'Dein Spotify-Konto verbinden';
  node('spotifyConnect').setAttribute('aria-busy',String(busy));
}
async function refresh(){
  const epoch=generation,session=await getSession();if(epoch!==generation)return false;user=session.user;
  if(!eligible()){
    connection=null;render();message(user?.suspended?'Dein Websitekonto ist gesperrt.':user&&!user.confirmed?'Bitte bestätige zuerst die E-Mail-Adresse deines Websitekontos.':'Melde dich im Kontofenster mit deinem Websitekonto an. Kehre danach hierher zurück und klicke auf „Status aktualisieren“.');return false;
  }
  connection=null;render();const status=await api('/api/spotify/status');if(epoch!==generation)return false;
  if(typeof status?.configured!=='boolean'||typeof status?.connected!=='boolean')throw Error('Der Spotify-Verbindungsstatus konnte nicht bestätigt werden.');
  connection=status;render();
  if(status.previewOnly)message('Die echte Spotify-Verbindung ist in dieser Vorschau deaktiviert.');
  else if(!status.configured)message('Spotify ist für diese Website noch nicht eingerichtet. Der Betreiber kann die Spotify-Einrichtung im Crazy_Batto Control Center öffnen.');
  else if(status.connected&&status.controllerReady)message('Dein Spotify-Konto ist für die Steuerung freigegeben. Wechsle zurück zum Crazy_Batto Control Center und aktualisiere dort den Spotify-Status.');
  else if(status.connected)message('Dein Konto ist verbunden. Gib Spotify erneut frei, damit das Control Center den Wiedergabestatus lesen und Spotify steuern kann.');
  else message('Verbinde dein eigenes Spotify-Konto. Bestätige bei Spotify die angeforderten Zugriffe und kehre anschließend ins Control Center zurück.');
  return true;
}
async function run(action){
  if(busy)return;busy=true;const epoch=generation;render();
  try{await action();}catch(error){if(epoch===generation){if(error.status===401||error.code==='SESSION_CHANGED'){user=null;connection=null;}message(errorText(error),true);}}
  finally{if(epoch===generation){busy=false;render();}}
}
async function connect(){
  const epoch=generation;if(!await refresh()||epoch!==generation||!connection?.configured||connection.previewOnly)return;
  // This explicit click starts account authorization, not an embedded player.
  // The retired SDK consent flag must not gate the first-party OAuth request.
  const result=await api('/api/spotify/connect',{method:'POST',body:{}});if(epoch!==generation)return;
  let target;try{target=new URL(result.authorizationUrl);}catch{throw Error('Die Spotify-Anmeldeadresse konnte nicht bestätigt werden.');}
  if(target.protocol!=='https:'||target.hostname!=='accounts.spotify.com'||target.pathname!=='/authorize'||target.username||target.password||target.port||target.hash)throw Error('Die Spotify-Anmeldeadresse konnte nicht bestätigt werden.');
  window.location.assign(target.href);
}
async function start(){
  const epoch=generation,url=new URL(window.location.href),callback=url.searchParams.get('spotify');
  if(callback!==null){url.searchParams.delete('spotify');window.history.replaceState(null,'',url.pathname+url.search+'#spotify-connect');}
  await refresh();if(epoch!==generation)return;
  if(callback==='error')message('Spotify hat die Verbindung nicht bestätigt. Prüfe die Freigabe deines Spotify-Kontos und versuche es erneut.',true);
  else if(callback==='connected'&&!(connection?.connected&&connection?.controllerReady))message('Die Rückkehr von Spotify ist erfolgt, aber die vollständige Verbindung konnte noch nicht bestätigt werden. Bitte den Status aktualisieren.',true);
}
function invalidate(){generation++;user=null;connection=null;busy=false;render();message('Deine Anmeldung hat sich geändert. Bitte den Status aktualisieren.');}
node('spotifyConnectButton').addEventListener('click',()=>run(connect));
node('spotifyConnectRefresh').addEventListener('click',()=>run(refresh));
window.addEventListener('cb-account-changed',invalidate);
window.addEventListener('storage',event=>{if(event.key==='cb-account-change')invalidate();});
window.addEventListener('pagehide',invalidate);
window.addEventListener('focus',()=>{if(!document.hidden)void run(refresh);});
void run(start);
