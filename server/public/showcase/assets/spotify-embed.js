const form = document.getElementById('spotifyForm');
const input = document.getElementById('spotifyLink');
const frame = document.getElementById('spotifyFrame');
const status = document.getElementById('spotifyStatus');
export function spotifyEmbed(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Bitte einen Spotify-Link zu einem Titel, Album oder einer Playlist eingeben.'); }
  const match = /^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.username || url.password || url.port || !match) throw new Error('Bitte einen gültigen Link von open.spotify.com verwenden.');
  return `https://open.spotify.com/embed/${match[1]}/${match[2]}`;
}
form.addEventListener('submit', event => {
  event.preventDefault();
  try {
    const url = spotifyEmbed(input.value.trim());
    if (!window.CBConsent?.allowsSpotify()) {
      status.textContent = 'Spotify ist gesperrt. Erlaube Spotify in den Cookie-Einstellungen und klicke danach erneut auf „Spotify laden“.';
      window.CBConsent?.openSettings();
      return;
    }
    document.getElementById('audioPlayer').pause();
    window.dispatchEvent(new CustomEvent('cb-spotify-embed-loading'));
    const iframe = document.createElement('iframe');
    iframe.title = 'Spotify Player'; iframe.src = url; iframe.height = '352';
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.referrerPolicy = 'no-referrer'; frame.replaceChildren(iframe);
    document.getElementById('spotifyDisconnect').hidden = false;
    status.textContent = 'Spotify ist eingebettet. Die Wiedergabe steuerst du direkt im Spotify-Player.';
  } catch (error) { status.textContent = error.message; }
});
function disconnect() { frame.replaceChildren(); document.getElementById('spotifyDisconnect').hidden = true; status.textContent = 'Spotify ist nicht geladen.'; }
document.getElementById('spotifyDisconnect').addEventListener('click', disconnect);
document.getElementById('audioPlayer').addEventListener('play', () => { if (frame.childElementCount) disconnect(); });
window.addEventListener('cb-spotify-sdk-playing', () => { if (frame.childElementCount) disconnect(); });
window.addEventListener('cb-consent-change', event => {
  if (!event.detail.spotify && frame.childElementCount) {
    disconnect();
    status.textContent = 'Spotify wurde durch deine Cookie-Auswahl entfernt und bleibt gesperrt.';
  }
});
