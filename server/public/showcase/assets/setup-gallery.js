import { api, getSession, errorText } from './account-client.js';

const root = document.querySelector('.cb-editable-setups');
const slots = ['gaming-hero', 'gaming-gallery', 'old-start', 'old-upgrade', 'old-cooling'];
const titles = { 'gaming-hero': 'Mein Gaming-Setup', 'gaming-gallery': 'Gaming-Galerie', 'old-start': 'Der Anfang · 2022', 'old-upgrade': 'Mein damaliges Setup', 'old-cooling': 'Mein GPU-Umbau' };
const maxFile = 8 * 1024 * 1024, maxLegacyFile = 20 * 1024 * 1024, maxLibrary = 100 * 1024 * 1024;
const types = new Set(['image/jpeg', 'image/png', 'image/webp']);
const find = name => root.querySelector(`[data-photo-${name}]`);
const editors = [...root.querySelectorAll('[data-photo-slot]')].map(element => ({ element, slot: element.dataset.photoSlot, selected: null, find: name => element.querySelector(`[data-photo-${name}]`) }));
let records = new Map(slots.map(slot => [slot, { slot, revision: 0, images: [] }]));
let storage = null, loaded = false, admin = false, busy = true;
let browserRecords = [], candidates = [], migrationUrls = [];
const selectedCandidates = new Set();

