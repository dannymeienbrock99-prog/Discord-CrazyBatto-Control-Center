import { api, getSession, errorText, formatDate } from './account-client.js';
const byId = id => document.getElementById(id);
let state;
let lastFetchedAt;
function show(result, fresh = true) {
  if (fresh) lastFetchedAt = new Date().toISOString();
  state = result;
  if (byId('botMusicStatus')) byId('botMusicStatus').textContent = result.music?.message || (!result.music?.configured ? 'Musikbot noch nicht auf dem Server eingerichtet.' : result.music.track ? `${result.music.paused ? 'Pausiert' : 'Aktueller Titel'}: ${result.music.track} · ${result.music.position}/${result.music.total}` : 'Musikbot eingerichtet. Starte eine Playlist in Discord.');
  byId('botPanel').hidden = false;
  byId('botRefresh').disabled = false;
  byId('botStatus').textContent = result.message;
  byId('botGuild').textContent = result.guildId || 'Noch nicht eingerichtet';
  byId('botRegistered').textContent = formatDate(result.registeredAt);
  byId('botConnection').textContent = result.connection ? (result.connection.online ? 'Zugriff auf ' + result.connection.name + ' bestätigt' : 'Zugriff nicht bestätigt') + ' · ' + formatDate(result.connection.checkedAt) : 'Der Zugriff auf deinen Discord-Server wurde noch nicht geprüft.';
  byId('botPresence').textContent = fresh
    ? (result.presence?.message || 'Der Discord-Onlinestatus ist noch nicht verfügbar.') + ' · Abgerufen: ' + formatDate(lastFetchedAt)
    : 'Der aktuelle Discord-Onlinestatus konnte nicht bestätigt werden. Letzter Abruf: ' + formatDate(lastFetchedAt);
  byId('botEnabled').checked = result.enabled;
  byId('botEnableNote').textContent = result.enabled ? 'Community-Befehle sind eingeschaltet.' : 'Community-Befehle sind ausgeschaltet.';
  byId('botRegister').disabled = !result.configured;
  byId('botCheck').disabled = !result.configured;
  byId('botEnabled').disabled = !result.configured || !result.registeredAt;
}
async function action(path, options, success) {
  const buttons = [...document.querySelectorAll('button,input')];
  buttons.forEach(button => { button.disabled = true; });
  byId('botFeedback').textContent = 'Wird bearbeitet …';
  try { show(await api(path, options)); byId('botFeedback').textContent = success; }
  catch (error) { if (state) show(state, false); byId('botFeedback').textContent = errorText(error); }
}
byId('botCheck').addEventListener('click', () => action('/api/admin/bot/check', { method: 'POST', body: {} }, 'Verbindung geprüft.'));
byId('botRegister').addEventListener('click', () => action('/api/admin/bot/commands', { method: 'POST', body: {}, timeout: 90000 }, 'Die Bot-Befehle einschließlich /geburtstage sind in Discord eingerichtet.'));
byId('botEnabled').addEventListener('change', event => action('/api/admin/bot', { method: 'PUT', body: { enabled: event.target.checked } }, 'Einstellung gespeichert.'));
byId('botRefresh').addEventListener('click', () => action('/api/admin/bot', {}, 'Status aktualisiert.'));
try {
  const session = await getSession();
  if (!session.user?.isAdmin) throw new Error('Bitte mit deinem Administratorkonto auf „Mein Konto“ anmelden.');
  show(await api('/api/admin/bot'));
  byId('botFeedback').textContent = '';
} catch (error) { byId('botFeedback').textContent = errorText(error); }
