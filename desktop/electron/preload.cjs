'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set([
  'streamdeck.state','streamdeck.configure','streamdeck.copy','streamdeck.rotate',
  'extras.state','extras.automod.list','extras.automod.save','extras.audio.send',
  'localdiscord.state','localdiscord.install','localdiscord.toggle','localdiscord.settings','localdiscord.save','localdiscord.spectators','localdiscord.history','localdiscord.roles.save','audio.pick','audio.recordPermission','audio.recordEnd',
  'ownerprofile.copy','ownerprofile.open',
  'themes.state','themes.list','themes.save','themes.export','themes.install','notification.joinRequests',
  'joinrequests.list','joinrequests.review','admincrown.list','admincrown.lookup','admincrown.apply','admincrown.remove',
  'roles.state','roles.save','roles.decorate','roles.publish','setup.state','setup.save','setup.moderate','setup.retry','setup.image','setup.panel.state','setup.panel.save','setup.panel.publish','joinrole.state','joinrole.save','community.state','community.save','community.publish','community.register',
  'community.report.list','community.report.moderate','community.voice.list','community.voice.control',
  'community.ticket.list','community.ticket.close','tiktok.state','tiktok.save','tiktok.check',
  'app.state','bot.connect','bot.disconnect','guild.load','message.send','guild.update',
  'channel.create','channel.update','role.create','role.update','bot.profile','event.create',
  'log.list','templates.list','templates.save','templates.delete','settings.get','settings.save',
  'app.export','app.import','image.pick','image.builtin','app.openExternal',
  'connections.list','connections.save','connections.delete','connections.clearSecret','connections.importWinSCP',
  'files.state','files.connect','files.disconnect','files.list','files.chooseLocalFolder','files.localList','files.upload','files.download','files.mkdir',
  'website.state','website.login','website.reconnect','website.disconnect','website.load','website.request'
]);
contextBridge.exposeInMainWorld('discordAdmin', Object.freeze({
  onNavigate: callback => {
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,page)=>{if(typeof page==='string'&&/^[a-z]{1,24}$/.test(page))callback(page);};
    ipcRenderer.on('control-center:navigate',listener);
    return ()=>ipcRenderer.removeListener('control-center:navigate',listener);
  },
  invoke: (action,payload = {}) => allowed.has(action)
    ? ipcRenderer.invoke('discord-admin:invoke',action,payload)
    : Promise.resolve({ok:false,error:'Diese Aktion ist nicht freigegeben.'})
}));
