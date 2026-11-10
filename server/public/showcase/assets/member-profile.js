import { api, getSession, errorText } from './account-client.js';
const $ = id => document.getElementById(id);
let profile;
function message(text, error = false) { $('profileFeedback').textContent = text; $('profileFeedback').classList.toggle('is-error', error); }
function render(value) {
  profile = value;
  const [year = '', month = '', day = ''] = value.birthDate.split('-');
  $('birthDay').value = day ? String(Number(day)) : ''; $('birthMonth').value = month ? String(Number(month)) : ''; $('birthYear').value = year;
  $('profileRequired').hidden = value.complete;
  $('profileAvatar').hidden = !value.avatarUrl;
  if (value.avatarUrl) $('profileAvatar').src = value.avatarUrl;
  else $('profileAvatar').removeAttribute('src');
  $('removeAvatar').disabled = !value.avatarUrl;
}
function lock(value) { $('profilePanel').querySelectorAll('button,input,select').forEach(el => { el.disabled = value; }); if (!value) $('removeAvatar').disabled = !profile?.avatarUrl; }
$('profileForm').addEventListener('submit', async event => {
  event.preventDefault(); if (!event.currentTarget.reportValidity()) return;
  const birthDate = `${$('birthYear').value.padStart(4, '0')}-${$('birthMonth').value.padStart(2, '0')}-${$('birthDay').value.padStart(2, '0')}`;
  lock(true);
  try { render((await api('/api/account/profile', { method: 'PUT', body: { birthDate } })).profile); message('Dein Profil wurde gespeichert.'); }
  catch (error) { message(errorText(error), true); } finally { lock(false); }
});
$('avatarForm').addEventListener('submit', async event => {
  event.preventDefault(); const file = $('avatarFile').files[0];
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { message('Bitte ein JPG-, PNG- oder WebP-Bild bis 2 MB auswählen.', true); return; }
  lock(true); message('Dein Profilbild wird gespeichert …');
  try { render((await api('/api/account/profile/avatar', { method: 'PUT', body: file, raw: true, timeout: 150000, headers: { 'Content-Type': file.type } })).profile); $('avatarFile').value = ''; message('Dein Profilbild wurde gespeichert.'); }
  catch (error) { message(errorText(error), true); } finally { lock(false); }
});
$('removeAvatar').addEventListener('click', async () => {
  lock(true);
  try { render((await api('/api/account/profile/avatar', { method: 'DELETE' })).profile); message('Dein Profilbild wurde entfernt.'); }
  catch (error) { message(errorText(error), true); } finally { lock(false); }
});
try {
  const session = await getSession();
  if (!session.user) { $('profileLogin').hidden = false; message('Melde dich an, um dein persönliches Profil zu bearbeiten.'); }
  else { $('profileUser').textContent = session.user.name; render((await api('/api/account/profile')).profile); $('profilePanel').hidden = false; message(profile.complete ? 'Hier kannst du dein Profil bearbeiten.' : 'Ergänze bitte dein Geburtsdatum. Dein Profilbild ist freiwillig.'); }
} catch (error) { message(errorText(error), true); }
