export const THEME_PREVIEW_DEFAULTS={preset:'gold-marble',accentColor:'#D4AF37',backgroundColor:'#0B0D12',surfaceColor:'#151820',textColor:'#F5F2E8',backgroundUrl:'https://crazybatto.de/assets/control/marble-gold.webp',backgroundIntensity:25,borderRadius:12,fontSize:16};
const color=(value,fallback)=>/^#[a-f0-9]{6}$/i.test(value||'')?value:fallback;
const number=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Math.round(Number(value)))):fallback;
export function themeBackgroundUrl(value){
 if(!value||typeof value!=='string'||value.length>2048||/[\s\\"'(){};<>\u0000-\u001f\u007f]/.test(value))return null;
 try{const url=new URL(value),host=url.hostname;if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)||/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname)))return null;return url.href;}catch{return null;}
}
export function themePreviewModel(settings={}){
 const d=THEME_PREVIEW_DEFAULTS;
 return {imageUrl:themeBackgroundUrl(settings.backgroundUrl),style:{'--theme-accent':color(settings.accentColor,d.accentColor),'--theme-background':color(settings.backgroundColor,d.backgroundColor),'--theme-surface':color(settings.surfaceColor,d.surfaceColor),'--theme-text':color(settings.textColor,d.textColor),'--theme-intensity':number(settings.backgroundIntensity,0,80,d.backgroundIntensity)/100,'--theme-radius':number(settings.borderRadius,0,24,d.borderRadius)+'px','--theme-font':number(settings.fontSize,12,22,d.fontSize)+'px'}};
}