function status(element, text, error = false) { element.textContent = text; element.dataset.error = String(error); }
function canEdit() { return admin && loaded && storage?.online === true; }
function storageMessage() {
  if (!storage) return 'Der NAS-Status konnte nicht geladen werden.';
  if (!storage.configured) return 'Der NAS-Bildspeicher ist noch nicht eingerichtet.';
  return storage.online ? 'Bilder vom NAS geladen.' : 'Der NAS-Bildspeicher ist gerade nicht erreichbar. Bilder können momentan nicht geladen oder geändert werden.';
}
function imageUrl(item) {
  if (!item || !/^gallery_[a-f0-9]{64}$/.test(item.id) || item.url !== '/api/setup/images/' + item.id) throw new Error('Der Server hat einen ungültigen Bildverweis geliefert.');
  return item.url;
}
function recordFrom(value) {
  if (!value || !slots.includes(value.slot) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.images)) throw new Error('Die Galerieantwort ist unvollständig. Bitte erneut laden.');
  const images = value.images.map(item => { imageUrl(item); if (typeof item.name !== 'string' || typeof item.caption !== 'string') throw new Error('Die Bildangaben konnten nicht gelesen werden.'); return { ...item }; });
  return { slot: value.slot, revision: value.revision, images };
}
function render(editor) {
  const row = records.get(editor.slot), current = row.images.find(item => item.id === editor.selected) || row.images[0];
  editor.selected = current?.id || null;
  editor.find('empty').hidden = Boolean(current);
  editor.find('empty').querySelector('p').textContent = !loaded ? 'Die Bilder konnten noch nicht geladen werden.' : 'Hier sind noch keine Setup-Bilder veröffentlicht.';
  editor.find('preview').hidden = !current;
  editor.find('actions').hidden = !current || !admin;
  editor.find('form').hidden = !current || !admin;
  editor.element.querySelectorAll('[data-photo-add]').forEach(button => { button.hidden = !admin; });
  const image = editor.find('image');
  let unavailable = editor.element.querySelector('.cb-photo-unavailable');
  if (!unavailable) {
    unavailable = document.createElement('p'); unavailable.className = 'cb-photo-unavailable'; unavailable.setAttribute('role', 'status'); image.after(unavailable);
    image.addEventListener('error', () => { image.hidden = true; unavailable.hidden = false; unavailable.textContent = 'Dieses Bild konnte nicht vom NAS geladen werden. Bitte die Galerie aktualisieren.'; });
  }
  image.hidden = storage?.online !== true; unavailable.hidden = storage?.online === true;
  unavailable.textContent = 'Das Bild liegt auf dem NAS. Der Speicher ist gerade nicht erreichbar.';
  if (current) {
    if (storage?.online === true) image.src = imageUrl(current); else image.removeAttribute('src');
    image.alt = current.caption || current.name;
    editor.find('caption').textContent = current.caption || current.name;
    editor.find('count').textContent = editor.slot === 'gaming-gallery' ? `${row.images.indexOf(current) + 1} / ${row.images.length}` : '';
    editor.find('description').value = current.caption;
  } else image.removeAttribute('src');
  const thumbs = editor.find('thumbs'); thumbs.replaceChildren(); thumbs.hidden = editor.slot !== 'gaming-gallery' || row.images.length < 2;
  if (!thumbs.hidden) row.images.forEach((item, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', `Bild ${index + 1}: ${item.caption || item.name}`); button.setAttribute('aria-pressed', String(item.id === current.id));
    if (storage?.online) { const thumbnail = document.createElement('img'); thumbnail.src = imageUrl(item); thumbnail.alt = ''; thumbnail.loading = 'lazy'; button.append(thumbnail); } else button.textContent = String(index + 1);
    button.addEventListener('click', () => { if (!busy) { editor.selected = item.id; render(editor); setBusy(false); thumbs.children[index]?.focus(); } }); thumbs.append(button);
  });
}
function setBusy(value) {
  busy = value;
  for (const editor of editors) {
    editor.element.setAttribute('aria-busy', String(value));
    editor.element.querySelectorAll('button,input').forEach(node => { node.disabled = value || !canEdit(); });
    editor.find('thumbs').querySelectorAll('button').forEach(node => { node.disabled = value; });
    const row = records.get(editor.slot), index = row.images.findIndex(item => item.id === editor.selected);
    editor.find('earlier').disabled = value || !canEdit() || index <= 0;
    editor.find('later').disabled = value || !canEdit() || index < 0 || index >= row.images.length - 1;
  }
  find('refresh').disabled = value; find('migration').hidden = !admin && !browserRecords.some(row => row.images?.length);
  find('migration').querySelectorAll('button,input').forEach(node => { node.disabled = value || !admin; });
  find('migration-list').querySelectorAll('input').forEach(node => { node.disabled = value || !admin || node.dataset.invalid === 'true'; });
  find('migrate').disabled = value || !canEdit() || !selectedCandidates.size;
  find('export').disabled = value || !browserRecords.some(row => row.images?.length);
  find('local').disabled = value || !browserRecords.some(row => row.images?.length);
  find('account').hidden = admin;
}
async function loadGallery() {
  const result = await api('/api/setup/slots');
  if (!Array.isArray(result.slots) || result.slots.length !== slots.length) throw new Error('Die Bildbereiche konnten nicht vollständig geladen werden.');
  const incoming = result.slots.map(recordFrom);
  if (new Set(incoming.map(row => row.slot)).size !== slots.length) throw new Error('Die Bildbereiche sind unvollständig.');
  records = new Map(incoming.map(row => [row.slot, row])); storage = result.storage; loaded = true;
  editors.forEach(render); status(find('library-status'), storageMessage(), storage?.online !== true);
}
async function loadAccount() {
  try {
    const session = await getSession(); admin = Boolean(session.user?.isAdmin && session.user.confirmed && !session.user.suspended);
    status(find('access-status'), admin ? 'Als Administrator kannst du Bilder auf dem NAS speichern. Änderungen sind sofort für alle sichtbar. JPG, PNG oder WebP · ohne Animation · bis 8 MiB pro Bild.' : 'Die Galerie ist öffentlich. Bilder bearbeiten und auf das NAS übernehmen kann das Administratorkonto.');
  } catch (error) { admin = false; status(find('access-status'), 'Die Administrator-Anmeldung konnte nicht geprüft werden. ' + errorText(error), true); }
}
async function operate(target, action) {
  if (busy) return;
  if (!canEdit()) { status(target, admin ? storageMessage() : 'Bitte mit deinem Administratorkonto anmelden.', true); return; }
  setBusy(true);
  try { await action(); }
  catch (error) {
    if ([401, 403].includes(error.status)) { await loadAccount(); editors.forEach(render); }
    if (error.status === 409) await loadGallery().catch(() => {});
    status(target, errorText(error), true);
  } finally { setBusy(false); }
}
function fileIssue(file) {
  if (!(file instanceof Blob) || !file.size) return 'Keine lesbare Bilddatei.';
  if (!types.has(file.type)) return 'Nur JPG, PNG oder WebP können auf das NAS übernommen werden. GIF und AVIF bleiben lokal.';
  if (file.size > maxFile) return 'Größer als 8 MiB. Bitte zuerst eine kleinere Bilddatei erstellen; das Original bleibt erhalten.';
  return '';
}
async function upload(file, name) {
  const issue = fileIssue(file); if (issue) throw new Error(`${name}: ${issue}`);
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\\/:\x00-\x1f\x7f]/.test(name)) throw new Error('Bitte dem Bild einen Dateinamen mit höchstens 160 Zeichen ohne Ordnerpfad oder Doppelpunkt geben.');
  const result = await api('/api/admin/setup/images', { method: 'POST', raw: true, body: file, timeout: 120000, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(name) } });
  imageUrl(result.image); return result.image;
}
async function saveSlot(slot, images) {
  const previous = records.get(slot);
  if (images.length > (slot === 'gaming-gallery' ? 50 : 1)) throw new Error('Die Galerie bietet Platz für 50 Bilder, jeder andere Bildbereich für ein Bild.');
  const result = await api('/api/admin/setup/slots/' + slot, { method: 'PATCH', body: { expectedRevision: previous.revision, images: images.map(item => ({ id: item.id, caption: item.caption || '' })) } });
  const saved = recordFrom(result.slot);
  if (saved.slot !== slot) throw new Error('Der Server hat einen anderen Bildbereich bestätigt. Bitte die Galerie aktualisieren.');
  records.set(slot, saved); editors.filter(editor => editor.slot === slot).forEach(render);
  let cleanupPending = false;
  for (const item of previous.images.filter(item => !saved.images.some(image => image.id === item.id))) {
    if ([...records.values()].some(row => row.images.some(image => image.id === item.id))) continue;
    try { await api('/api/admin/setup/images/' + item.id, { method: 'DELETE' }); }
    catch (error) { if (error.status !== 409) cleanupPending = true; }
  }
  return cleanupPending ? ' Der bisherige Upload konnte noch nicht in den NAS-Papierkorb verschoben werden.' : '';
}
for (const editor of editors) {
  const feedback = editor.find('status');
  editor.element.querySelectorAll('[data-photo-add]').forEach(button => button.addEventListener('click', () => editor.find('files').click()));
  editor.find('replace').addEventListener('click', () => editor.find('replacement').click());
  for (const mode of ['files', 'replacement']) editor.find(mode).addEventListener('change', event => {
    const files = [...event.target.files]; event.target.value = ''; if (!files.length) return;
    void operate(feedback, async () => {
      let images = records.get(editor.slot).images.slice();
      const replacing = editor.slot !== 'gaming-gallery' || mode === 'replacement';
      if (replacing && files.length > 1) throw new Error('Bitte für diesen Bildbereich genau ein Bild auswählen.');
      if (!replacing && images.length + files.length > 50) throw new Error('Die Galerie bietet Platz für höchstens 50 Bilder.');
      for (const file of files) { const issue = fileIssue(file); if (issue) throw new Error(`${file.name}: ${issue}`); }
      const incoming = [];
      for (let i = 0; i < files.length; i++) { status(feedback, `Bild ${i + 1} von ${files.length} wird auf dem NAS gespeichert …`); incoming.push(await upload(files[i], files[i].name)); }
      if (editor.slot !== 'gaming-gallery') images = incoming;
      else if (mode === 'replacement') images = images.map(item => item.id === editor.selected ? incoming[0] : item);
      else images.push(...incoming);
      images = images.filter((item, index) => images.findIndex(other => other.id === item.id) === index);
      editor.selected = incoming[0].id;
      const cleanup = await saveSlot(editor.slot, images);
      status(feedback, 'Auf dem NAS gespeichert und für alle Besucher sichtbar.' + cleanup);
    });
  });
  editor.find('form').addEventListener('submit', event => {
    event.preventDefault(); const caption = editor.find('description').value.trim().slice(0, 200);
    void operate(feedback, async () => { await saveSlot(editor.slot, records.get(editor.slot).images.map(item => item.id === editor.selected ? { ...item, caption } : item)); status(feedback, 'Bildunterschrift für alle Besucher gespeichert.'); });
  });
  editor.find('remove').addEventListener('click', () => {
    if (busy || !canEdit() || !confirm('Dieses Bild aus der öffentlichen Galerie entfernen? Die Originaldatei und frühere Browserbilder bleiben erhalten.')) return;
    void operate(feedback, async () => { const cleanup = await saveSlot(editor.slot, records.get(editor.slot).images.filter(item => item.id !== editor.selected)); status(feedback, 'Bild aus der Galerie entfernt.' + cleanup); });
  });
  for (const [name, offset] of [['earlier', -1], ['later', 1]]) editor.find(name).addEventListener('click', () => void operate(feedback, async () => {
    const images = records.get(editor.slot).images.slice(), index = images.findIndex(item => item.id === editor.selected);
    if (index < 0 || index + offset < 0 || index + offset >= images.length) return;
    [images[index], images[index + offset]] = [images[index + offset], images[index]];
    await saveSlot(editor.slot, images); status(feedback, 'Reihenfolge für alle Besucher gespeichert.');
  }));
}

