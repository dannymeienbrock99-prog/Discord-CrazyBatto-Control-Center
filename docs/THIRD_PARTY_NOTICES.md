# Drittanbieter und Rechte

Es wird keine neue pauschale Lizenz für den gesamten Repository-Inhalt behauptet. Der CRAZY_BATTO-/Team-Alpha-Name, Logo, hochgeladene Grafiken und erzeugte Banner bleiben getrennt von den jeweiligen Software-Abhängigkeiten zu betrachten.

- JavaScript-Abhängigkeiten werden über `package.json` und `package-lock.json` bezogen; ihre jeweiligen Lizenztexte liegen in den installierten Paketen. Dazu gehören React, Vite, Electron, electron-builder, lucide-react, ssh2-sftp-client, Discord-Voice-Abhängigkeiten, opusscript und web-push.
- Android verwendet Android/AndroidX-Komponenten und Android Browser Helper. Deren Lizenzbedingungen gelten eigenständig.
- Das eigene Stream-Deck-Plugin verwendet die dokumentierte Elgato-Schnittstelle. `@elgato/cli` ist ein Entwicklungswerkzeug, `ws` wird für lokale Protokolltests genutzt; die Laufzeitimplementierung benötigt keine gebündelten npm-Abhängigkeiten. Fremde Spotify-/Marketplace-Plugins werden nicht mitgeliefert.
- Der mitgelieferte Oxanium-Schriftfont enthält seine vorhandene OFL unter `server/public/showcase/assets/fonts/OFL-Oxanium.txt`.
- Die vorhandene Icon-Lizenz bleibt unter `server/public/showcase/assets/player-icons/LICENSE.txt` erhalten. Robot-SchichtLog enthält seine vorhandenen Lucide-Hinweise unter `app/src/main/res/raw/lucide_license.txt`.
- Die eigene Datei `desktop/electron/betterdiscord/CrazyBattoControl.plugin.js` wird aus den eigenen lokalen Brückenmodulen gebaut. BDFDB, StaffTag, MoreRoleColors, RemovedConnectionAlerts, ShowSpectators, SpotifyEnhance, VoiceMessages, AllCallTimeCounter und ChatFilter werden **nicht** mitgebündelt. Nutzer installieren passende Versionen nach den Regeln der jeweiligen Urheber selbst.
- Die lokale Brücke erweitert keine Discord-Bot-Rechte und kann Einstellungen fremder Clients nicht ändern. Kompatibilität hängt von den installierten Drittanbieter-Versionen ab.

