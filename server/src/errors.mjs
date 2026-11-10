export class AppError extends Error {
  constructor(kind, message, status = 400, retryAfterMs = 0) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.status = status;
    if (retryAfterMs > 0) this.retryAfterMs = Math.ceil(retryAfterMs);
  }
}

export function safeMessage(value) {
  return String(value || 'Die Anfrage konnte nicht abgeschlossen werden.')
    .replace(/https?:\/\/\S+/gi, '[Adresse entfernt]')
    .replace(/\b(?:Bearer|Bot)\s+\S+/gi, '[Anmeldung entfernt]')
    .replace(/\b(?:access_token|refresh_token|client_secret|token|secret)\s*[:=]\s*\S+/gi, '[Geheimnis entfernt]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<[^>]*>/g, '')
    .slice(0, 1000);
}

export function errorBody(error) {
  const known = error instanceof AppError;
  return {
    ok: false,
    kind: known ? error.kind : 'network',
    message: known ? safeMessage(error.message) : 'Der Server konnte die Anfrage nicht abschließen. Bitte später erneut versuchen.',
    ...(known && error.kind === 'access' && error.access ? { access: error.access } : {}),
    ...(known && error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {})
  };
}

export function assert(condition, message, kind = 'validation', status = 400) {
  if (!condition) throw new AppError(kind, message, status);
}
