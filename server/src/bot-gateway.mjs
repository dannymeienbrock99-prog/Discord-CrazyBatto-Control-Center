// Presence and optional voice adapter. Commands use signed HTTP interactions.
// Protocol: https://docs.discord.com/developers/events/gateway
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FRESH_IDENTIFY_INTERVAL = 300_000;

export function gatewayAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash ||
      !/^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname) || url.pathname !== '/') throw new Error('gateway_address');
  url.search = '?v=10&encoding=json';
  return url.href;
}

export class BotGateway {
  constructor(config, { fetchImpl = fetch, WebSocketImpl = WebSocket, now = Date.now,
    random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, onDispatch = null, intentResolver = null, onConnectionState = null } = {}) {
    this.config = config; this.fetch = fetchImpl; this.WebSocket = WebSocketImpl;
    this.now = now; this.random = random; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.onDispatch = onDispatch; this.intentResolver = intentResolver; this.onConnectionState = onConnectionState; this.lastIntents = config.musicBotEnabled ? 129 : 0; this.membersIntentRejected = false;
    this.running = false; this.epoch = 0; this.ws = null; this.attempt = 0;
    this.sessionId = null; this.resumeUrl = null; this.sequence = null; this.lastIdentify = null;
    this.voiceAdapters = new Map(); this.voiceStates = new Map(); this.botUserId = null;
    this.voiceDetails = new Map();
    this.readyAt = null; this.ackAt = null; this.phase = 'unconfigured'; this.problem = null;
  }
  voiceChannel(userId) { return this.voiceStates.get(userId) || null; }
  voiceMembers() { return [...this.voiceDetails.values()].map(row => ({ ...row })); }
  applyVoiceControl(userId, operation) {
    if (operation === 'disconnect') { this.voiceStates.delete(userId); this.voiceDetails.delete(userId); }
    else if (this.voiceDetails.has(userId)) this.voiceDetails.get(userId).mute = operation === 'mute';
  }
  recordVoice(state, member = null) {
    if (!state.channel_id) { this.voiceStates.delete(state.user_id); this.voiceDetails.delete(state.user_id); return; }
    const previous = this.voiceDetails.get(state.user_id), user = state.member?.user || member?.user;
    this.voiceStates.set(state.user_id, state.channel_id);
    this.voiceDetails.set(state.user_id, { userId: state.user_id, channelId: state.channel_id,
      name: String(state.member?.nick || member?.nick || user?.global_name || user?.username || previous?.name || state.user_id).slice(0, 100),
      mute: !!state.mute, deaf: !!state.deaf, selfMute: !!state.self_mute, selfDeaf: !!state.self_deaf, bot: user?.bot ?? previous?.bot ?? false });
  }
  voiceAdapter(guildId) {
    if (guildId !== this.config.discordGuildId) throw new Error('wrong_guild');
    return methods => {
      this.voiceAdapters.set(guildId, methods);
      return {
        sendPayload: payload => { try { if (this.phase !== 'online') return false; this.send(this.ws, payload); return true; } catch { return false; } },
        destroy: () => { if (this.voiceAdapters.get(guildId) === methods) this.voiceAdapters.delete(guildId); }
      };
    };
  }
  closeVoice() { for (const adapter of this.voiceAdapters.values()) adapter.destroy(); this.voiceAdapters.clear(); this.voiceStates.clear(); this.voiceDetails.clear(); }
  voiceDispatch(packet) {
    const data = packet.d;
    if (data?.guild_id !== this.config.discordGuildId && data?.id !== this.config.discordGuildId) return;
    if (packet.t === 'GUILD_CREATE') {
      this.voiceStates.clear(); this.voiceDetails.clear();
      const members = new Map((data.members || []).map(member => [member.user?.id, member]));
      for (const state of data.voice_states || []) this.recordVoice(state, members.get(state.user_id));
    } else if (packet.t === 'GUILD_DELETE') this.closeVoice();
    else if (packet.t === 'VOICE_STATE_UPDATE') {
      this.recordVoice(data);
      if (data.user_id === this.botUserId) this.voiceAdapters.get(data.guild_id)?.onVoiceStateUpdate(data);
    } else if (packet.t === 'VOICE_SERVER_UPDATE') this.voiceAdapters.get(data.guild_id)?.onVoiceServerUpdate(data);
  }
  configured() { return Boolean(this.config.botToken && /^\d{17,20}$/.test(this.config.clientId)); }
  status() {
    return { configured: this.configured(), ready: this.phase === 'online', phase: this.phase, membersIntentRejected: this.membersIntentRejected,
      lastReadyAt: this.readyAt, lastHeartbeatAckAt: this.ackAt, message: this.problem || ({
        unconfigured: 'Der Bot-Zugang fehlt noch.', connecting: 'Discord-Verbindung wird aufgebaut.',
        online: 'Der Bot ist bei Discord online.', reconnecting: 'Die Discord-Verbindung wird wiederhergestellt.',
        waiting: 'Discord-Anmeldung wartet auf das nächste erlaubte Zeitfenster.',
        stopped: 'Die Discord-Verbindung wurde beendet.', error: 'Die Discord-Verbindung konnte nicht hergestellt werden.'
      }[this.phase]) };
  }
  later(callback, delay) { const timer = this.setTimer(callback, delay); timer?.unref?.(); return timer; }
  connectionChanged(phase) { try { this.onConnectionState?.(phase); } catch { /* Tracking failures must not interrupt the gateway. */ } }
  start() {
    if (this.running || !this.configured()) return;
    this.running = true; this.phase = 'connecting'; this.problem = null;
    void this.connect();
  }
  stop() {
    this.connectionChanged('stopped');
    this.closeVoice(); this.running = false; this.epoch++; this.phase = 'stopped';
    this.clearTimer(this.retryTimer); this.abort?.abort(); this.detach(1000);
    this.sessionId = null; this.resumeUrl = null; this.sequence = null;
  }
  detach(code = 4000) {
    this.clearTimer(this.heartbeatTimer); this.clearTimer(this.helloTimer);
    const old = this.ws; this.ws = null;
    if (old) { try { old.close(code); } catch {} }
  }
  retry(delay, { reset = false, problem = null } = {}) {
    if (!this.running) return;
    this.connectionChanged('reconnecting');
    this.epoch++; this.abort?.abort(); this.detach(); this.clearTimer(this.retryTimer);
    if (reset) { this.sessionId = null; this.resumeUrl = null; this.sequence = null; }
    this.problem = problem; this.phase = 'reconnecting';
    const backoff = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.floor(this.random() * 1000);
    let wait = delay ?? backoff;
    if (!this.sessionId && this.lastIdentify !== null) wait = Math.max(wait, this.lastIdentify + FRESH_IDENTIFY_INTERVAL - this.now());
    if (wait > 60_000) this.phase = 'waiting';
    this.retryTimer = this.later(() => { if (this.running) void this.connect(); }, Math.max(0, Math.min(wait, 86_400_000)));
  }
  fatal(message) {
    this.connectionChanged('error');
    this.closeVoice(); this.running = false; this.epoch++; this.problem = message; this.phase = 'error';
    this.abort?.abort(); this.clearTimer(this.retryTimer); this.detach(1000);
    this.sessionId = null; this.resumeUrl = null; this.sequence = null;
  }
  async connect() {
    if (!this.running) return;
    const epoch = ++this.epoch;
    this.phase = 'connecting'; this.problem = null;
    try {
      let address = this.resumeUrl;
      if (!this.sessionId || !address) {
        if (this.intentResolver) {
          let requested;
          try { requested = await this.intentResolver(); } catch { requested = 129; }
          this.lastIntents = !this.membersIntentRejected && [129, 131].includes(requested) ? requested : 129;
          if (!this.running || epoch !== this.epoch) return;
        }
        this.abort = new AbortController();
        const response = await this.fetch('https://discord.com/api/v10/gateway/bot', {
          headers: { Authorization: 'Bot ' + this.config.botToken }, redirect: 'error',
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12_000)])
        });
        if (!this.running || epoch !== this.epoch) { await response.body?.cancel(); return; }
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel(); return this.fatal('Discord hat den Bot-Schlüssel abgelehnt. Bitte den Serverzugang prüfen.');
        }
        if (response.status === 429) {
          const delay = Number(response.headers.get('retry-after')) * 1000;
          await response.body?.cancel();
          return this.retry(Number.isFinite(delay) && delay > 0 ? Math.max(5000, delay) : 60_000);
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error('gateway_unavailable'); }
        const info = await response.json();
        if (!this.running || epoch !== this.epoch) return;
        if (info.session_start_limit?.remaining === 0) {
          const reset = Number(info.session_start_limit.reset_after);
          return this.retry(Number.isFinite(reset) && reset > 0 ? reset + 1000 : FRESH_IDENTIFY_INTERVAL);
        }
        address = info.url;
      }
      if (!this.running || epoch !== this.epoch) return;
      const ws = this.ws = new this.WebSocket(gatewayAddress(address));
      const current = () => this.running && this.ws === ws && this.epoch === epoch;
      this.heartbeatPending = false;
      this.helloTimer = this.later(() => { if (current()) this.retry(undefined, { problem: 'Discord antwortet noch nicht. Neuer Verbindungsversuch folgt.' }); }, 25_000);
      ws.addEventListener('message', event => {
        if (!current()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('payload');
          const packet = JSON.parse(event.data);
          if (packet.op === 0 && (this.config.musicBotEnabled || this.onDispatch)) this.voiceDispatch(packet);
          if (packet.op === 0 && this.onDispatch) {
            try { Promise.resolve(this.onDispatch(packet)).catch(() => {}); } catch { /* Community failures must not interrupt the music gateway. */ }
          }
          if (Number.isSafeInteger(packet.s) && packet.s >= 0) this.sequence = packet.s;
          if (packet.op === 10) {
            if (this.helloReceived) throw new Error('duplicate_hello');
            this.helloReceived = true;
            const interval = packet.d?.heartbeat_interval;
            if (!Number.isInteger(interval) || interval < 1000 || interval > 300_000) throw new Error('heartbeat');
            this.clearTimer(this.helloTimer);
            this.helloTimer = this.later(() => { if (current()) this.retry(undefined, { problem: 'Discord hat die Anmeldung noch nicht bestätigt.' }); }, 60_000);
            const beat = () => {
              if (!current()) return;
              if (this.heartbeatPending) return this.retry(undefined, { problem: 'Die Discord-Verbindung wurde unterbrochen.' });
              try { this.send(ws, { op: 1, d: this.sequence }); }
              catch { return this.retry(undefined, { problem: 'Die Discord-Verbindung wurde unterbrochen.' }); }
              this.heartbeatPending = true;
              this.heartbeatTimer = this.later(beat, interval);
            };
            this.heartbeatTimer = this.later(beat, Math.floor(interval * this.random()));
            if (this.sessionId && this.sequence !== null) this.send(ws, { op: 6, d: {
              token: this.config.botToken, session_id: this.sessionId, seq: this.sequence
            } });
            else {
              this.lastIdentify = this.now();
              this.send(ws, { op: 2, d: { token: this.config.botToken, intents: this.lastIntents,
                properties: { os: process.platform, browser: 'Crazy_Batto', device: 'Crazy_Batto' },
                presence: { status: 'online', since: null, activities: [], afk: false } } });
            }
          } else if (packet.op === 11) { this.heartbeatPending = false; this.ackAt = this.now(); }
          // An extra server-requested heartbeat must not shorten the regular ACK deadline.
          else if (packet.op === 1) { this.send(ws, { op: 1, d: this.sequence }); }
          else if (packet.op === 7) this.retry(1000);
          else if (packet.op === 9) this.retry(1000 + Math.floor(this.random() * 4000), { reset: packet.d !== true });
          else if (packet.op === 0 && packet.t === 'READY') {
            if (packet.d?.application?.id !== this.config.clientId || packet.d?.user?.bot !== true)
              return this.fatal('Bot-Schlüssel und ausgewählte Discord-Anwendung passen nicht zusammen.');
            if (typeof packet.d.session_id !== 'string' || packet.d.session_id.length > 256) throw new Error('session');
            this.botUserId = packet.d.user.id;
            this.sessionId = packet.d.session_id; this.resumeUrl = gatewayAddress(packet.d.resume_gateway_url);
            this.clearTimer(this.helloTimer); this.phase = 'online'; this.readyAt = this.now(); this.attempt = 0; this.problem = null;
            this.connectionChanged('online');
          } else if (packet.op === 0 && packet.t === 'RESUMED') {
            this.clearTimer(this.helloTimer); this.phase = 'online'; this.readyAt = this.now(); this.attempt = 0; this.problem = null;
            this.connectionChanged('resumed');
          }
        } catch { if (current()) this.retry(undefined, { problem: 'Die Discord-Antwort konnte nicht verarbeitet werden.' }); }
      });
      ws.addEventListener('close', event => {
        if (!current()) return;
        if (event.code === 4014 && this.lastIntents === 131 && this.intentResolver) {
          this.membersIntentRejected = true;
          return this.retry(0, { reset: true, problem: 'Discord hat Mitgliederereignisse abgelehnt. Voice und Musik verbinden sich im nächsten erlaubten Zeitfenster ohne diesen Zusatz.' });
        }
        if (FATAL_CODES.has(event.code)) return this.fatal('Discord lehnt die Bot-Anmeldung ab. Zugang und Konfiguration müssen geprüft werden.');
        this.retry(undefined, { reset: [1000, 1001, 4007, 4009].includes(event.code) });
      });
      ws.addEventListener('error', () => { if (current()) this.retry(undefined, { problem: 'Discord ist gerade nicht erreichbar. Neuer Versuch folgt.' }); });
      this.helloReceived = false;
    } catch { if (this.running && epoch === this.epoch) this.retry(undefined, { problem: 'Discord ist gerade nicht erreichbar. Neuer Versuch folgt.' }); }
  }
  send(ws, packet) {
    if (ws !== this.ws || ws.readyState !== 1) throw new Error('socket_closed');
    ws.send(JSON.stringify(packet));
  }
}
