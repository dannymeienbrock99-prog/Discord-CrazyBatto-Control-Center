'use strict';
const fs=require('node:fs'),path=require('node:path'),catalog=require('../de.crazybatto.controlcenter.sdPlugin/bin/catalog.js');
const root=path.resolve(__dirname,'../de.crazybatto.controlcenter.sdPlugin');
// Original geometric crown, rendered to PNG for Elgato's required plugin icon.
function pngIcon(size=144){
 const zlib=require('node:zlib'),rows=Buffer.alloc(size*(size*4+1));
 const polygon=[[17,21],[27,28],[36,15],[45,28],[55,21],[50,41],[22,41]];
 const inside=(x,y)=>{let hit=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const[a,b]=polygon[i],[c,d]=polygon[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)hit=!hit;}return hit;};
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const px=x*72/size,py=y*72/size;const gold=inside(px,py)||(px>=23&&px<=49&&py>=45&&py<=48);
  const border=(Math.abs(px-36)>33||Math.abs(py-36)>33)&&Math.max(Math.abs(px-36),Math.abs(py-36))<35;
  const rgb=gold?[233,201,119]:border?[128,106,60]:[20+Math.round((72-py)/7),20+Math.round((72-py)/10),17];const at=y*(size*4+1)+1+x*4;rows.set([...rgb,255],at);
 }
 const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const shapes={
 play:'<path d="M29 19 47 30 29 41Z" fill="#e9c977"/>',
 next:'<path d="m23 20 18 10-18 10Z" fill="#e9c977"/><path d="M45 20v20"/>',
 previous:'<path d="m47 20-18 10 18 10Z" fill="#e9c977"/><path d="M25 20v20"/>',
 volume:'<path d="M23 26h7l9-7v22l-9-7h-7Z"/><path d="M44 23q9 7 0 14M49 18q15 12 0 24"/>',
 shuffle:'<path d="M21 21h5c10 0 10 18 20 18h5m-7-6 7 6-7 6M21 39h5c10 0 10-18 20-18h5m-7-6 7 6-7 6"/>',
 repeat:'<path d="M47 20H28a9 9 0 0 0-9 9m20-17 8 8-8 8M25 40h19a9 9 0 0 0 9-9m-20 17-8-8 8-8"/>',
 device:'<rect x="17" y="15" width="38" height="25" rx="3"/><path d="M29 46h14m-7-6v6"/>',
 star:'<path d="m36 13 6 12 13 2-10 10 2 13-11-6-11 6 2-13-10-10 13-2Z"/>',
 join:'<path d="M42 16h11v30H42M19 31h25m-9-9 9 9-9 9"/>',
 leave:'<path d="M29 16H18v30h11M32 31h23m-9-9 9 9-9 9"/>',
 music:'<path d="M29 39V20l22-5v19M29 26l22-5"/><ellipse cx="23" cy="41" rx="6" ry="4"/><ellipse cx="45" cy="36" rx="6" ry="4"/>',
 crown:'<path d="m17 21 10 7 9-13 9 13 10-7-5 20H22Z"/><path d="M23 47h26"/>'
};
fs.mkdirSync(path.join(root,'imgs'),{recursive:true});
fs.writeFileSync(path.join(root,'imgs','plugin.png'),pngIcon());
fs.writeFileSync(path.join(root,'imgs','plugin@2x.png'),pngIcon(288));
for(const [name,shape]of Object.entries(shapes)){
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#27231a"/><stop offset="1" stop-color="#090b0c"/></linearGradient></defs><rect width="72" height="72" rx="11" fill="url(#bg)"/><rect x="2" y="2" width="68" height="68" rx="9" stroke="#806a3c" fill="none"/><path d="m3 53 18-8M50 3 19 18M53 64l16-8" stroke="#5b492c" opacity=".5"/><g fill="none" stroke="#e9c977" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round">${shape}</g></svg>`;
 fs.writeFileSync(path.join(root,'imgs',name+'.svg'),svg);
}
const manifest={
 '$schema':'https://schemas.elgato.com/streamdeck/plugins/manifest.json',UUID:catalog.id,Name:'Crazy_Batto Control Center',Version:'1.0.0.0',Author:'Crazy_Batto',Description:'Spotify, Discord-Bot-Musik und alle Bereiche deines Control Centers mit deinem Stream Deck steuern.',Category:'Crazy_Batto Control Center',CategoryIcon:'imgs/crown',Icon:'imgs/plugin',CodePath:'bin/plugin.cjs',SDKVersion:2,Software:{MinimumVersion:'7.1'},OS:[{Platform:'windows',MinimumVersion:'10'}],Nodejs:{Version:'24'},PropertyInspectorPath:'ui/inspector.html',URL:'https://crazybatto.de',Actions:catalog.actions.map(a=>({Name:a.name,UUID:catalog.id+'.'+a.key,Icon:'imgs/'+a.icon,Tooltip:a.name,Controllers:['Keypad'],SupportedInMultiActions:false,States:[{Image:'imgs/'+a.icon,TitleAlignment:'bottom',TitleColor:'#f5e5ba',FontSize:10,FontFamily:'Arial',ShowTitle:true}]}))
};
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Created original vector icons and Stream Deck manifest.');
