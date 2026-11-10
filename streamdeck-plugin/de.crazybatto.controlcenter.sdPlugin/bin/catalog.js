'use strict';
// This shared catalog is original project code, used by Node and the local inspector.
(function(root) {
  const actions = [
    { key:'spotify.toggle', name:'Spotify · Wiedergabe', icon:'play', commands:[['spotify.toggle','Start / Pause'],['spotify.play','Start'],['spotify.pause','Pause']] },
    { key:'spotify.next', name:'Spotify · Nächster Titel', icon:'next', commands:[['spotify.next','Nächster Titel']] },
    { key:'spotify.previous', name:'Spotify · Vorheriger Titel', icon:'previous', commands:[['spotify.previous','Vorheriger Titel']] },
    { key:'spotify.volume', name:'Spotify · Lautstärke', icon:'volume', commands:[['spotify.volumeUp','5 % lauter'],['spotify.volumeDown','5 % leiser'],['spotify.volume','Lautstärke setzen']] },
    { key:'spotify.shuffle', name:'Spotify · Zufall', icon:'shuffle', commands:[['spotify.shuffle','Zufall ein / aus']] },
    { key:'spotify.repeat', name:'Spotify · Wiederholen', icon:'repeat', commands:[['spotify.repeat','Aus → Alles → Titel']] },
    { key:'spotify.transfer', name:'Spotify · Gerät wechseln', icon:'device', commands:[['spotify.transfer','Auf gewähltem Gerät wiedergeben']] },
    { key:'spotify.context', name:'Spotify · Favorit starten', icon:'star', commands:[['spotify.context','Playlist, Album oder Titel starten']] },
    { key:'music.join', name:'Bot · Meinem Sprachkanal beitreten', icon:'join', commands:[['music.join','Meinem Sprachkanal beitreten']] },
    { key:'music.leave', name:'Bot · Sprachkanal verlassen', icon:'leave', commands:[['music.leave','Wiedergabe stoppen und verlassen']] },
    { key:'music.toggle', name:'Bot · Musik steuern', icon:'music', commands:[['music.toggle','Start / Pause'],['music.play','Titel oder Playlist starten'],['music.pause','Pause']] },
    { key:'music.next', name:'Bot · Nächster Titel', icon:'next', commands:[['music.next','Nächster Titel']] },
    { key:'music.previous', name:'Bot · Vorheriger Titel', icon:'previous', commands:[['music.previous','Vorheriger Titel']] },
    { key:'music.volume', name:'Bot · Lautstärke', icon:'volume', commands:[['music.volumeUp','5 % lauter'],['music.volumeDown','5 % leiser'],['music.volume','Lautstärke setzen']] },
    { key:'app.open', name:'Control Center · Bereich öffnen', icon:'crown', commands:[['app.open','Gewählten Bereich öffnen']] }
  ];
  const pages = [['overview','Schaltzentrale'],['embeds','Einbettungen'],['templates','Vorlagen'],['welcome','Willkommen'],['rules','Regeln & Zustimmung'],['tiktok','TikTok Live'],['reports','Meldungen'],['joinrequests','Beitrittsanfragen'],['crowns','Rollen & Geräte'],['setups','Gaming Setups'],['voice','Sprachkanäle'],['botextras','Bot-Erweiterungen'],['tickets','Tickets'],['support','PC-Hilfe'],['members','Mitglieder'],['robotorders','Robot SchichtLog'],['counter','Mitgliederzähler'],['birthdays','Geburtstagskalender'],['birthdayembed','Geburtstags-Einbettung'],['eventposts','Event-Ankündigungen'],['events','Discord-Termine'],['music','Musik'],['spotify','Spotify'],['streamdeck','Stream Deck'],['localdiscord','Mein Discord'],['themes','Discord-Themes'],['server','Server gestalten'],['channels','Kanäle & Rollen'],['files','Server-Dateien'],['connections','Gespeicherte Zugänge'],['website','Konto & Bot'],['modules','Alle Funktionen'],['activity','Aktivitäten']];
  const value={id:'de.crazybatto.controlcenter',actions,pages};
  if(typeof module==='object'&&module.exports)module.exports=value;else root.CrazyBattoCatalog=value;
})(typeof window==='object'?window:globalThis);
