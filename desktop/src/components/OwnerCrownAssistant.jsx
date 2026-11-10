import React, {useEffect, useRef, useState} from 'react';
import {Check, Copy, Crown, ExternalLink, Info, RefreshCw} from 'lucide-react';
import {checkedOwner, ownerNicknameError, ownerNicknameSuggestion, ownerTextChannels, ownerVerification} from './owner-crown-assistant.mjs';

export default function OwnerCrownAssistant({api, guildId, guildData, headingRef, onOwnerUpdated, refresh}) {
  const ownerId = guildData?.guild?.id === guildId ? guildData.guild.owner_id : null;
  const [owner, setOwner] = useState(null), [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [copiedName, setCopiedName] = useState(''), [opened, setOpened] = useState(false);
  const [verification, setVerification] = useState(null), [channelChoice, setChannelChoice] = useState('');
  const alive = useRef(false), generation = useRef(0), initialized = useRef(false);
  const channels = ownerTextChannels(guildData, guildId);
  const defaultChannel = channels.find(channel => channel.id === guildData?.guild?.system_channel_id) || channels[0];
  const channelId = channels.some(channel => channel.id === channelChoice) ? channelChoice : defaultChannel?.id || '';
  const nameError = ownerNicknameError(nickname), proposedName = nickname.trim();
  const currentVerification = verification?.requestedNickname === proposedName ? verification : null;
  const pending = loading || !!busy;

  const load = async (verify = false) => {
    if (!/^\d{17,20}$/.test(ownerId || '')) return;
    const request = ++generation.current;
    const proposedAtStart = nickname;
    setLoading(true); setError(''); setVerification(null);
    try {
      const result = await api('admincrown.lookup', {guildId, userId: ownerId});
      const confirmed = checkedOwner(result, ownerId);
      if (!alive.current || request !== generation.current) return;
      setOwner(confirmed); onOwnerUpdated?.(confirmed);
      if (!initialized.current) {setNickname(ownerNicknameSuggestion(confirmed.currentNickname)); initialized.current = true;}
      if (verify) setVerification(ownerVerification(result, ownerId, proposedAtStart));
    } catch (e) {
      if (alive.current && request === generation.current) setError(e.message);
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true; load();
    return () => {alive.current = false; generation.current++;};
  }, [ownerId, guildId]);

  const localAction = async action => {
    if (!owner || pending || (action === 'copy' && nameError) || (action === 'open' && !channelId)) return;
    const request = generation.current, copied = proposedName;
    setBusy(action); setError('');
    try {
      const result = await api(`ownerprofile.${action}`, action === 'copy' ? {nickname: copied} : {guildId, channelId});
      if (!alive.current || request !== generation.current) return;
      if (action === 'copy' && result?.copied === true) setCopiedName(copied);
      else if (action === 'open' && result?.opened === true) setOpened(true);
      else throw new Error(action === 'copy' ? 'Der Name konnte nicht in die Zwischenablage kopiert werden.' : 'Discord konnte nicht geöffnet werden.');
    } catch (e) {
      if (alive.current && request === generation.current) setError(e.message);
    } finally {
      if (alive.current && request === generation.current) setBusy('');
    }
  };

  return <section className="panel owner-crown-assistant" aria-labelledby="owner-crown-title">
    <div className="owner-crown-heading"><span className="owner-crown-emblem"><Crown size={27}/></span><div><span className="admin-overline">BESITZER-ASSISTENT</span><h2 ref={headingRef} tabIndex={-1} id="owner-crown-title">Deine Krone als Serverbesitzer</h2><p>Bereite deinen Namen hier vor und prüfe danach, was Discord gespeichert hat.</p></div></div>
    <div className="owner-crown-boundary"><Info size={17}/><p>Discord erlaubt dem Bot keine Änderung am Besitzernamen. <strong>Den letzten Schritt „Speichern“ machst du in deinem eigenen Discord-Profil.</strong> Diese Hilfe setzt dort nichts automatisch.</p></div>
    {error && <div className="admin-error" role="alert">{error}</div>}
    {!owner ? <div className="owner-crown-loading">
      <p role="status">{loading ? 'Dein Serverbesitzer und sein aktueller Name werden geprüft …' : ownerId ? 'Der Besitzername ist noch nicht bestätigt.' : 'Die Serverdaten mit dem Besitzer werden benötigt.'}</p>
      <button className="btn" disabled={pending} onClick={() => ownerId ? load() : refresh?.()}><RefreshCw size={15}/>{loading ? 'Wird geladen …' : 'Erneut laden'}</button>
    </div> : <>
      <div className="owner-crown-current"><div><span>Zuletzt von Discord gelesen</span><strong>{owner.currentNickname}</strong><small>{guildData?.guild?.name || 'Dein Server'} · Besitzer-ID {owner.id}</small></div><span className={`badge ${owner.hasCrown ? '' : 'neutral'}`}>{owner.hasCrown ? '👑 Krone bereits sichtbar' : 'Noch ohne Krone'}</span></div>
      <div className="owner-crown-steps">
        <div className="owner-crown-step"><h3><span>1</span>Name vorbereiten</h3><label className="field" htmlFor="owner-crown-nickname">Dein gewünschter Server-Spitzname<input id="owner-crown-nickname" value={nickname} aria-invalid={!!nameError} aria-describedby="owner-crown-name-help" disabled={pending} onChange={e => {setNickname(e.target.value); setVerification(null); setCopiedName('');}}/></label><p id="owner-crown-name-help" className={`owner-crown-field-help ${nameError ? 'invalid' : ''}`}>{nameError || `${[...proposedName].length} / 32 Zeichen · einschließlich Krone und Leerzeichen`}</p><button className="btn btn-primary" disabled={pending || !!nameError} onClick={() => localAction('copy')}>{copiedName === proposedName ? <Check size={15}/> : <Copy size={15}/>} {busy === 'copy' ? 'Wird kopiert …' : copiedName === proposedName ? 'Name kopiert' : 'Namen kopieren'}</button></div>
        <div className="owner-crown-step"><h3><span>2</span>In Discord speichern</h3><label className="field" htmlFor="owner-crown-channel">Kanal zum Öffnen<select id="owner-crown-channel" value={channelId} disabled={pending || !channels.length} onChange={e => {setChannelChoice(e.target.value); setOpened(false);}}>{channels.length ? channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>) : <option value="">Kein Textkanal geladen</option>}</select></label><p>Öffne in Discord mit Rechtsklick auf deinen eigenen Namen <strong>„Serverspezifisches Profil bearbeiten“</strong>. Füge den kopierten Namen bei „Server-Nickname“ ein und wähle <strong>„Speichern“</strong>.</p><button className="btn" disabled={pending || !channelId} onClick={() => localAction('open')}><ExternalLink size={15}/>{busy === 'open' ? 'Wird geöffnet …' : 'Discord öffnen'}</button>{opened && <p className="owner-crown-hint" role="status">Der Serverkanal wurde zum Öffnen an Windows übergeben. Speichere den Namen in Discord und kehre danach hierher zurück.</p>}{!channels.length && <button className="btn" disabled={pending} onClick={() => refresh?.()}><RefreshCw size={15}/>Serverdaten neu laden</button>}</div>
      </div>
      <div className="owner-crown-verify"><div><h3><span>3</span>Gespeicherten Namen prüfen</h3><p>Die App liest deinen aktuellen Namen erneut von Discord. Kopieren oder Öffnen allein gilt noch nicht als Änderung.</p></div><button className="btn" disabled={pending || !!nameError} onClick={() => load(true)}><RefreshCw size={15}/>{loading ? 'Wird geprüft …' : 'In Discord prüfen'}</button></div>
      {currentVerification && <div className={`owner-crown-result ${currentVerification.matches ? 'matches' : 'different'}`} role="status">{currentVerification.matches ? <><Check size={19}/><span><strong>In Discord bestätigt: {currentVerification.owner.currentNickname}</strong><small>Der gewünschte Name ist gespeichert und auf diesem Server sichtbar.</small></span></> : <><Info size={19}/><span><strong>Noch nicht als gewünschter Name gespeichert</strong><small>Discord meldet weiterhin „{currentVerification.owner.currentNickname}“. Gewünscht ist „{currentVerification.requestedNickname}“.</small></span></>}</div>}
    </>}
  </section>;
}
