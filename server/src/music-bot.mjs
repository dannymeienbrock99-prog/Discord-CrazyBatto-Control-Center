import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, assert, safeMessage } from './errors.mjs';
import { P, has, channelPermissions } from './permissions.mjs';
import { validId } from './payloads.mjs';

const CONNECT = 1n << 20n, SPEAK = 1n << 21n, MAX_QUEUE = 500;
const label = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
const trackLabel = track => [label(track?.title), label(track?.artist)].filter(Boolean).join(' – ');
const MUSIC_CREDITS = '\nMusik & Lizenzen: https://crazybatto.de/musik-quellen.html';
const discordText = value => String(value).replace(/[\\`*_{}\[\]()<>~|]/g, '\\$&');
function voiceError(error, fallback) {
  if (error instanceof AppError) return error;
  const detail = String(error?.message || '');
  if (/dave|davey|encrypt|sodium|cipher/i.test(detail)) return new AppError('voice_dependency', 'Die Sprachverschlüsselung konnte auf dem Server nicht gestartet werden. Bitte die installierten Sprachkomponenten prüfen.', 503);
  if (/cannot find|module_not_found|binding|opus/i.test(detail)) return new AppError('voice_dependency', 'Eine benötigte Sprachkomponente fehlt auf dem Server oder konnte nicht geladen werden.', 503);
  return new AppError('voice_connection', fallback, 503);
}
export const musicTrack = track => track ? { id: track.id, title: label(track.title), artist: label(track.artist), duration: track.duration } : null;

// One configured guild, one shared queue. Audio is read only from the private
// music store. Both slash commands and the separate remote use this player.
export class MusicBot {
  constructor(service, { loadVoice = () => import('@discordjs/voice'), spawnImpl = spawn } = {}) {
    this.service = service; this.loadVoice = loadVoice; this.spawn = spawnImpl;
    this.queue = []; this.index = -1; this.generation = 0; this.channelId = null; this.volume = 70;
    this.problem = null; this.jobs = Promise.resolve(); this.pending = 0; this.seen = new Map();
    this.accessCache = new Map(); this.connectionEpoch = 0; this.stopEpoch = 0; this.voiceOwnerId = null; this.pendingLeaveEpoch = null; this.lastLeave = null;
  }
  status() {
    const playerState = this.player?.state.status;
    return { configured: this.service.config.musicBotEnabled === true,
      enabled: this.service.botAdmin.settings().enabled === true,
      connected: !!this.connection && this.connection.state.status === 'ready', channelId: this.channelId,
      status: !this.connection ? 'stopped' : this.connection.state.status !== 'ready' ? 'connecting' : playerState || 'idle',
      track: this.queue[this.index]?.title || null, currentTrack: musicTrack(this.queue[this.index]),
      position: this.index < 0 ? 0 : this.index + 1, total: this.queue.length,
      paused: playerState === 'paused' || playerState === 'autopaused', volume: this.volume,
      elapsed: Math.floor((this.resource?.playbackDuration || 0) / 1000), pending: this.pending, message: this.problem };
  }
  queueView() { return this.queue.map((track, index) => ({ ...musicTrack(track), position: index + 1, current: index === this.index })); }
  leaveWithOwner() {
    this.problem = 'Der Musikbot hat den Sprachkanal verlassen, weil das Mitglied, das ihn gestartet hat, gegangen ist oder den Kanal gewechselt hat.';
    this.stop();
  }
  reconcileVoice() {
    const gateway = this.service.botGateway;
    if (!this.voiceOwnerId || !this.channelId) {
      const orphan = !this.connection && this.service.config.musicBotEnabled && this.service.botAdmin.settings().enabled && gateway.voiceChannel(gateway.botUserId || this.service.config.clientId);
      if (orphan && this.pendingLeaveEpoch === null && (this.lastLeave?.musicEpoch !== this.connectionEpoch || this.lastLeave?.gatewayEpoch !== gateway.epoch)) this.pendingLeaveEpoch = this.connectionEpoch;
      this.flushPendingLeave(); return;
    }
    if (gateway.voiceChannel(this.voiceOwnerId) !== this.channelId) { this.leaveWithOwner(); return; }
    if (gateway.voiceChannel(gateway.botUserId || this.service.config.clientId) !== this.channelId) this.stop();
  }
  flushPendingLeave() {
    if (this.pendingLeaveEpoch === null) return;
    if (this.pendingLeaveEpoch !== this.connectionEpoch || this.connection || this.voiceOwnerId) { this.pendingLeaveEpoch = null; return; }
    const gateway = this.service.botGateway;
    if (!gateway.status().ready) return;
    if (!gateway.voiceChannel(gateway.botUserId || this.service.config.clientId)) { this.pendingLeaveEpoch = null; this.lastLeave = null; }
    else if (gateway.leaveVoice()) { this.pendingLeaveEpoch = null; this.lastLeave = { musicEpoch: this.connectionEpoch, gatewayEpoch: gateway.epoch }; }
  }
  gatewayEvent(packet) {
    const data = packet?.d;
    if (data?.guild_id !== this.service.config.discordGuildId && data?.id !== this.service.config.discordGuildId) return;
    if (packet.t === 'GUILD_CREATE' && Array.isArray(data.voice_states) && !data.unavailable) { this.reconcileVoice(); return; }
    if (packet.t === 'VOICE_STATE_UPDATE' && data.user_id === (this.service.botGateway.botUserId || this.service.config.clientId) && data.channel_id === null) { this.pendingLeaveEpoch = null; this.lastLeave = null; }
    if (!this.voiceOwnerId || !this.channelId) return;
    if (packet.t === 'VOICE_STATE_UPDATE' && validId(data.user_id) && (data.channel_id === null || validId(data.channel_id))) {
      if (data.user_id === this.voiceOwnerId && data.channel_id !== this.channelId) this.leaveWithOwner();
      else if (data.user_id === (this.service.botGateway.botUserId || this.service.config.clientId) && data.channel_id !== this.channelId) this.stop();
    } else if (packet.t === 'GUILD_DELETE') this.stop();
  }
  connectionState(phase) {
    // READY/reconnecting can still expose the previous voice cache. Reconcile
    // only after a fresh GUILD_CREATE snapshot or a complete RESUMED replay.
    if (phase === 'resumed') this.reconcileVoice();
    else if (phase === 'stopped' || phase === 'error') this.stop();
  }
  enqueue(task) {
    assert(this.pending < 8, 'Der Musikbot ist beschäftigt. Bitte kurz warten.', 'busy', 429);
    const stoppedAt = this.stopEpoch;
    const run = () => { assert(stoppedAt === this.stopEpoch, 'Die Musiksitzung wurde beendet. Bitte den Befehl erneut auslösen.', 'conflict', 409); return task(); };
    this.pending++;
    const job = this.jobs.then(run, run).finally(() => { this.pending--; });
    this.jobs = job.catch(() => {});
    return job;
  }
  accept(interaction) {
    const now = this.service.now();
    for (const [id, at] of this.seen) if (at < now - 900_000) this.seen.delete(id);
    if (this.seen.has(interaction.id)) return;
    this.seen.set(interaction.id, now);
    const reply = (content, credited = false) => this.service.discord.request('PATCH', '/webhooks/' + this.service.config.clientId + '/' + encodeURIComponent(interaction.token) + '/messages/@original',
      { payload: { content: credited ? discordText(content).slice(0, 1900 - MUSIC_CREDITS.length) + MUSIC_CREDITS : String(content).slice(0, 1900), allowed_mentions: { parse: [] } } }).catch(() => { this.problem = 'Die letzte Befehlsantwort konnte nicht an Discord gesendet werden.'; });
    try {
      void this.enqueue(() => this.command(interaction)).then(content => reply(content, true), error => reply(error?.kind ? error.message : 'Die Musikwiedergabe konnte nicht gestartet werden. Bitte Bot-Verbindung und Musikspeicher prüfen.'));
    } catch { void reply('Der Musikbot ist beschäftigt. Bitte kurz warten.'); }
  }
  requireReady() {
    assert(this.service.config.musicBotEnabled, 'Der Musikbot muss zuerst auf dem Server eingerichtet werden.', 'unconfigured', 503);
    assert(this.service.botAdmin.settings().enabled, 'Der Musikbot ist ausgeschaltet.', 'forbidden', 403);
    assert(this.service.botGateway.status().ready, 'Der Bot ist noch nicht mit Discord verbunden.', 'unconfigured', 503);
  }
  async voiceContext(userId, { fresh = false } = {}) {
    assert(validId(userId), 'Bitte Discord erneut verbinden.', 'auth', 401);
    const now = this.service.now(), cached = this.accessCache.get(userId);
    if (!fresh && cached && cached.until > now) return cached.value;
    const guildId = this.service.config.discordGuildId;
    assert(validId(guildId), 'Für den Musikbot wurde noch kein Discord-Server eingerichtet.', 'unconfigured', 503);
    const bot = await this.service.bot();
    const [guild, member, botMember, channels] = await Promise.all([
      this.service.discord.request('GET', '/guilds/' + guildId),
      this.service.discord.request('GET', '/guilds/' + guildId + '/members/' + userId),
      this.service.discord.request('GET', '/guilds/' + guildId + '/members/' + bot.id),
      this.service.discord.request('GET', '/guilds/' + guildId + '/channels')
    ]);
    assert(guild?.id === guildId && Array.isArray(guild.roles) && member?.user?.id === userId &&
      Array.isArray(member.roles) && botMember?.user?.id === bot.id && Array.isArray(botMember.roles) && Array.isArray(channels),
    'Die Discord-Mitgliedschaft oder Sprachkanalrechte konnten nicht bestätigt werden.', 'forbidden', 403);
    const value = { guild, member, botMember, channels: channels.filter(channel => channel?.guild_id === guildId && validId(channel.id) && channel.type === 2) };
    if (this.accessCache.size > 500) for (const [key, entry] of this.accessCache) if (entry.until <= now) this.accessCache.delete(key);
    if (this.accessCache.size < 2000 || this.accessCache.has(userId)) this.accessCache.set(userId, { value, until: now + 15_000 });
    return value;
  }
  voiceView(context, userId) {
    const now = this.service.now(), current = this.service.botGateway.voiceChannel(userId);
    const channels = context.channels.filter(channel => has(channelPermissions(context.guild, context.member, channel, now), P.VIEW_CHANNEL | CONNECT)).map(channel => ({
      id: channel.id, name: label(channel.name), joined: channel.id === current,
      botCanJoin: has(channelPermissions(context.guild, context.botMember, channel, now), P.VIEW_CHANNEL | CONNECT | SPEAK) && !context.botMember.mute
    }));
    const channel = channels.find(item => item.id === current) || null;
    const reason = !current ? 'Tritt in Discord zuerst einem Sprachkanal dieses Servers bei.'
      : !channel ? 'Du darfst diesen Sprachkanal derzeit nicht benutzen.'
      : !channel.botCanJoin ? 'Dem Bot fehlen in deinem Sprachkanal die Rechte „Kanal ansehen“, „Verbinden“ oder „Sprechen“, oder er ist serverseitig stummgeschaltet.'
      : this.channelId && this.channelId !== current ? 'Tritt dem Sprachkanal bei, in dem der Musikbot bereits spielt.' : null;
    return { channels, channel, permissions: { canControl: !reason, reason, voiceChannelId: current } };
  }
  async requireVoice(userId, channelId = null) {
    this.requireReady();
    const context = await this.voiceContext(userId, { fresh: true });
    this.requireReady();
    const view = this.voiceView(context, userId);
    assert(view.permissions.canControl, view.permissions.reason, 'forbidden', 403);
    assert(channelId === null || channelId === view.channel.id, 'Du kannst nur deinen aktuellen Discord-Sprachkanal steuern. Bitte dort beitreten und die Anzeige aktualisieren.', 'forbidden', 403);
    return { ...view, context };
  }
  async command(interaction) {
    assert(interaction.guild_id === this.service.config.discordGuildId, 'Dieser Musikbot gehört zu einem anderen Server.', 'forbidden', 403);
    const options = Object.fromEntries((interaction.data.options || []).map(item => [item.name, item.value]));
    const action = ({ liste: 'list', fortsetzen: 'resume', weiter: 'next' })[options.aktion] || options.aktion || 'play';
    const requested = String(options.playlist || 'all').trim();
    const playlistId = requested === 'all' || requested.toLowerCase() === 'alle' ? 'all' : this.service.accounts.playlists.list().find(item => item.id === requested || item.name.toLocaleLowerCase('de') === requested.toLocaleLowerCase('de'))?.id;
    if (action === 'play') assert(playlistId, 'Diese Playlist wurde nicht gefunden. Nutze den Namen aus dem Webplayer.');
    return this.control(interaction.member?.user?.id, { action, playlistId, number: options.nummer ?? 1 });
  }
  async control(userId, input, authorize = () => {}) {
    authorize();
    const stoppedAt = this.stopEpoch;
    const { action } = input;
    const access = await this.requireVoice(userId, input.channelId || null);
    authorize();
    const channelId = access.channel.id;
    const guard = () => {
      authorize(); this.requireReady();
      assert(stoppedAt === this.stopEpoch, 'Die Musiksitzung wurde zwischenzeitlich beendet. Bitte erneut starten.', 'conflict', 409);
      assert(this.service.botGateway.voiceChannel(userId) === channelId && (!this.channelId || this.channelId === channelId),
        'Der Sprachkanal wurde gewechselt oder verlassen. Bitte neu laden.', 'forbidden', 403);
    };
    guard();
    if (action === 'join') {
      await this.prepareVoice(); guard();
      await this.requireVoice(userId, channelId); guard();
      const alreadyConnected = this.connection?.state.status === this.voice.VoiceConnectionStatus.Ready;
      await this.connect(channelId, guard, userId); guard(); this.problem = null;
      return alreadyConnected ? 'Der Bot ist bereits in deinem Sprachkanal verbunden.' : 'Der Bot ist deinem Sprachkanal beigetreten. Du kannst jetzt einen Titel auswählen.';
    }
    if (action === 'list') return this.queue.length ? this.queueView().slice(Math.max(0, this.index), Math.max(0, this.index) + 20).map(track => `${track.position}. ${trackLabel(track)}`).join('\n') : 'Die Warteschlange ist leer.';
    if (action === 'stop') { this.stop(); return 'Wiedergabe beendet. Der Bot hat den Sprachkanal verlassen.'; }
    if (action === 'pause') { assert(this.player?.pause(), 'Es läuft gerade keine Musik.'); return 'Wiedergabe pausiert.'; }
    if (action === 'resume') { assert(this.player?.unpause(), 'Es gibt keine pausierte Wiedergabe.'); return 'Wiedergabe fortgesetzt.'; }
    if (action === 'volume') {
      assert(Number.isInteger(input.volume) && input.volume >= 0 && input.volume <= 100, 'Die Lautstärke muss zwischen 0 und 100 liegen.');
      this.volume = input.volume; this.resource?.volume?.setVolume(this.volume / 100); return 'Lautstärke: ' + this.volume + ' %.';
    }
    if (action === 'next' || action === 'previous') {
      assert(this.connection && this.queue.length, 'Die Warteschlange ist leer.');
      const epoch = this.connectionEpoch;
      if (action === 'previous') this.index = Math.max(-1, this.index - 2);
      try { await this.next(guard); } catch (error) { if (epoch === this.connectionEpoch) { this.problem = 'Der nächste Titel konnte nicht geladen werden.'; this.stop(); } throw error; }
      return this.queue[this.index] ? 'Wiedergabe: ' + trackLabel(this.queue[this.index]) : 'Playlist zu Ende.';
    }
    assert(action === 'play' || action === 'queue', 'Unbekannte Musikaktion.');
    const tracks = this.service.accounts.playlists.tracks(input.playlistId || 'all');
    const selected = input.trackId ? tracks.findIndex(track => track.id === input.trackId) : (input.number ?? 1) - 1;
    assert(Number.isInteger(selected) && selected >= 0 && selected < tracks.length, 'Bitte einen vorhandenen Titel aus der Playlist wählen.');
    const additions = action === 'queue' && input.trackId ? [tracks[selected]] : tracks.slice(selected, selected + MAX_QUEUE);
    if (action === 'queue' && this.connection && this.queue.length) {
      assert(this.queue.length + additions.length <= MAX_QUEUE, 'Die Warteschlange darf höchstens 500 Titel enthalten.');
      this.queue.push(...additions); return additions.length === 1 ? 'Zur Warteschlange hinzugefügt: ' + trackLabel(additions[0]) : additions.length + ' Titel zur Warteschlange hinzugefügt.';
    }
    const health = await this.service.accounts.storageStatus();
    assert(health.online, health.message, 'unconfigured', 503);
    await this.prepareVoice(); guard();
    await this.connect(channelId, guard, userId); guard();
    this.queue = additions; this.index = -1; this.problem = null;
    const epoch = this.connectionEpoch;
    try { await this.next(guard); } catch (error) { if (epoch === this.connectionEpoch) this.stop(); throw error; }
    return 'Wiedergabe: ' + trackLabel(this.queue[this.index]);
  }
  async prepareVoice() {
    try { this.voice ||= await this.loadVoice(); }
    catch (error) { const failure = voiceError(error, 'Die Sprachfunktion konnte auf dem Server nicht geladen werden.'); this.problem = safeMessage(failure.message); throw failure; }
  }
  async connect(channelId, guard, userId) {
    guard();
    if (this.connection?.state.status === this.voice.VoiceConnectionStatus.Destroyed) this.stop();
    if (this.connection) {
      const existing = this.connection, epoch = this.connectionEpoch;
      assert(existing.joinConfig.channelId === channelId, 'Der Bot ist bereits mit einem anderen Sprachkanal verbunden.', 'conflict', 409);
      try {
        if (existing.state.status !== this.voice.VoiceConnectionStatus.Ready) await this.voice.entersState(existing, this.voice.VoiceConnectionStatus.Ready, 20000);
        guard();
        assert(this.connection === existing && epoch === this.connectionEpoch && existing.state.status === this.voice.VoiceConnectionStatus.Ready, 'Die Sprachverbindung wurde zwischenzeitlich beendet.', 'conflict', 409);
        return;
      } catch (error) {
        if (!(error instanceof AppError) && this.connection === existing) this.stop();
        const failure = voiceError(error, 'Die bestehende Sprachverbindung ist nicht bereit. Bitte erneut verbinden.'); this.problem = safeMessage(failure.message); throw failure;
      }
    }
    assert(validId(userId), 'Der Start der Musiksitzung konnte keinem Discord-Mitglied zugeordnet werden.', 'auth', 401);
    const epoch = ++this.connectionEpoch;
    this.channelId = channelId; this.voiceOwnerId = userId; this.pendingLeaveEpoch = null; this.lastLeave = null;
    let connection;
    try { connection = this.connection = this.voice.joinVoiceChannel({ channelId, guildId: this.service.config.discordGuildId,
      adapterCreator: this.service.botGateway.voiceAdapter(this.service.config.discordGuildId), selfDeaf: true, selfMute: false, daveEncryption: true }); }
    catch (error) { this.stop(); const failure = voiceError(error, 'Der Sprachkanal konnte nicht geöffnet werden. Bitte Bot-Verbindung und Sprachkanalrechte prüfen.'); this.problem = safeMessage(failure.message); throw failure; }
    connection.on('error', () => { if (this.connection === connection) { this.problem = 'Die Discord-Sprachverbindung wurde unterbrochen.'; this.stop(); } });
    connection.on('stateChange', (_old, current) => {
      if (this.connection !== connection) return;
      if (current.status === this.voice.VoiceConnectionStatus.Destroyed) { this.stop(); return; }
      if (current.status === this.voice.VoiceConnectionStatus.Ready && connection.joinConfig.channelId !== this.channelId) { this.stop(); return; }
      if (current.status === this.voice.VoiceConnectionStatus.Disconnected) void this.voice.entersState(connection, this.voice.VoiceConnectionStatus.Ready, 15000).catch(() => { if (this.connection === connection) { this.problem = 'Die Discord-Sprachverbindung konnte nicht wiederhergestellt werden. Bitte erneut verbinden.'; this.stop(); } });
    });
    try { await this.voice.entersState(connection, this.voice.VoiceConnectionStatus.Ready, 20000); guard();
      assert(this.connection === connection && epoch === this.connectionEpoch, 'Die Sprachverbindung wurde zwischenzeitlich beendet.', 'conflict', 409);
    } catch (error) {
      const current = this.connection === connection;
      if (current) this.stop();
      const failure = voiceError(error, 'Discord hat den Sprachbeitritt nicht bestätigt. Bitte Sprachkanalrechte und die ausgehende Sprachverbindung des Servers prüfen.');
      if (current || (!this.connection && !this.problem)) this.problem = safeMessage(failure.message);
      throw failure;
    }
    let player;
    try { player = this.player = this.voice.createAudioPlayer({ behaviors: { noSubscriber: this.voice.NoSubscriberBehavior.Pause } }); }
    catch (error) { this.stop(); const failure = voiceError(error, 'Die Audiowiedergabe konnte auf dem Server nicht vorbereitet werden.'); this.problem = safeMessage(failure.message); throw failure; }
    player.on('error', () => { if (this.player === player) { this.problem = 'Der aktuelle Titel konnte nicht abgespielt werden.'; this.stop(); } });
    player.on(this.voice.AudioPlayerStatus.Idle, () => {
      if (!this.resource || this.player !== player || this.connection !== connection) return;
      this.resource = null;
      const generation = this.generation, epoch = this.connectionEpoch;
      try { void this.enqueue(async () => { if (generation === this.generation && this.player === player) await this.next(); }).catch(() => { if (epoch === this.connectionEpoch && this.connection === connection) { this.problem = 'Der nächste Titel konnte nicht geladen werden.'; this.stop(); } }); }
      catch { this.problem = 'Die Wiedergabe wurde beendet, weil zu viele Befehle gleichzeitig eingingen.'; this.stop(); }
    });
    try { connection.subscribe(player); }
    catch (error) { this.stop(); const failure = voiceError(error, 'Der Audioplayer konnte nicht mit dem Sprachkanal verbunden werden.'); this.problem = safeMessage(failure.message); throw failure; }
  }
  cleanup() {
    this.generation++; this.resource = null;
    this.player?.stop(true);
    this.input?.destroy(); this.input = null;
    this.process?.stdin.destroy(); this.process?.stdout.destroy(); this.process?.kill('SIGKILL'); this.process = null;
    clearTimeout(this.idleTimer);
  }
  async next(authorize = () => {}) {
    authorize(); this.cleanup();
    while (++this.index < this.queue.length && !this.service.accounts.store.get('SELECT 1 FROM music_tracks WHERE id=?', this.queue[this.index].id)) {}
    if (this.index >= this.queue.length) { this.stop(); return; }
    const generation = this.generation, track = this.queue[this.index];
    const response = await this.service.accounts.storage.stream(track.id);
    if (generation !== this.generation) { await response.body?.cancel(); throw new AppError('conflict', 'Die Wiedergabe wurde zwischenzeitlich beendet. Bitte erneut starten.', 409); }
    try { authorize(); this.requireReady(); }
    catch (error) { await response.body?.cancel(); this.stop(); throw error; }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); assert(false, 'Der Musikspeicher kann den Titel nicht liefern.', 'network', 503); }
    const child = this.process = this.spawn('ffmpeg', ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-i','pipe:0','-vn','-t','10800','-f','s16le','-ar','48000','-ac','2','pipe:1'], { stdio: ['pipe','pipe','ignore'] });
    const fail = () => { if (this.process === child) { this.problem = 'Der Titel konnte nicht in Discord-Audio umgewandelt werden.'; this.stop(); } };
    child.on('error', fail); child.on('exit', code => { if (code && code !== 0) fail(); });
    this.input = Readable.fromWeb(response.body);
    void pipeline(this.input, child.stdin).catch(() => { if (this.process === child && !child.killed) fail(); });
    this.resource = this.voice.createAudioResource(child.stdout, { inputType: this.voice.StreamType.Raw, inlineVolume: true });
    this.resource.volume.setVolume(this.volume / 100); this.player.play(this.resource);
  }
  stop() {
    const needsLeaveConfirmation = !!this.connection || this.pendingLeaveEpoch !== null;
    this.stopEpoch++; this.connectionEpoch++; this.voiceOwnerId = null;
    this.pendingLeaveEpoch = needsLeaveConfirmation ? this.connectionEpoch : null;
    this.cleanup(); const connection = this.connection; this.connection = null;
    if (connection && connection.state.status !== 'destroyed') connection.destroy();
    this.player = null; this.channelId = null; this.queue = []; this.index = -1;
  }
}
