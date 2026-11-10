import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUp, ArrowUpFromLine, CheckCircle2, ChevronRight, CircleAlert, File, Folder, FolderOpen, FolderPlus, Globe, HardDrive, Import, KeyRound, Link, LockKeyhole, Pencil, Plus, RefreshCw, Save, Server, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import './connections.css';

const emptyProfile = () => ({ id: '', name: '', kind: 'sftp', host: '', port: '22', username: '', password: '', remember: true });
const endpoint = profile => profile.kind === 'sftp' ? `${profile.username}@${profile.host}:${profile.port}` : profile.baseUrl;
const humanSize = bytes => !Number.isFinite(bytes) ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const modified = value => value ? new Date(value).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const joinRemote = (parent, name) => `${parent === '/' ? '' : parent.replace(/\/$/, '')}/${name}`;
const parentRemote = value => value && value !== '/' ? value.replace(/\/$/, '').slice(0, value.replace(/\/$/, '').lastIndexOf('/')) || '/' : '/';
function parentLocal(value, root) {
  if (!value || !root || value.toLowerCase() === root.toLowerCase()) return null;
  const clean = value.replace(/[\\/]$/, '');
  const parent = clean.slice(0, Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/')));
  return parent.length < root.length ? root : parent;
}
function useOperation(notify, onError) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false);
  const run = async (label, operation, success) => {
    if (running.current) return;
    running.current = true;
    setBusy(label); setError('');
    try {
      const result = await operation();
      if (success && !result?.canceled) notify?.(success);
      return result;
    } catch (error) {
      setError(error.message || 'Die Aktion konnte nicht abgeschlossen werden.');
      if (onError) { try { await onError(); } catch {} }
    }
    finally { running.current = false; setBusy(''); }
  };
  return { busy, error, run, setError };
}
function ErrorNotice({ error }) { return error ? <div className="notice connections-error" role="alert"><CircleAlert size={18} /><span>{error}</span></div> : null; }

