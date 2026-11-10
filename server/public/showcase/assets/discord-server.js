import { api, getSession, errorText } from './account-client.js';

const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('de-DE');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ownerAnimationPath = '/assets/team-alpha-banner-motion-20261016.gif';
const ownerPosterPath = '/assets/team-alpha-banner-motion-poster-20261016.webp';
const animationPaused = new Map();
let servers = [], loading = false, sequence = 0;

function node(tag, text = '', className = '') {
  const result = document.createElement(tag); result.textContent = text;
  if (className) result.className = className;
  return result;
}
function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
function imagePath(value) {
  if (typeof value !== 'string') return null;
  if (value === ownerAnimationPath || value === ownerPosterPath) return value;
  if (value === '/assets/team-alpha-banner-20261016.webp' || value === '/assets/team-alpha-banner-poster-20261016.webp') return value;
  if (value === '/assets/crazy-batto-discord-banner.gif' || value === 'assets/crazy-batto-discord-banner.gif') return value;
  return /^\/api\/discord-servers\/[a-zA-Z0-9_-]{1,80}\/images\/(?:banner|icon)(?:\?[a-zA-Z0-9_=&.-]{1,160})?$/.test(value) ? value : null;
}
function invitePath(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'discord.gg' && !url.username && !url.password && !url.port && /^\/[a-zA-Z0-9_-]{2,100}$/.test(url.pathname) && !url.search && !url.hash ? url.href : null; } catch { return null; }
}
function missingBanner(name, text = 'Kein Serverbanner hinterlegt') {
  const box = node('div', '', 'cb-directory-banner-missing'); box.append(node('strong', name), node('span', text)); return box;
}
function ownerBanner(id, name) {
  const content = document.createDocumentFragment();
  const banner = node('div', '', 'cb-directory-banner cb-directory-banner-owner');
  const toggle = node('button', '', 'cb-directory-banner-toggle'); toggle.type = 'button';
  let paused = animationPaused.get(id) ?? reducedMotion.matches;
  function paint() {
    const img = node('img'); img.alt = 'ミ★ Team Alpha ★彡 – Crazy_Batto-Community-Banner';
    img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    const animated = !paused;
    img.addEventListener('error', () => {
      if (banner.firstElementChild !== img) return;
      if (animated) {
        paused = true; animationPaused.set(id, true); paint();
        toggle.disabled = true; toggle.textContent = 'Animation momentan nicht verfügbar';
      } else banner.replaceChildren(missingBanner(name, 'Banner ist momentan nicht verfügbar'));
    }, { once: true });
    img.src = animated ? ownerAnimationPath : ownerPosterPath; banner.replaceChildren(img);
    toggle.textContent = paused ? 'Animation starten' : 'Animation pausieren';
    toggle.setAttribute('aria-pressed', String(!paused));
  }
  toggle.addEventListener('click', () => { paused = !paused; animationPaused.set(id, paused); paint(); });
  paint(); content.append(banner, toggle); return content;
}
function card(server) {
  const article = node('article', '', 'cb-directory-entry');
  const name = typeof server.name === 'string' && server.name.trim() ? server.name : 'Discord-Server';
  const banner = node('div', '', 'cb-directory-banner'), source = imagePath(server.bannerUrl);
  if (source === ownerAnimationPath) {
    article.append(ownerBanner(server.id, name));
  } else {
    const placeholder = () => missingBanner(name, source ? 'Banner ist momentan nicht verfügbar' : 'Kein Serverbanner hinterlegt');
    let bannerHidden = reducedMotion.matches;
    function showBanner() {
      if (!source || bannerHidden) { banner.replaceChildren(missingBanner(name, source ? 'Banner ausgeblendet' : 'Kein Serverbanner hinterlegt')); return; }
      const img = node('img'); img.alt = 'Serverbanner von ' + name; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => banner.replaceChildren(placeholder()), { once: true }); img.src = source; banner.replaceChildren(img);
    }
    showBanner(); article.append(banner);
    if (source) {
      const toggle = node('button', bannerHidden ? 'Banner anzeigen' : 'Banner ausblenden', 'cb-directory-banner-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-pressed', String(!bannerHidden));
      toggle.addEventListener('click', () => { bannerHidden = !bannerHidden; showBanner(); toggle.textContent = bannerHidden ? 'Banner anzeigen' : 'Banner ausblenden'; toggle.setAttribute('aria-pressed', String(!bannerHidden)); }); article.append(toggle);
    }
  }
  const details = node('div', '', 'cb-directory-server'), identity = node('div', '', 'cb-directory-identity'), avatar = node('div', '', 'cb-directory-icon');
  avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = [...name].slice(0, 2).join('').toLocaleUpperCase('de-DE');
  const avatarSource = imagePath(server.iconUrl);
  if (avatarSource) { const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.addEventListener('error', () => { avatar.textContent = [...name].slice(0, 2).join('').toLocaleUpperCase('de-DE'); }, { once: true }); img.src = avatarSource; avatar.replaceChildren(img); }
  identity.append(avatar, node('h2', name)); details.append(identity);
  const counts = node('dl', '', 'cb-directory-counts');
  for (const [label, value] of [['Mitglieder', server.memberCount], ['Online', server.onlineCount]]) {
    const pair = node('div'), amount = node('dd', Number.isSafeInteger(value) && value >= 0 ? number.format(value) : '–');
    if (!Number.isSafeInteger(value) || value < 0) amount.setAttribute('aria-label', 'Nicht verfügbar');
    pair.append(node('dt', label), amount); counts.append(pair);
  }
  details.append(counts);
  const invite = invitePath(server.inviteUrl);
  if (invite) { const link = node('a', 'Discord öffnen', 'cb-button cb-button-gold'); link.href = invite; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.append(icon(['M14 4h6v6M20 4l-9 9M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5'])); details.append(link); }
  article.append(details);
  if (typeof server.description === 'string' && server.description.trim()) article.append(node('p', server.description, 'cb-directory-details'));
  const known = Number.isSafeInteger(server.memberCount) || Number.isSafeInteger(server.onlineCount);
  let text = server.status === 'unavailable' ? 'Discord-Informationen sind momentan nicht verfügbar.' : server.status === 'stale' ? 'Discord ist momentan nicht erreichbar. Angezeigt wird der letzte verfügbare Stand.' : known ? 'Ungefähre Mitgliederzahlen von Discord.' : 'Mitgliederzahlen sind momentan nicht verfügbar.';
  const date = server.updatedAt == null ? null : new Date(server.updatedAt);
  if (date && Number.isFinite(date.getTime())) text += ' Stand: ' + date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + '.';
  article.append(node('p', text, 'cb-directory-note'));
  return article;
}
function render() {
  const search = $('directorySearch').value.trim().toLocaleLowerCase('de-DE');
  const filtered = servers.filter(server => [server.name, server.description].filter(Boolean).join(' ').toLocaleLowerCase('de-DE').includes(search));
  $('directoryList').replaceChildren(...filtered.map(card));
  if (!filtered.length) $('directoryList').append(node('p', search ? 'Kein Server passt zu deiner Suche.' : 'Hier sind noch keine Discord-Server veröffentlicht.', 'cb-directory-empty'));
}
async function load() {
  if (loading) return;
  const current = ++sequence; loading = true; $('directoryRefresh').disabled = true; $('directoryList').setAttribute('aria-busy', 'true');
  $('directoryFeedback').textContent = 'Discord-Server werden geladen …'; $('directoryFeedback').classList.remove('is-error');
  try {
    const result = await api('/api/discord-servers', { timeout: 30000 });
    if (current !== sequence) return;
    if (!Array.isArray(result.servers) || result.servers.length > 20 || result.servers.some(server => !server || typeof server.id !== 'string')) throw new Error('Die Serverübersicht konnte nicht vollständig geladen werden.');
    servers = result.servers; render();
    $('directoryFeedback').textContent = servers.some(server => server.status !== 'ready') ? 'Einige Discord-Daten sind momentan nicht aktuell.' : servers.length ? ' ' : 'Die Übersicht ist bereit.';
  } catch (error) {
    if (current !== sequence) return;
    $('directoryFeedback').textContent = errorText(error); $('directoryFeedback').classList.add('is-error');
    if (!servers.length) $('directoryList').replaceChildren(node('p', 'Die Serverübersicht ist gerade nicht erreichbar. Bitte versuche es über „Aktualisieren“ erneut.', 'cb-directory-empty'));
  } finally { if (current === sequence) { loading = false; $('directoryRefresh').disabled = false; $('directoryList').setAttribute('aria-busy', 'false'); } }
}
async function adminLink() {
  $('directoryAdmin').hidden = true;
  try { const session = await getSession(); $('directoryAdmin').hidden = !(session.user?.isAdmin && session.user.confirmed && !session.user.suspended); } catch { /* Public directory needs no account. */ }
}
$('directoryRefresh').addEventListener('click', load);
$('directorySearch').addEventListener('input', render);
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) for (const server of servers) animationPaused.set(server.id, true);
  render();
});
window.addEventListener('pageshow', adminLink);
load(); adminLink();
