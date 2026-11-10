export function renderLoginPage() {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Robot SchichtLog · Anmelden</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101114;color:#f0ede7;font:16px/1.55 system-ui,sans-serif}header,main{max-width:680px;margin:auto;padding:20px}header{border-bottom:1px solid #414047;font-weight:650}main{padding-top:clamp(36px,9vw,80px)}h1{font-size:clamp(32px,7vw,48px);letter-spacing:-.04em;margin:0}p{color:#bbb9b4;max-width:48ch}a{color:#dfbd78}a:focus-visible{outline:3px solid #dfbd78;outline-offset:3px}.button{display:inline-block;border-radius:6px;background:#dfbd78;color:#211b10;text-decoration:none;padding:12px 18px;font-weight:650}nav{display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin-top:24px}</style></head>
<body><header>Crazy_Batto</header><main><h1>Robot SchichtLog</h1><p>Melde dich mit deinem Betreiberkonto an, um die Android-App zu laden, ein Handy freizuschalten und deine Auftragsfotos anzusehen.</p><p>Die Anmeldung öffnet sich in einem neuen Tab. Kehre danach hierher zurück und öffne den Fotobereich.</p>
<nav><a class="button" href="/registrierung.html" target="_blank" rel="noopener">Bei Crazy_Batto anmelden</a><a href="/robot-schichtlog/">Fotobereich öffnen</a></nav></main></body></html>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.split('-').reverse().join('.') : day;
}

function photoGroups(photos, filtered) {
  if (!photos.length) return filtered
    ? '<div class="empty"><h3>Keine passenden Fotos</h3><p>Ändere die Suche oder setze die Filter zurück.</p></div>'
    : '<div class="empty"><h3>Noch keine Auftragsfotos</h3><p>Verbinde dein Schichthandy. Seine hochgeladenen Fotos erscheinen hier beim jeweiligen Auftrag.</p><button id="connect-first">Handy verbinden</button></div>';
  const days = new Map();
  for (const photo of photos) {
    if (!days.has(photo.day)) days.set(photo.day, new Map());
    const groups = days.get(photo.day);
    const label = 'Auftrag ' + photo.order_no + (photo.article ? ' · Artikel ' + photo.article : ' · Ohne Artikelnummer');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(photo);
  }
  return Array.from(days, ([day, groups]) => '<h2 class="day">' + esc(formatDay(day)) + '</h2>'
    + Array.from(groups, ([label, items]) => '<section class="group"><h3>' + esc(label) + '</h3><div class="grid">'
      + items.map((photo, i) => {
        const description = label + ' · ' + formatDay(day) + ' · Foto ' + (i + 1);
        return '<button class="thumb" data-caption="' + esc(description) + '"><img loading="lazy" decoding="async" src="/robot-schichtlog/photos/'
          + encodeURIComponent(photo.id) + '" alt="' + esc(description) + '"></button>';
      }).join('') + '</div></section>').join('')).join('');
}

function deviceRows(devices) {
  return devices.length ? devices.map(device => '<div class="device"><span><strong>' + esc(device.label) + '</strong>'
      + (device.revoked ? '<small>Freigabe widerrufen</small>' : '') + '</span>'
      + (device.revoked ? '' : '<label class="read-option"><input class="read-toggle" type="checkbox" data-id="' + esc(device.id) + '"'
        + (device.can_read ? ' checked' : '') + '> Fotos in der App ansehen</label>')
      + (device.revoked ? '' : '<button class="revoke" data-id="' + esc(device.id) + '">Freigabe widerrufen</button>') + '</div>').join('')
    : '<p id="no-devices">Noch kein Handy freigegeben.</p>';
}

