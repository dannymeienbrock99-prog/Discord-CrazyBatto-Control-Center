'use strict';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// A phone may still run the older worker, which cannot display setup notices.
// Only this active worker's explicit response lets the server release them.
self.addEventListener('message',event=>{
  if(event.data?.type==='control-push-capabilities'&&/^[a-f0-9-]{36}$/i.test(event.data.requestId||'')&&event.ports?.[0])event.ports[0].postMessage({type:'control-push-capabilities',requestId:event.data.requestId,setupPushVersion:1,reportPushVersion:1});
});
// No fetch handler: private pages and responses must never enter an offline cache.
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const recipientPattern=new RegExp('^'+UUID+'$','i');
const eventPattern=new RegExp('^(?:'+UUID+'|robot:'+UUID+':[1-9][0-9]{0,15})$','i');
const tagPattern=new RegExp('^cb-control-(?:member_registered|pc_ticket|pc_order|robot_order|gaming_setup|community_report|test)-'+UUID+'$','i');
const targetPattern=/^\/control-center\/(?:\?view=(members|support|robot|setups|reports))?$/;
self.addEventListener('push',event=>event.waitUntil((async()=>{
  let data;try{data=event.data.json();}catch{return;}
  // Browser Web Push authenticates transport; accept only this server's payload shape.
  if(data?.kind!=='control-center'||!recipientPattern.test(data.recipientId||'')||!eventPattern.test(data.eventId||'')||!tagPattern.test(data.tag||'')||typeof data.body!=='string'||data.body.length>180||!/^\/control-center\/\?view=(members|support|robot|setups|reports)$/.test(data.url||''))return;
  let verified=false;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch('/api/control-mobile/session',{credentials:'include',cache:'no-store',signal:controller.signal});
    if(response.status===401||response.status===403)return;
    if(response.ok){const session=await response.json();if(session.user?.id!==data.recipientId)return;verified=true;}
    else if(response.status<500||response.status>599)return;
  }catch{}finally{clearTimeout(timer);}
  // A temporary website outage must not lose the already-delivered push. The
  // unverified fallback contains no recipient, request type, ID or private text.
  await self.registration.showNotification('Crazy_Batto · Control Center',{
    body:verified?data.body:'Neue Aktivität. Bitte im Control Center anmelden und prüfen.',
    icon:'/assets/app-icon-192.png',badge:'/assets/app-icon-192.png',
    tag:verified?data.tag:'cb-control-activity',data:{url:verified?data.url:'/control-center/'},
    silent:false,vibrate:[200,100,200],requireInteraction:true,
  });
})()));
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const relative=event.notification.data?.url;if(!targetPattern.test(relative||''))return;const url=new URL(relative,self.location.origin).href;const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of clients){if(client.url.startsWith(self.location.origin+'/control-center/')){await client.navigate(url);await client.focus();return;}}await self.clients.openWindow(url);})());});