export function ConnectionsPanel({ api, notify, navigate }) {
  const [profiles, setProfiles] = useState([]);
  const [draft, setDraft] = useState(emptyProfile);
  const [loaded, setLoaded] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const { busy, error, run, setError } = useOperation(notify);
  const reload = async () => { const result = await api('connections.list'); setProfiles(result); setLoaded(true); return result; };
  useEffect(() => { let alive = true; api('connections.list').then(result => { if (alive) { setProfiles(result); setLoaded(true); } }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [api]);
  const current = profiles.find(profile => profile.id === draft.id);
  const save = event => {
    event.preventDefault();
    run('Verbindung speichern', async () => {
      const saved = await api('connections.save', { ...draft, id: draft.id || undefined, port: Number(draft.port) });
      setDraft({ ...emptyProfile(), ...saved, password: '' });
      await reload();
      return saved;
    }, 'Verbindung gespeichert. Du kannst sie im Dateimanager auswählen.');
  };
  const edit = profile => { setDraft({ ...emptyProfile(), ...profile, password: '' }); setDeleteId(''); setError(''); };
  const remove = profile => run('Verbindung entfernen', async () => {
    await api('connections.delete', { id: profile.id });
    if (draft.id === profile.id) setDraft(emptyProfile());
    setDeleteId(''); await reload();
  }, 'Gespeicherte Verbindung und Zugangsdaten entfernt.');
  const importProfiles = () => run('WinSCP-Verbindungen importieren', async () => {
    const result = await api('connections.importWinSCP');
    if (!result?.canceled) { await reload(); notify?.(`${result?.count ?? result?.imported ?? 0} WinSCP-Verbindung(en) übernommen. Passwörter kannst du einmalig ergänzen.`); }
    return result;
  });
  return <div className="page-stack connections-page">
    <ErrorNotice error={error} />
    <div className="connections-toolbar"><div><h2>Deine gespeicherten Zugänge</h2><p className="muted">Einmal einrichten. Beim nächsten Mal direkt auswählen.</p></div><button className="btn" disabled={!!busy} onClick={importProfiles}><Import size={17} />Aus WinSCP importieren</button></div>
    <div className="connections-layout">
      <section className="panel connections-saved" aria-labelledby="saved-connections-heading">
        <div className="connections-section-heading"><h3 id="saved-connections-heading">Gespeicherte Verbindungen</h3><span className="muted">{profiles.length} / 100</span></div>
        <div className="connections-profile-list">
          {!loaded ? <div className="empty-state compact"><p>Verbindungen werden geladen …</p></div> : profiles.length === 0 ? <div className="empty-state compact"><KeyRound size={30} /><h3>Noch kein Zugang gespeichert</h3><p>Trage rechts deine SFTP-Daten ein oder importiere deine WinSCP-Verbindungen.</p></div> : profiles.map(profile => <article key={profile.id} className={`connection-profile ${draft.id === profile.id ? 'is-selected' : ''}`}>
            <div className="connection-profile-main"><span className="connection-profile-icon">{profile.kind === 'sftp' ? <Server size={20} /> : <Globe size={20} />}</span><div><strong>{profile.name}</strong><span className="connection-endpoint" title={endpoint(profile)}>{endpoint(profile)}</span><span className="connection-secret-status"><LockKeyhole size={12} />{profile.secretSaved ? 'Zugangsdaten verschlüsselt gespeichert' : profile.hasPassword || profile.hasAccessKey ? 'Zugangsdaten für diese App-Sitzung vorhanden' : 'Zugangsdaten noch nicht gespeichert'}</span></div></div>
            {deleteId === profile.id ? <div className="connection-delete-confirm"><p>„{profile.name}“ von diesem PC entfernen?</p><div><button className="btn" disabled={!!busy} onClick={() => setDeleteId('')}>Abbrechen</button><button className="btn connection-danger" disabled={!!busy} onClick={() => remove(profile)}>Zugang entfernen</button></div></div> : <div className="connection-profile-actions"><span className="connection-kind">{profile.kind === 'sftp' ? 'SFTP' : profile.kind === 'website' ? 'Website-Konto' : 'Kori'}</span>{profile.kind === 'sftp' && <button className="icon-btn" disabled={!!busy} onClick={() => edit(profile)} aria-label={`${profile.name} bearbeiten`} title="Verbindung bearbeiten"><Pencil size={16} /></button>}<button className="icon-btn" disabled={!!busy} onClick={() => setDeleteId(profile.id)} aria-label={`${profile.name} entfernen`} title="Gespeicherten Zugang entfernen"><Trash2 size={16} /></button></div>}
          </article>)}
        </div>
        <div className="connections-list-footer"><ShieldCheck size={18} /><p>Gespeicherte Passwörter und Website-Sitzungen werden über dein Windows-Konto verschlüsselt.</p></div>
      </section>
      <form className="panel connections-form" onSubmit={save}>
        <div className="connections-section-heading"><h3>{draft.id ? 'SFTP-Verbindung bearbeiten' : 'Neue SFTP-Verbindung'}</h3>{draft.id && <button className="text-btn" type="button" disabled={!!busy} onClick={() => { setDraft(emptyProfile()); setError(''); }}><Plus size={14} />Neue Verbindung</button>}</div>
        <div className="connections-form-body"><label className="field">Name der Verbindung<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Zum Beispiel: Mein Website-Server" required disabled={!!busy} /></label>
          <div className="connection-host-port"><label className="field">Serveradresse<input value={draft.host} maxLength={253} autoComplete="off" spellCheck="false" onChange={event => setDraft({ ...draft, host: event.target.value })} placeholder="z. B. crazybatto.de" required disabled={!!busy} /></label><label className="field">Port<input value={draft.port} type="number" min="1" max="65535" onChange={event => setDraft({ ...draft, port: event.target.value })} required disabled={!!busy} /></label></div>
          <label className="field">SFTP-Benutzername<input value={draft.username} maxLength={128} autoComplete="off" spellCheck="false" onChange={event => setDraft({ ...draft, username: event.target.value })} placeholder="Benutzername beim Hoster" required disabled={!!busy} /></label>
          <label className="field">SFTP-Passwort{current?.hasPassword && <span className="field-count">bereits hinterlegt</span>}<input value={draft.password} type="password" maxLength={4096} autoComplete="new-password" onChange={event => setDraft({ ...draft, password: event.target.value })} placeholder={current?.hasPassword ? 'Leer lassen, um das bisherige Passwort zu behalten' : 'Passwort einmalig eingeben'} disabled={!!busy} /></label>
          <label className="checkbox-label connection-remember"><input type="checkbox" checked={draft.remember} disabled={!!busy} onChange={event => setDraft({ ...draft, remember: event.target.checked })} /><span>Zugangsdaten auf diesem PC verschlüsselt merken</span></label>
          <p className="connection-form-hint">{draft.remember ? 'Beim nächsten App-Start kannst du die gespeicherte Verbindung wieder verwenden.' : 'Das Passwort bleibt nur bis zum Schließen der App im Arbeitsspeicher.'}</p>
          {current && <p className="connection-form-hint">Bei einer anderen Serveradresse, einem anderen Port oder Benutzer brauchst du das passende Passwort erneut.</p>}
          <button type="submit" className="btn btn-primary connection-save" disabled={!!busy || !draft.name.trim() || !draft.host.trim() || !draft.username.trim()}><Save size={17} />{busy === 'Verbindung speichern' ? 'Wird gespeichert …' : 'Verbindung speichern'}</button>
          {navigate && <button type="button" className="text-btn connection-file-link" disabled={!!busy} onClick={() => navigate('files')}>Dateimanager öffnen<ChevronRight size={15} /></button>}
        </div>
      </form>
    </div>
    <div className="notice"><Globe size={18} /><span>Dein Website-Konto verbindest du unter „Konto & Bot“. Hier bleiben die gespeicherten Zugänge übersichtlich an einem Ort.</span></div>
  </div>;
}

function FilePane({ side, data, pathValue, setPathValue, connected, busy, selection, select, onOpen, onParent, onRefresh, onChooseFolder, onPathSubmit, onNewFolder }) {
  const local = side === 'local';
  const up = local ? parentLocal(data?.path, data?.root) : data?.path && data.path !== '/';
  return <section className="panel file-pane" aria-label={local ? 'Dateien auf deinem PC' : 'Dateien auf dem Server'}>
    <div className="file-pane-heading"><div>{local ? <HardDrive size={20} /> : <Server size={20} />}<h3>{local ? 'Dein PC' : 'Dein Server'}</h3></div><div><button className="icon-btn" disabled={busy || !up} onClick={onParent} title="Übergeordneter Ordner" aria-label={`${local ? 'PC' : 'Server'}: übergeordneten Ordner öffnen`}><ArrowUp size={17} /></button><button className="icon-btn" disabled={busy || (local ? !data : !connected)} onClick={onRefresh} title="Ordner aktualisieren" aria-label={`${local ? 'PC' : 'Server'}: Ordner aktualisieren`}><RefreshCw size={16} /></button>{!local && <button className="icon-btn" disabled={busy || !connected} onClick={onNewFolder} title="Ordner erstellen" aria-label="Ordner auf dem Server erstellen"><FolderPlus size={18} /></button>}</div></div>
    {local ? <div className="file-path-row"><FolderOpen size={16} /><span title={data?.path}>{data?.path || 'Noch kein lokaler Ordner ausgewählt'}</span><button className="text-btn" disabled={busy} onClick={onChooseFolder}>Ordner wählen</button></div> : <form className="file-path-row" onSubmit={event => { event.preventDefault(); onPathSubmit(); }}><FolderOpen size={16} /><input aria-label="Absoluter Serverpfad" value={pathValue} disabled={busy || !connected} onChange={event => setPathValue(event.target.value)} placeholder="/home/benutzer" spellCheck="false" /><button type="submit" className="icon-btn" disabled={busy || !connected || !pathValue.startsWith('/')} aria-label="Serverpfad öffnen"><ChevronRight size={18} /></button></form>}
    <div className="file-table-scroll">
      {!data ? <div className="file-pane-empty">{local ? <FolderOpen size={38} /> : <Server size={38} />}<h3>{local ? 'Deine Dateien' : connected ? 'Bereit zum Durchsehen' : 'Noch nicht verbunden'}</h3><p>{local ? 'Wähle einen Ordner auf deinem PC, um deine Dateien anzuzeigen.' : connected ? 'Lade den Serverordner, um Dateien und Unterordner anzuzeigen.' : 'Wähle oben eine gespeicherte SFTP-Verbindung aus.'}</p>{local ? <button className="btn" disabled={busy} onClick={onChooseFolder}><FolderOpen size={16} />Ordner auswählen</button> : connected && <button className="btn" disabled={busy} onClick={onRefresh}>Serverordner laden</button>}</div> : data.entries.length === 0 ? <div className="file-pane-empty"><Folder size={35} /><h3>Dieser Ordner ist leer</h3><p>{local ? 'Wähle einen anderen Ordner oder lade eine Datei vom Server herunter.' : 'Du kannst hier eine Datei hochladen oder einen Unterordner anlegen.'}</p></div> : <table className="file-table"><thead><tr><th scope="col">Name</th><th scope="col">Größe</th><th scope="col">Geändert</th></tr></thead><tbody>{data.entries.map(entry => <tr key={entry.name} className={selection?.name === entry.name ? 'selected' : ''} onClick={() => !busy && select(entry)}><td><button disabled={busy} className="file-entry-button" onClick={event => { event.stopPropagation(); entry.type === 'directory' ? onOpen(entry) : select(entry); }} aria-pressed={entry.type === 'file' ? selection?.name === entry.name : undefined} title={entry.type === 'directory' ? `${entry.name} öffnen` : entry.name}>{entry.type === 'directory' ? <Folder size={17} /> : entry.type === 'link' ? <Link size={16} /> : <File size={16} />}<span>{entry.name}</span>{entry.type === 'directory' && <ChevronRight size={13} className="file-entry-arrow" />}</button></td><td>{entry.type === 'directory' ? 'Ordner' : entry.type === 'link' ? 'Link' : humanSize(entry.size)}</td><td>{modified(entry.modifiedAt)}</td></tr>)}</tbody></table>}
    </div>
    <div className="file-pane-footer"><span>{data ? `${data.entries.length} Einträge${data.truncated ? ' · Anzeige auf 2.000 begrenzt' : ''}` : 'Keine Dateien geladen'}</span><span>{selection ? selection.name : 'Keine Datei ausgewählt'}</span></div>
  </section>;
}

export function FileManager({ api, notify, navigate }) {
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [connection, setConnection] = useState({ connected: false, profileId: null, path: '/' });
  const [password, setPassword] = useState('');
  const [local, setLocal] = useState(null), [remote, setRemote] = useState(null);
  const [localSelection, setLocalSelection] = useState(null), [remoteSelection, setRemoteSelection] = useState(null);
  const [serverPath, setServerPath] = useState('/');
  const [folderName, setFolderName] = useState(''), [showFolder, setShowFolder] = useState(false);
  const [transfers, setTransfers] = useState([]);
  const { busy, error, run, setError } = useOperation(notify, async () => {
    const state = await api('files.state');
    setConnection(state);
    if (!state.connected) { setRemote(null); setRemoteSelection(null); setShowFolder(false); }
  });
  useEffect(() => {
    let alive = true;
    Promise.all([api('connections.list'), api('files.state')]).then(([saved, state]) => {
      if (!alive) return;
      const sftp = saved.filter(profile => profile.kind === 'sftp'); setProfiles(sftp); setConnection(state);
      setProfileId(state.profileId || sftp[0]?.id || ''); setServerPath(state.path || '/');
    }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [api]);
  const selectedProfile = profiles.find(profile => profile.id === profileId);
  const connectedProfile = profiles.find(profile => profile.id === connection.profileId);
  const loadRemote = async target => {
    const result = await api('files.list', { path: target || remote?.path || connection.path || '/' });
    setRemote(result); setConnection({ connected: result.connected, profileId: result.profileId, path: result.path }); setServerPath(result.path); setRemoteSelection(null); return result;
  };
  const loadLocal = async target => { const result = await api('files.localList', { path: target || local?.path }); setLocal(result); setLocalSelection(null); return result; };
  const chooseFolder = () => run('Ordner auswählen', async () => { const result = await api('files.chooseLocalFolder'); if (!result.canceled) { setLocal(result); setLocalSelection(null); } return result; });
  const connect = event => { event.preventDefault(); run('Server verbinden', async () => {
    const result = await api('files.connect', { profileId, password });
    setPassword(''); setConnection(result); setServerPath(result.path); setRemote(null); setRemoteSelection(null); setShowFolder(false);
    return result;
  }, 'SFTP-Verbindung hergestellt. Du kannst jetzt den Serverordner laden.'); };
  const disconnect = () => run('Verbindung trennen', async () => { const result = await api('files.disconnect'); setConnection(result); setRemote(null); setRemoteSelection(null); setPassword(''); setShowFolder(false); }, 'SFTP-Verbindung getrennt.');
  const record = (result, direction) => { if (result?.completed) setTransfers(items => [{ name: result.name, direction, time: Date.now() }, ...items].slice(0, 5)); };
  const upload = () => run('Datei hochladen', async () => {
    const result = await api('files.upload', { remotePath: remote?.path || connection.path, ...(localSelection?.type === 'file' ? { localPath: localSelection.path } : {}) });
    if (result.completed) { record(result, 'upload'); notify?.(`„${result.name}“ wurde hochgeladen.`); await loadRemote(); }
    return result;
  });
  const download = () => run('Datei herunterladen', async () => {
    const result = await api('files.download', { remotePath: joinRemote(remote.path, remoteSelection.name), ...(local?.path ? { localDirectory: local.path } : {}) });
    if (result.completed) { record(result, 'download'); notify?.(`„${result.name}“ wurde heruntergeladen.`); if (local?.path) await loadLocal(); }
    return result;
  });
  const makeFolder = event => { event.preventDefault(); run('Serverordner erstellen', async () => { const result = await api('files.mkdir', { parent: remote?.path || connection.path, name: folderName }); setFolderName(''); setShowFolder(false); await loadRemote(); return result; }, 'Ordner auf dem Server erstellt.'); };
  const action = operation => run('Ordner laden', operation);
  return <div className="page-stack connections-page file-manager">
    <ErrorNotice error={error} />
    <form className="panel file-connection-bar" onSubmit={connect}><div className="file-connection-icon"><Server size={24} /></div><label className="field">Gespeicherte SFTP-Verbindung<select value={profileId} onChange={event => { setProfileId(event.target.value); setPassword(''); }} disabled={!!busy || connection.connected}><option value="">Verbindung auswählen</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.host}</option>)}</select></label>{selectedProfile && !selectedProfile.hasPassword && !connection.connected && <label className="field file-session-password">Passwort für diese Verbindung<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={!!busy} /></label>}{connection.connected ? <><span className="file-connected"><CheckCircle2 size={15} />Verbunden</span><button className="btn" type="button" disabled={!!busy} onClick={disconnect}><Unplug size={16} />Trennen</button></> : <button className="btn btn-primary" type="submit" disabled={!!busy || !profileId || (!selectedProfile?.hasPassword && !password)}><Link size={16} />{busy === 'Server verbinden' ? 'Verbindet …' : 'Verbinden'}</button>}<button className="text-btn" type="button" disabled={!!busy} onClick={() => navigate?.('connections')}>Zugänge verwalten<ChevronRight size={14} /></button></form>
    <div className="file-transfer-toolbar"><div><h2>Dateien übertragen</h2><p className="muted">{connection.connected ? `${connectedProfile?.name || 'SFTP-Server'} · ${connectedProfile?.host || ''}` : 'Wähle einen lokalen Ordner und verbinde deinen Server.'}</p></div><div className="file-transfer-buttons"><button className="btn" disabled={!!busy || !connection.connected} onClick={upload} title={localSelection?.type === 'file' ? localSelection.name : 'Eine Datei zum Hochladen auswählen'}><ArrowUpFromLine size={17} />{localSelection?.type === 'file' ? 'Auswahl hochladen' : 'Datei hochladen'}</button><button className="btn btn-primary" disabled={!!busy || !connection.connected || remoteSelection?.type !== 'file'} onClick={download}><ArrowDownToLine size={17} />Herunterladen</button></div></div>
    {showFolder && <form className="notice file-new-folder" onSubmit={makeFolder}><FolderPlus size={18} /><label htmlFor="remote-new-folder">Neuer Serverordner</label><input id="remote-new-folder" value={folderName} maxLength={255} autoFocus onChange={event => setFolderName(event.target.value)} placeholder="Ordnername" disabled={!!busy} /><button className="btn btn-primary" type="submit" disabled={!!busy || !folderName.trim()}>Erstellen</button><button className="icon-btn" type="button" disabled={!!busy} aria-label="Ordnererstellung schließen" onClick={() => setShowFolder(false)}><X size={17} /></button></form>}
    <div className="file-panes"><FilePane side="local" data={local} busy={!!busy} selection={localSelection} select={setLocalSelection} onChooseFolder={chooseFolder} onRefresh={() => action(() => loadLocal())} onParent={() => action(() => loadLocal(parentLocal(local.path, local.root)))} onOpen={entry => action(() => loadLocal(entry.path))} /><FilePane side="remote" data={remote} pathValue={serverPath} setPathValue={setServerPath} connected={connection.connected} busy={!!busy} selection={remoteSelection} select={setRemoteSelection} onRefresh={() => action(() => loadRemote())} onPathSubmit={() => action(() => loadRemote(serverPath))} onParent={() => action(() => loadRemote(parentRemote(remote.path)))} onOpen={entry => action(() => loadRemote(joinRemote(remote.path, entry.name)))} onNewFolder={() => setShowFolder(value => !value)} /></div>
    <div className={`file-operation-status ${busy ? 'is-busy' : ''}`} role="status" aria-live="polite">{busy ? <><RefreshCw size={15} className="connection-spin" /><span>{busy} … Bitte kurz warten.</span></> : <><ShieldCheck size={16} /><span>Verschlüsselte SFTP-Übertragung · Einzelne Dateien bis 128 MB · Überschreiben nur nach Bestätigung</span></>}</div>
    {transfers.length > 0 && <section className="panel file-transfers" aria-labelledby="file-transfers-heading"><h3 id="file-transfers-heading">Letzte Übertragungen dieser Ansicht</h3>{transfers.map((item, index) => <div key={`${item.time}-${index}`}>{item.direction === 'upload' ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}<span>{item.name}</span><small>{item.direction === 'upload' ? 'Hochgeladen' : 'Heruntergeladen'}</small><CheckCircle2 size={15} /></div>)}</section>}
  </div>;
}
