export const BIRTHDAY_IMAGES={
 greeting:'https://crazybatto.de/assets/control/dragon-gold-birthday.png',
 reminder:'https://crazybatto.de/assets/control/dragon-gold-calendar.png'
};

export function withBirthdayImages(settings={}){
 return {...settings,greetingImageUrl:settings.greetingImageUrl??'',reminderImageUrl:settings.reminderImageUrl??''};
}

export function birthdayImageError(value){
 if(value==='')return '';
 if(typeof value!=='string'||value.length>2048||/[\s\\\u0000-\u001f\u007f]/.test(value))return 'Verwende eine öffentliche HTTPS-Bildadresse bis 2.048 Zeichen ohne Leerzeichen.';
 try{
  const url=new URL(value),host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)||/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname)))return 'Verwende eine öffentliche HTTPS-Bildadresse ohne Zugangsdaten oder Video-Datei.';
  return '';
 }catch{return 'Diese Bildadresse ist nicht gültig.';}
}

export function birthdayExample(text,reminderDays){
 return String(text||'').replaceAll('{name}','Beispiel-Mitglied').replaceAll('{date}','12.11.').replaceAll('{days}',String(reminderDays??3)).replaceAll('{website}','https://crazybatto.de/geburtstage.html');
}