export function renderRobotPage({devices = [], photos = [], page = 0, csrf = '', filters = {}} = {}) {
  const filtered = ['day','article','order'].some(key => filters[key]);
  const pagingLink = (number, label) => {
    const query = new URLSearchParams();
    for (const key of ['day','article','order']) if (filters[key]) query.set(key, filters[key]);
    query.set('page', String(number));
    return '<a class="button" href="?' + esc(query.toString()) + '">' + label + '</a>';
  };
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Robot SchichtLog · Crazy_Batto</title><meta name="csrf-token" content="${esc(csrf)}"><link rel="stylesheet" href="/robot-schichtlog/style.css"><script defer src="/robot-schichtlog/app.js"></script></head>
<body><header><div class="wrap top"><span class="brand">Crazy_Batto</span><a href="/index.html">Zur Website</a></div></header>
<main class="wrap"><div class="title"><div><h1>Robot SchichtLog</h1><p>Auftragsfotos und verbundene Handys</p></div><a class="button download" href="/robot-schichtlog/app.apk" download>Android-App laden</a></div>
<nav aria-label="Bereiche"><button id="photos-tab" aria-pressed="true">Auftragsfotos</button><button id="devices-tab" aria-pressed="false">Handys</button></nav>
<p id="notice" role="status" hidden></p>
<section id="photos-panel"><h2 class="visually-hidden">Auftragsfotos</h2>
<form id="filters" class="filters" method="get" action="/robot-schichtlog/"><label>Datum<input type="date" name="day" value="${esc(filters.day)}"></label><label>Artikelnummer<input name="article" placeholder="Alle Artikel" value="${esc(filters.article)}"></label><label>Auftragsnummer<input name="order" placeholder="Alle Aufträge" value="${esc(filters.order)}"></label><button type="submit">Filtern</button>${filtered ? '<a class="button subtle" href="/robot-schichtlog/">Zurücksetzen</a>' : ''}</form>
<div id="gallery">${photoGroups(photos.slice(0,40), filtered)}</div><div class="actions">${page > 0 ? pagingLink(page-1,'Zurück') : ''}${photos.length > 40 ? pagingLink(page+1,'Weitere Fotos') : ''}</div></section>
<section id="devices-panel" hidden><div class="pair"><div><h2>Handy verbinden</h2><p>Gib dem Handy einen Namen. Den Gerätecode trägst du in der App unter <strong>Fotospeicher</strong> ein.</p></div>
<form id="new-device"><label>Gerätename<input id="name" maxlength="60" placeholder="z. B. Schichthandy 1" required></label>
<label class="read-option"><input type="checkbox" id="new-read" aria-describedby="read-info"> Fotos in der App ansehen</label>
<small id="read-info">Mit dieser Freigabe kann das Handy bei bekannter Auftrags- und Artikelnummer auch Fotos anderer Handys abrufen. Ohne Häkchen kann es nur hochladen.</small>
<button class="primary" type="submit">Gerätecode erstellen</button></form></div>
<div id="issued" hidden><label>Gerätecode für die App<input id="secret" readonly autocomplete="off" spellcheck="false"></label><div class="actions"><button id="copy" class="primary">Kopieren</button><button id="hide">Code ausblenden</button></div><small>Der Code wird nur einmal angezeigt.</small></div>
<h2 class="subhead">Freigegebene Handys</h2><p class="device-hint">Die Bildansicht lässt sich für jedes Handy einzeln ändern. Beim Ausschalten endet der Zugriff auf weitere Serverfotos.</p><div id="devices">${deviceRows(devices)}</div></section>
<dialog id="viewer"><div class="dialog-head"><strong id="photo-caption"></strong><button id="close-viewer">Schließen</button></div><img id="large-image" alt="Auftragsfoto in Großansicht"></dialog></main></body></html>`;
}

export const robotCss = `
:root{color-scheme:dark;--bg:#101114;--panel:#18191c;--line:#414047;--gold:#dfbd78;--fg:#f0ede7;--muted:#bbb9b4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Segoe UI",Arial,sans-serif}a{color:var(--gold)}[hidden]{display:none!important}.wrap{max-width:1040px;margin:auto;padding-inline:clamp(18px,4vw,42px)}
header{border-bottom:1px solid #39352c;background:#141416}.top,.title,.dialog-head,.actions,.device{display:flex;align-items:center;justify-content:space-between;gap:16px}.top{min-height:58px}.top a{font-size:14px}.brand{font-weight:650;letter-spacing:.01em}.title{padding-block:clamp(24px,5vw,56px) 28px}.title p,.pair p,small{color:var(--muted)}h1,h2,p{margin:0}h1{font-size:clamp(32px,6vw,52px);line-height:1.15;letter-spacing:-.035em}h2{font-size:23px;letter-spacing:-.02em}h3{font-size:17px;margin:0}.title p{margin-top:6px}
button,.button,input{font:inherit}button,.button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:43px;border:1px solid var(--line);background:#222326;color:var(--fg);text-decoration:none;padding:8px 15px;border-radius:6px}button:disabled{opacity:.55;cursor:wait}.primary,.download{background:var(--gold);color:#211b10;border-color:var(--gold);font-weight:650}.download{white-space:nowrap}button:hover,.button:hover{filter:brightness(1.14)}:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
nav{display:flex;gap:22px;border-bottom:1px solid var(--line);margin-bottom:26px}nav button{border:0;border-bottom:3px solid transparent;border-radius:0;background:transparent;color:var(--muted);padding:9px 1px;font-weight:600}nav [aria-pressed=true]{color:var(--gold);border-bottom-color:var(--gold)}
label{display:flex;flex-direction:column;gap:5px;font-size:14px;font-weight:600}input{min-width:0;width:100%;min-height:43px;padding:8px 10px;color:var(--fg);background:#101114;border:1px solid #545359;border-radius:5px}input::placeholder{color:#a5a4a6}.filters,#new-device{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.filters label{flex:1 1 145px}.subtle{background:transparent}.filters{margin-bottom:28px}.pair,#issued,.empty{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:clamp(16px,3vw,26px)}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.pair p{margin-top:5px}#new-device label{flex:1 1 100%}#issued{margin-top:16px;border-color:var(--gold)}#issued input{font-family:monospace}.actions{justify-content:flex-start;margin-block:12px}.subhead{margin:30px 0 12px}.device{border-top:1px solid var(--line);padding-block:12px}.device small{display:block}.device button{min-height:36px}.empty h3{margin-bottom:4px}.empty p{color:var(--muted)}.empty button{margin-top:14px}.day{margin:26px 0 12px}.group{margin-bottom:18px}.group h3{padding:8px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:8px}.grid button{padding:0;background:var(--panel);border:0;overflow:hidden}.grid img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}dialog{background:var(--panel);color:var(--fg);width:min(880px,94vw);border:1px solid var(--line);border-radius:8px;padding:16px}dialog::backdrop{background:#000b}.dialog-head{margin-bottom:12px}#large-image{width:100%;max-height:72dvh;object-fit:contain}#notice{border-left:3px solid var(--gold);background:var(--panel);padding:10px 15px;margin-bottom:18px}main{padding-bottom:48px}.visually-hidden{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}
.read-option{display:flex;flex-direction:row;align-items:center;gap:8px;min-height:40px}.read-option input{min-height:0;width:19px;height:19px;accent-color:var(--gold)}.device-hint{margin:0 0 14px;color:var(--muted)}.device{flex-wrap:wrap}
@media(max-width:600px){.title{align-items:start;flex-direction:column}.pair{grid-template-columns:1fr;gap:14px}.filters{display:grid;grid-template-columns:1fr 1fr}.filters label:first-child{grid-column:1/-1}.filters button{justify-self:start}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.top{min-height:50px}.dialog-head{align-items:start}.device>span{flex:1 1 100%}}
`;
function runControls() {
  const get = id => document.getElementById(id);
  const notify = message => {
    get('notice').textContent = message;
    get('notice').hidden = !message;
  };
  function switchTab(devices) {
    get('photos-panel').hidden = devices;
    get('devices-panel').hidden = !devices;
    get('photos-tab').setAttribute('aria-pressed', String(!devices));
    get('devices-tab').setAttribute('aria-pressed', String(devices));
    notify('');
  }
  get('photos-tab').onclick = () => switchTab(false);
  get('devices-tab').onclick = () => switchTab(true);
  if (get('connect-first')) get('connect-first').onclick = () => { switchTab(true); get('name').focus(); };
  if (location.hash === '#handys') switchTab(true);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  async function mutation(url, options) {
    const response = await fetch(url, { ...options, mode: 'same-origin', credentials: 'same-origin',
      cache: 'no-store', headers: {'Content-Type':'application/json','X-CSRF-Token':csrf} });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw Error('Bitte melde dich erneut mit deinem Betreiberkonto an.');
      throw Error('Der Vorgang ist fehlgeschlagen. Bitte versuche es erneut.');
    }
    return response.status === 204 ? {} : response.json();
  }
  const hideCode = () => { get('secret').value = ''; get('issued').hidden = true; };
  get('hide').onclick = hideCode;
  addEventListener('pagehide', hideCode);
  get('new-device').onsubmit = async event => {
    event.preventDefault();
    const label = get('name').value.trim();
    if (!label) { get('name').focus(); return; }
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    hideCode();
    try {
      const canRead = get('new-read').checked;
      const result = await mutation('/robot-schichtlog/devices', { method:'POST', body:JSON.stringify({label,canRead}) });
      if (!result.id || !result.token) throw Error('Der Server hat keinen Gerätecode bestätigt.');
      get('no-devices')?.remove();
      const row = document.createElement('div'), title = document.createElement('strong'), revoke = document.createElement('button');
      row.className = 'device'; title.textContent = label; revoke.className = 'revoke'; revoke.dataset.id = result.id;
      const readLabel = document.createElement('label'), toggle = document.createElement('input');
      toggle.type = 'checkbox'; toggle.className = 'read-toggle'; toggle.dataset.id = result.id; toggle.checked = result.canRead;
      readLabel.className = 'read-option'; readLabel.append(toggle, ' Fotos in der App ansehen');
      revoke.textContent = 'Freigabe widerrufen'; row.append(title,readLabel,revoke); get('devices').prepend(row);
      get('secret').value = result.token; get('issued').hidden = false; get('secret').focus();
      get('name').value = ''; get('new-read').checked = false; notify('Gerätecode erstellt. Kopiere ihn jetzt in die App.');
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  };
  get('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(get('secret').value); notify('Gerätecode kopiert.'); }
    catch { get('secret').focus(); get('secret').select(); notify('Der Gerätecode ist markiert und kann kopiert werden.'); }
  };
  get('devices').onchange = async event => {
    const toggle = event.target.closest('.read-toggle');
    if (!toggle) return;
    const canRead = toggle.checked;
    toggle.disabled = true;
    try {
      await mutation('/robot-schichtlog/devices/' + encodeURIComponent(toggle.dataset.id), {
        method:'PATCH', body:JSON.stringify({canRead})
      });
      notify(canRead ? 'Dieses Handy kann Auftragsfotos vom Server ansehen.' : 'Dieses Handy kann nur noch hochladen.');
    } catch (error) { toggle.checked = !canRead; notify(error.message); } finally { toggle.disabled = false; }
  };
  get('devices').onclick = async event => {
    const button = event.target.closest('.revoke');
    if (!button || !confirm('Freigabe widerrufen? Dieses Handy kann dann keine Serverfotos mehr abrufen oder hochladen.')) return;
    button.disabled = true;
    try {
      await mutation('/robot-schichtlog/devices/' + encodeURIComponent(button.dataset.id), {method:'DELETE'});
      const status = document.createElement('small'); status.textContent = 'Freigabe widerrufen';
      button.closest('.device')?.querySelector('.read-option')?.remove();
      button.replaceWith(status); hideCode(); notify('Freigabe widerrufen.');
    } catch (error) { button.disabled = false; notify(error.message); }
  };
  get('gallery').onclick = event => {
    const thumb = event.target.closest('.thumb');
    if (!thumb) return;
    get('photo-caption').textContent = thumb.dataset.caption;
    get('large-image').src = thumb.querySelector('img').src;
    get('viewer').showModal();
  };
  get('close-viewer').onclick = () => get('viewer').close();
  get('viewer').addEventListener('close', () => get('large-image').removeAttribute('src'));
}

export const robotJs = '(' + runControls.toString() + ')();';