// Read the old browser library without upgrading, writing or deleting records.
function readBrowserImages() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('crazy-batto-setup-images'); let absent = false;
    request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
    request.onerror = () => absent ? resolve([]) : reject(new Error('Die früheren Browserbilder konnten nicht gelesen werden. Sie wurden nicht verändert.'));
    request.onblocked = () => reject(new Error('Bitte andere Setup-Tabs schließen, um die früheren Browserbilder zu lesen.'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('slots')) { db.close(); resolve([]); return; }
      const transaction = db.transaction('slots', 'readonly'), all = transaction.objectStore('slots').getAll();
      transaction.oncomplete = () => { db.close(); resolve(all.result.filter(row => slots.includes(row.slot) && Array.isArray(row.images))); };
      transaction.onabort = () => { db.close(); reject(new Error('Die früheren Browserbilder konnten nicht gelesen werden.')); };
    };
  });
}
function renderCandidates(sourceRecords, source) {
  migrationUrls.forEach(url => URL.revokeObjectURL(url)); migrationUrls = []; candidates = []; selectedCandidates.clear();
  const list = find('migration-list'); list.replaceChildren();
  for (const row of sourceRecords) for (const item of row.images) {
    const candidate = { ...item, slot: row.slot, key: candidates.length, source }, issue = fileIssue(item.file); candidates.push(candidate);
    const label = document.createElement('label'); label.className = 'cb-photo-migration-item';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.invalid = String(Boolean(issue)); checkbox.disabled = Boolean(issue); checkbox.dataset.candidate = String(candidate.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (candidate.slot !== 'gaming-gallery') for (const key of selectedCandidates) if (candidates[key].slot === candidate.slot) { selectedCandidates.delete(key); list.querySelector(`[data-candidate="${key}"]`).checked = false; }
        selectedCandidates.add(candidate.key);
      } else selectedCandidates.delete(candidate.key);
      setBusy(busy);
    });
    label.append(checkbox);
    if (item.file instanceof Blob && item.file.type.startsWith('image/')) { const image = document.createElement('img'), url = URL.createObjectURL(item.file); migrationUrls.push(url); image.src = url; image.alt = ''; image.loading = 'lazy'; label.append(image); }
    const copy = document.createElement('span'), heading = document.createElement('strong'), detail = document.createElement('small');
    heading.textContent = item.caption || item.name || 'Bild'; detail.textContent = `${titles[row.slot]} · ${source} · ${((item.file?.size || 0) / 1024 / 1024).toFixed(1)} MiB`; copy.append(heading, detail);
    if (issue) { const warning = document.createElement('small'); warning.className = 'cb-photo-migration-warning'; warning.textContent = issue; copy.append(warning); }
    label.append(copy); list.append(label);
  }
  status(find('migration-status'), candidates.length ? `${candidates.length} Bild${candidates.length === 1 ? '' : 'er'} gefunden. Wähle aus, welche Bilder du veröffentlichen möchtest.` : 'In diesem Browser wurden keine früheren Setup-Bilder gefunden. Du kannst ein gespeichertes Bilderpaket auswählen.');
  setBusy(busy);
}
find('migrate').addEventListener('click', () => {
  if (busy || !canEdit() || !selectedCandidates.size) return;
  const selected = [...selectedCandidates].map(key => candidates[key]);
  const replaced = [...new Set(selected.map(item => item.slot))].filter(slot => slot !== 'gaming-gallery' && records.get(slot).images.length);
  const detail = replaced.length ? ` Vorhandene Bilder in ${replaced.map(slot => titles[slot]).join(', ')} werden ersetzt.` : '';
  if (!confirm(`${selected.length} ausgewählte Bilder auf dem NAS speichern und für alle Besucher veröffentlichen?${detail} Die Browserbilder bleiben erhalten.`)) return;
  void operate(find('migration-status'), async () => {
    let confirmed = 0, cleanup = '';
    try {
      for (const slot of slots) {
        const group = selected.filter(item => item.slot === slot); if (!group.length) continue;
        let images = slot === 'gaming-gallery' ? records.get(slot).images.slice() : [];
        if (images.length + group.length > (slot === 'gaming-gallery' ? 50 : 1)) throw new Error(`${titles[slot]}: zu viele Bilder. Bitte eine kleinere Auswahl übernehmen.`);
        for (const item of group) {
          status(find('migration-status'), `${titles[slot]}: ${item.name} wird auf dem NAS gespeichert …`);
          const uploaded = await upload(item.file, item.name);
          if (!images.some(existing => existing.id === uploaded.id)) images.push({ ...uploaded, caption: String(item.caption || '').slice(0, 200) });
        }
        cleanup = (await saveSlot(slot, images)) || cleanup; confirmed += group.length;
        for (const item of group) { selectedCandidates.delete(item.key); const checkbox = find('migration-list').querySelector(`[data-candidate="${item.key}"]`); if (checkbox) checkbox.checked = false; }
      }
      status(find('migration-status'), `${confirmed} ausgewählte Bilder sind auf dem NAS gespeichert und öffentlich sichtbar. Bereits vorhandene identische Bilder wurden nicht doppelt eingefügt. Die Browserbilder bleiben erhalten.` + cleanup);
    } catch (error) {
      error.message = `${confirmed} ausgewählte Bilder wurden bereits bestätigt. ${errorText(error)} Die verbleibende Auswahl ist erhalten; bitte aktualisieren und erneut übernehmen. Deine Browserbilder wurden nicht verändert.`;
      throw error;
    }
  });
});
function dataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Ein Browserbild konnte nicht gesichert werden.')); reader.readAsDataURL(file); }); }
find('local').addEventListener('click', () => { if (!busy) renderCandidates(browserRecords, 'Dieser Browser'); });
find('export').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try {
    const packed = [];
    for (const row of browserRecords) { const images = []; for (const item of row.images) images.push({ name: item.name, caption: item.caption || '', dataUrl: await dataUrl(item.file) }); packed.push({ slot: row.slot, images }); }
    const blob = new Blob([JSON.stringify({ format: 'crazy-batto-setup-images', version: 1, exportedAt: new Date().toISOString(), slots: packed })], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'Crazy_Batto-Setup-Bilder.json'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); status(find('migration-status'), 'Download deiner Browserbilder gestartet. Dieses Paket enthält die ursprünglichen lokalen Bilder.');
  } catch (error) { status(find('migration-status'), errorText(error), true); } finally { setBusy(false); }
});
find('import').addEventListener('click', () => find('import-file').click());
find('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file || busy || !admin) return; setBusy(true);
  try {
    if (file.size > 145 * 1024 * 1024) throw new Error('Das Bilderpaket darf höchstens 145 MiB groß sein.');
    const content = JSON.parse(await file.text());
    if (content?.format !== 'crazy-batto-setup-images' || content.version !== 1 || !Array.isArray(content.slots) || content.slots.length > slots.length) throw new Error('Bitte ein zuvor gespeichertes Crazy_Batto-Bilderpaket auswählen.');
    const seen = new Set(), imported = []; let bytes = 0;
    for (const row of content.slots) {
      if (!slots.includes(row?.slot) || seen.has(row.slot) || !Array.isArray(row.images) || row.images.length > (row.slot === 'gaming-gallery' ? 50 : 1)) throw new Error('Das Bilderpaket enthält ungültige Bildbereiche.');
      seen.add(row.slot); const images = [];
      for (const item of row.images) {
        if (typeof item?.name !== 'string' || typeof item.caption !== 'string' || typeof item.dataUrl !== 'string') throw new Error('Das Bilderpaket enthält ungültige Bildangaben.');
        const match = /^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/=]+)$/.exec(item.dataUrl);
        if (!match || match[2].length > Math.ceil(maxLegacyFile / 3) * 4) throw new Error('Das Paket enthält eine ungültige Bilddatei oder ein Bild über 20 MiB.');
        const decoded = atob(match[2]); bytes += decoded.length; if (bytes > maxLibrary) throw new Error('Das Bilderpaket enthält mehr als 100 MiB Bilddaten.');
        images.push({ name: item.name.slice(0, 200), caption: item.caption.slice(0, 200), file: new Blob([Uint8Array.from(decoded, character => character.charCodeAt(0))], { type: match[1] }) });
      }
      imported.push({ slot: row.slot, images });
    }
    renderCandidates(imported, 'Bilderpaket'); find('migration').open = true;
  } catch (error) { status(find('migration-status'), error instanceof SyntaxError ? 'Die Datei ist kein gültiges Bilderpaket.' : errorText(error), true); } finally { setBusy(false); }
});
find('refresh').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  await Promise.all([loadGallery().catch(error => { storage = null; editors.forEach(render); status(find('library-status'), errorText(error), true); }), loadAccount()]);
  editors.forEach(render); setBusy(false);
});
setBusy(true);
await Promise.all([
  loadGallery().catch(error => { editors.forEach(render); status(find('library-status'), errorText(error), true); }), loadAccount(),
  readBrowserImages().then(rows => { browserRecords = rows; renderCandidates(rows, 'Dieser Browser'); }).catch(error => status(find('migration-status'), errorText(error), true))
]);
editors.forEach(render); setBusy(false);
window.addEventListener('pagehide', event => { if (!event.persisted) migrationUrls.forEach(url => URL.revokeObjectURL(url)); });
