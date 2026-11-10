# Private Konfiguration

Die öffentliche Version enthält keine Zuordnung zum bestehenden Discord-Server oder E-Mail-Projekt. Die sichtbare Marke und öffentliche Website-Adresse `crazybatto.de` sind bewusst erhalten. Persönliche Server-IP, Ports eines vorhandenen Deployments, Konto- und Kanalzuordnungen sowie gespeicherte Zugänge sind nicht enthalten. `8080` und `127.0.0.1` in Beispielen sind lokale Standardwerte.

| Einstellung | Zweck |
| --- | --- |
| `PUBLIC_ORIGIN` | Öffentliche HTTPS-Adresse der eigenen Installation, ohne Pfad. |
| `HOST`, `PORT` | Lokale Bind-Adresse und Port des Node-Dienstes. |
| `DATA_DIR` | Privates persistentes Datenverzeichnis außerhalb der veröffentlichten Assets. |
| `TRUST_PROXY` | Vertrauen in den vorgeschalteten, ausschließlich erreichbaren eigenen Proxy. |
| `DISCORD_CLIENT_ID` | Eigene Bot-/Anwendungs-ID; steuert auch die Identitätsprüfung der Community-Funktionen. |
| `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` | Private Discord-Zugänge, ausschließlich serverseitig. |
| `DISCORD_PUBLIC_KEY` | Öffentlicher Discord-Interaktionsprüfschlüssel der eigenen Anwendung. |
| `DISCORD_GUILD_ID`, `OWNER_DISCORD_ID` | Eigener Server und verantwortliches Discord-Konto. |
| `DISCORD_INVITE_URL` | Eigene Einladung für den serverseitig angelegten Verzeichniseintrag. Statische Website-Einladungen separat ersetzen. |
| `TOKEN_ENCRYPTION_KEY` | 32 zufällige Bytes als 64 Hex-Zeichen. Zum Beispiel lokal mit `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` erzeugen und ausschließlich privat speichern. |
| `ACCOUNT_SUPABASE_URL`, `ACCOUNT_SUPABASE_PUBLISHABLE_KEY` | Eigenes E-Mail-Auth-Projekt mit bestätigungspflichtiger Anmeldung. |
| `BATTO_SUITE_OWNER_ID` | UUID des persönlich freigegebenen Website-Betreibers, keine Discord-ID. |
| `MUSIC_BOT_ENABLED` | `1` aktiviert die konfigurierte Musik-Bot-Funktion. |
| `MUSIC_STORAGE_URL`, `MUSIC_STORAGE_TOKEN` | Eigener optionaler Mediendienst und sein privater Zugang. |
| `CHAT_APP_SIGNER_SHA256`, `CONTROL_APP_SIGNER_SHA256` | Öffentliche SHA-256-Fingerabdrücke der eigenen Android-Signierzertifikate; keine privaten Schlüssel. |
| `APK_PATH`, `CHAT_APP_APK_PATH`, `MUSIC_REMOTE_APK_PATH` | Optionale, separat verwaltete App-Dateien. Ohne passende Dateien bleiben diese unabhängigen Downloadfunktionen nicht verfügbar. |
| Desktop `CONTROL_DISCORD_CLIENT_ID` | Prozessvariable für die Prüfung der serverseitig gemeldeten Bot-Identität. |
| Desktop `VITE_DISCORD_CLIENT_ID` | Beim Frontend-Build angezeigte Bot-ID. |

Die serverseitigen Identitätskonstanten haben synthetische Fallbacks ausschließlich für die lokalen Testfixtures. Eine echte Installation benötigt korrekte private Umgebungsvariablen; die Tests gewähren keinen Produktivzugriff. Neue Rollen-/Kanal-Zuordnungen werden später im Center gespeichert, nicht in Quellcode-Dateien.

Die optionalen älteren App-Release-Routen prüfen Metadaten, Pakete, Hashes und Zertifikate. Für eigene Versionen müssen diese veröffentlichten Paketmetadaten bewusst zusammenpassen; vorhandene fremde APKs dürfen nicht einfach unter den erwarteten Namen gelegt werden.

Der Export ersetzt die feste Produktionsidentität in `community-schema`, `discord-control`, `gaming-setups`, `join-requests`, `discord-directory` und der Desktop-Website-Brücke durch Konfiguration. Tests wurden konsistent mit erfundenen IDs neu aufgebaut. Private Zuordnungstabellen werden nicht veröffentlicht.

