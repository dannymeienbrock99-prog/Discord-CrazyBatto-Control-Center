'use strict';

const API = 'https://discord.com/api/v10';
class DiscordError extends Error {
  constructor(message, status, code) { super(message); this.name = 'DiscordError'; this.status = status; this.code = code; }
}
class DiscordClient {
  constructor(token, options = {}) {
    if (typeof token !== 'string' || token.trim().length < 30 || token.length > 512 || /\s/.test(token.trim())) throw new Error('Bitte einen gültigen Bot-Token eintragen.');
    this.token = token.trim().replace(/^Bot /, '');
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.queue = Promise.resolve();
  }
  request(method, path, body, image) {
    if (!['GET','POST','PATCH'].includes(method) || !/^\/(?:users|guilds|channels)\//.test(path) || path.includes('..') || path.includes('://')) return Promise.reject(new Error('Ungültige Discord-Anfrage.'));
    const result = this.queue.then(() => this.perform(method, path, body, image));
    this.queue = result.catch(() => {});
    return result;
  }
  async perform(method, path, body, image) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = { Authorization: `Bot ${this.token}`, 'User-Agent': 'DiscordBot (https://crazybatto.de, 1.0.0)' };
      let payload;
      if (image) {
        payload = new FormData();
        payload.append('payload_json', JSON.stringify(body));
        payload.append('files[0]', new Blob([image.bytes], { type: image.mime }), image.name);
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let response;
      try {
        response = await this.fetch(API + path, { method, headers, body: payload, signal: AbortSignal.timeout(20000), redirect: 'error' });
      } catch {
        throw new DiscordError(method === 'GET' ? 'Discord ist gerade nicht erreichbar. Bitte die Internetverbindung prüfen.' : 'Die Antwort von Discord ist ausgeblieben. Bitte zuerst in Discord prüfen, ob die Änderung angekommen ist, bevor du sie erneut ausführst.', 0);
      }
      let data;
      try { data = response.status === 204 ? null : await response.json(); } catch { throw new DiscordError('Discord hat eine unlesbare Antwort gesendet.', response.status); }
      if (response.status === 429) {
        const seconds = Number(data?.retry_after ?? response.headers.get('retry-after') ?? 1);
        if (attempt === 3 || !Number.isFinite(seconds) || seconds > 60) throw new DiscordError('Discord begrenzt gerade die Anfragen. Bitte etwas warten und erneut versuchen.', 429);
        await this.sleep(Math.max(250, seconds * 1000 + 100));
        continue;
      }
      if (!response.ok) {
        const messages = {401:'Der Bot-Token ist ungültig oder wurde zurückgesetzt.',403:'Dem Bot fehlen die nötigen Discord-Berechtigungen. Prüfe auch seine Rollenposition.',404:'Der Server, Kanal oder Eintrag wurde nicht gefunden.',400:'Discord hat die Eingaben abgelehnt. Prüfe Textlängen, Bildformat und Server-Freischaltungen.'};
        const code = typeof data?.code === 'number' ? data.code : undefined;
        const message = messages[response.status] || 'Discord konnte die Anfrage gerade nicht bearbeiten.';
        throw new DiscordError(`${message}${code ? ` (Discord-Code ${code})` : ''}`, response.status, code);
      }
      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset-after'));
        if (reset > 0 && reset <= 60) await this.sleep(reset * 1000 + 100);
      }
      return data;
    }
  }
}
module.exports = { DiscordClient, DiscordError, API };
