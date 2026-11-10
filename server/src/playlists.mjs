import { randomUUID } from 'node:crypto';
import { assert } from './errors.mjs';
import { trackView } from './account-store.mjs';

export class Playlists {
  constructor(accounts) {
    this.accounts = accounts; this.store = accounts.store;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS music_playlists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES accounts(id), revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS music_playlist_tracks (
      playlist_id TEXT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL,
      PRIMARY KEY(playlist_id,track_id), UNIQUE(playlist_id,position));`);
  }
  list() { return this.store.all('SELECT * FROM music_playlists ORDER BY created_at,id').map(row => this.view(row)); }
  view(row) { return { id: row.id, name: row.name, createdBy: row.created_by, revision: row.revision,
    trackIds: this.store.all('SELECT track_id FROM music_playlist_tracks WHERE playlist_id=? ORDER BY position', row.id).map(x => x.track_id) }; }
  tracks(id = 'all') {
    if (id === 'all') return this.store.all('SELECT * FROM music_tracks ORDER BY created_at,id').map(trackView);
    assert(this.store.get('SELECT 1 FROM music_playlists WHERE id=?', id), 'Diese Playlist ist nicht vorhanden.', 'not_found', 404);
    return this.store.all('SELECT t.* FROM music_playlist_tracks p JOIN music_tracks t ON t.id=p.track_id WHERE p.playlist_id=? ORDER BY p.position', id).map(trackView);
  }
  manage(context, row = null) {
    const user = this.accounts.assertCurrent(context);
    assert(user.isAdmin || user.canUpload && (!row || row.created_by === user.id), 'Nur freigegebene Musik-Konten dürfen ihre Playlists verwalten.', 'forbidden', 403);
    return user;
  }
  save(context, body, id = null) {
    const row = id ? this.store.get('SELECT * FROM music_playlists WHERE id=?', id) : null;
    if (id) assert(row, 'Diese Playlist ist nicht vorhanden.', 'not_found', 404);
    const user = this.manage(context, row);
    assert(body && Object.keys(body).every(k => ['name','trackIds','revision'].includes(k)), 'Ungültige Playlist-Angaben.');
    assert(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(body.name), 'Bitte einen Namen mit maximal 80 Zeichen eingeben.');
    assert(Array.isArray(body.trackIds) && body.trackIds.length <= 500 && body.trackIds.every(x => typeof x === 'string') && new Set(body.trackIds).size === body.trackIds.length, 'Höchstens 500 verschiedene Titel pro Playlist.');
    if (row) assert(body.revision === row.revision, 'Die Playlist wurde zwischenzeitlich geändert. Bitte neu laden.', 'conflict', 409);
    else assert(this.store.get('SELECT COUNT(*) AS n FROM music_playlists').n < 200, 'Es können höchstens 200 Playlists angelegt werden.');
    for (const track of body.trackIds) assert(this.store.get('SELECT 1 FROM music_tracks WHERE id=?', track), 'Mindestens ein Titel wurde entfernt. Bitte die Playlist aktualisieren.');
    const key = id || randomUUID(), now = this.accounts.now();
    this.store.transaction(() => {
      if (row) this.store.run('UPDATE music_playlists SET name=?,revision=revision+1,updated_at=? WHERE id=?', body.name.trim(), now, key);
      else this.store.run('INSERT INTO music_playlists(id,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?)', key, body.name.trim(), user.id, now, now);
      this.store.run('DELETE FROM music_playlist_tracks WHERE playlist_id=?', key);
      body.trackIds.forEach((track, i) => this.store.run('INSERT INTO music_playlist_tracks VALUES (?,?,?)', key, track, i));
    });
    return this.view(this.store.get('SELECT * FROM music_playlists WHERE id=?', key));
  }
  remove(context, id) {
    const row = this.store.get('SELECT * FROM music_playlists WHERE id=?', id);
    assert(row, 'Diese Playlist ist nicht vorhanden.', 'not_found', 404); this.manage(context, row);
    this.store.run('DELETE FROM music_playlists WHERE id=?', id); return { ok: true };
  }
}
