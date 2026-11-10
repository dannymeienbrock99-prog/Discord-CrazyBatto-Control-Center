import path from 'node:path';

export function readConfig(env = process.env) {
  const errors = [];
  let publicOrigin = '';
  try {
    const url = new URL(env.PUBLIC_ORIGIN || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    publicOrigin = url.origin;
  } catch {
    errors.push('PUBLIC_ORIGIN muss die HTTPS-Adresse dieses Servers ohne Unterpfad sein.');
  }
  const clientId = String(env.DISCORD_CLIENT_ID || '').trim();
  if (!/^\d{17,20}$/.test(clientId)) errors.push('Die Discord-Anwendungs-ID fehlt oder ist ungültig.');
  const clientSecret = String(env.DISCORD_CLIENT_SECRET || '').trim();
  const botToken = String(env.DISCORD_BOT_TOKEN || '').trim();
  if (!clientSecret) errors.push('Das Discord-Client-Secret fehlt.');
  if (!botToken) errors.push('Der Discord-Bot-Token fehlt.');
  const ownerDiscordId = String(env.OWNER_DISCORD_ID || '').trim();
  const accessConfigured = /^\d{17,20}$/.test(ownerDiscordId);
  if (!accessConfigured) errors.push('OWNER_DISCORD_ID muss die Discord-Konto-ID des Betreibers enthalten.');
  const apkVersion = String(env.APK_VERSION || '2.3.0').trim();
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,30})?$/.test(apkVersion)) throw new Error('APK_VERSION ist ungültig.');
  const keyHex = String(env.TOKEN_ENCRYPTION_KEY || '').trim();
  const key = /^[a-fA-F0-9]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;
  if (!key) errors.push('TOKEN_ENCRYPTION_KEY muss aus 64 zufälligen Hex-Zeichen bestehen.');
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT ist ungültig.');
  const accountSupabaseUrl = String(env.ACCOUNT_SUPABASE_URL || '').trim();
  const accountSupabaseKey = String(env.ACCOUNT_SUPABASE_PUBLISHABLE_KEY || '').trim();
  return {
    publicOrigin, clientId, clientSecret, botToken, encryptionKey: key, ownerDiscordId, accessConfigured,
    suiteOwnerId: String(env.BATTO_SUITE_OWNER_ID || '').trim(),
    redirectUri: publicOrigin ? publicOrigin + '/oauth/callback' : '',
    portalRedirectUri: publicOrigin ? publicOrigin + '/portal/callback' : '',
    apkPath: path.resolve(env.APK_PATH || './releases/Crazy_Batto-Discord-App-' + apkVersion + '.apk'),
    apkVersion, apkFilename: 'Crazy_Batto-Discord-App-' + apkVersion + '.apk',
    chatAppApkPath: path.resolve(env.CHAT_APP_APK_PATH || './releases/Crazy_Batto-Chat-1.0.0.apk'),
    musicRemoteApkPath: env.MUSIC_REMOTE_APK_PATH ? path.resolve(env.MUSIC_REMOTE_APK_PATH) : '',
    musicRemoteApk: Object.freeze({ applicationId: 'de.crazybatto.music', version: '1.0.0', versionCode: 1,
      filename: 'Crazy_Batto-Musik-1.0.0.apk', sha256: '4e4cdf67d0ee2e47574ad92241643e34d2c7d3dba8de5e2ed256aa89f2c76a9b' }),
    configured: errors.length === 0, configurationMessage: errors.join(' '),
    discordConfigured: errors.filter(error => !error.startsWith('OWNER_DISCORD_ID')).length === 0,
    accountSupabaseUrl, accountSupabaseKey,
    musicBotEnabled: env.MUSIC_BOT_ENABLED === '1',
    musicStorageUrl: String(env.MUSIC_STORAGE_URL || '').trim(),
    musicStorageToken: String(env.MUSIC_STORAGE_TOKEN || '').trim(),
    discordPublicKey: String(env.DISCORD_PUBLIC_KEY || '').trim(),
    discordGuildId: String(env.DISCORD_GUILD_ID || '').trim(),
    port, host: String(env.HOST || '0.0.0.0'),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    trustProxy: env.TRUST_PROXY === '1',
    sessionLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    portalSessionLifetimeMs: 7 * 24 * 60 * 60 * 1000
  };
}
