const desktop = !!window.discordAdmin;
const read = (key, fallback) => {try{return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch{return fallback;}};
export const isDesktop = desktop;
export async function api(action,payload={}) {
  if(desktop) {
    const result=await window.discordAdmin.invoke(action,payload);
    if(!result.ok) {
      if(result.status===401&&result.code!=='discord') window.dispatchEvent(new Event('website-session-changed'));
      throw new Error(result.error || 'Die Aktion konnte nicht abgeschlossen werden.');
    }
    if(['connections.delete','connections.clearSecret'].includes(action)) window.dispatchEvent(new Event('website-session-changed'));
    return result.data;
  }
  if(action==='app.state')return {connected:false,bot:null,guilds:[],remembered:false,website:{connected:false}};
  if(action==='website.state')return {connected:false,user:null,profileId:null,baseUrl:null,expiresAt:null};
  if(action==='connections.list')return [];
  if(action==='files.state')return {connected:false,profileId:null,path:null};
  if(action==='templates.list')return read('cb-preview-templates',[]);
  if(action==='templates.save') {
    const all=read('cb-preview-templates',[]), item={...payload,id:payload.id||crypto.randomUUID(),updatedAt:new Date().toISOString()};
    localStorage.setItem('cb-preview-templates',JSON.stringify([...all.filter(t=>t.id!==item.id),item]));return item;
  }
  if(action==='templates.delete') {localStorage.setItem('cb-preview-templates',JSON.stringify(read('cb-preview-templates',[]).filter(t=>t.id!==payload.id)));return true;}
  if(action==='log.list')return [];
  if(action==='settings.get')return {};
  if(action==='image.builtin') {const blob=await (await fetch('./assets/community-banner.png')).blob();const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});return {name:'community-banner.png',dataUrl};}
  if(action==='app.openExternal') {const url=new URL(payload.url);if(url.protocol==='https:'&&['discord.com','docs.discord.com','support.discord.com','crazybatto.de'].includes(url.hostname)){window.open(url.href,'_blank','noopener,noreferrer');return true;}}
  throw new Error('Diese Funktion ist in der Windows-App verfügbar. Die Browser-Vorschau ist nicht mit Discord verbunden.');
}
export const initialDraft={content:'',title:'',description:'',color:'#d9b770',url:'',author:'',footer:'',imageUrl:'',thumbnailUrl:'',fields:[],timestamp:false};
