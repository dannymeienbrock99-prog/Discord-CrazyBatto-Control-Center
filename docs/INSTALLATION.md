# Einrichtung auf eigenen Systemen

## Server

1. Node.js ab 24.17 installieren. Im Ordner `server` mit `npm ci` die gesperrten Abhängigkeitsversionen installieren.
2. `server/.env.example` privat nach `.env` kopieren und die Werte aus `CONFIGURATION.md` setzen. Echte Werte gehören weder in Git noch in Screenshots/Fehlerberichte.
3. Eine eigene Discord-Anwendung mit Bot, OAuth-Weiterleitung auf `PUBLIC_ORIGIN/oauth/callback` und bei Verwendung der Portal-Anmeldung auf `PUBLIC_ORIGIN/portal/callback` einrichten. Den Bot in den eigenen Server aufnehmen. Die erforderlichen Rechte hängen von den aktivierten Funktionen ab; Rollenrechte und Rollenposition separat kontrollieren.
4. Im Developer Portal den Server Members Intent für automatische Beitrittsrollen/Willkommen aktivieren. Funktionen für Nachrichten-/Mitgliederereignisse nur mit den benötigten Intents einschalten. Aktionen und Interaktionen über die Oberfläche am eigenen Server registrieren.
5. Eigenes E-Mail-Auth-Projekt einrichten, E-Mail-Bestätigung aktivieren und die Weiterleitung auf `PUBLIC_ORIGIN/registrierung.html?confirmed=1` zulassen. Projekt-URL und Publishable Key privat in `.env` speichern; keinen Service-Role-Schlüssel im Browser oder Desktop hinterlegen.
6. Einen HTTPS-Reverse-Proxy vor den lokalen Node-Dienst stellen. `PUBLIC_ORIGIN` muss die öffentliche HTTPS-Origin ohne Unterpfad sein. `TRUST_PROXY=1` nur verwenden, wenn der Dienst ausschließlich hinter dem vertrauenswürdigen Proxy erreichbar ist.
7. Mit `npm start` starten, das eigene Betreiberkonto registrieren, E-Mail bestätigen und einmal anmelden. Für eine leere Installation gibt es absichtlich keinen öffentlich erreichbaren „Mach mich zum Admin“-Schalter.
8. Die Konto-UUID aus der eigenen privaten Kontoverwaltung übernehmen, in `BATTO_SUITE_OWNER_ID` setzen und den Dienst stoppen. Dann lokal `node --env-file=.env scripts/bootstrap-operator.mjs` ausführen. Das Skript gibt nur ein bereits vorhandenes, E-Mail-bestätigtes und nicht gesperrtes Konto frei. Den Dienst anschließend wieder starten.
9. Im Center anmelden und Zielkanäle, Rollen, Bilder, Formulare, Live-Creator, Benachrichtigungen und optionalen Medienspeicher einrichten. Vor Veröffentlichungen Impressum/Kontaktangaben und Einladung in den Website-Dateien ergänzen; die Exportversion enthält Platzhalter.

Die Datenbank wird beim ersten Start erzeugt. `data/` und der Verschlüsselungsschlüssel müssen gemeinsam privat gesichert werden. Änderungen vorhandener Produktivdaten sind kein Bestandteil dieses Quellcode-Exports.

## Windows-Desktop

Im Ordner `desktop` zuerst `npm ci` ausführen. Die private `.env` enthält `VITE_DISCORD_CLIENT_ID` für den Build. Electron benötigt dieselbe Bot-ID als Prozessvariable `CONTROL_DISCORD_CLIENT_ID`; es liest diese Datei nicht automatisch. Beispiel für eine lokale PowerShell-Sitzung:

```powershell
$env:CONTROL_DISCORD_CLIENT_ID = 'DEINE_BOT_ID'
npm run build
npm start
```

Die ID ist keine Bot-Berechtigung und kein Token. Der tatsächliche Bot-Token bleibt auf dem Server. Für eine installierte App die Variable privat als Windows-Benutzervariable setzen und die App neu starten. `npm run package` erstellt NSIS-Installer und portable EXE unter `desktop/release/`. Diese Dateien sind ignoriert und werden nicht automatisch hochgeladen oder veröffentlicht.

Die Website-Adresse wird in der App gewählt und die Betreiberanmeldung geprüft. SFTP verwendet eigene lokale Verbindungsprofile. Einmalige Hostschlüssel-Freigaben prüfen; gespeicherte Profile, Passwörter und lokale BetterDiscord-Konfigurationen nicht in Git übernehmen.

## Stream Deck

Im Ordner `streamdeck-plugin` mit `npm ci`, `npm test`, `node scripts/build-assets.cjs` und `npm run validate` prüfen. `npm run package` erzeugt das private Pluginpaket unter `streamdeck-plugin/release/`. Stream Deck ab 7.1 verwaltet die benötigte Node-24-Laufzeit. Das Paket lokal installieren, Control Center ab 3.6.0 öffnen und dort unter **Stream Deck** die Verbindung einschalten. Den angezeigten Schlüssel in der Plugin-Einstellung mit **Verbinden** übernehmen. Das Center und das Plugin verwenden nur die lokale Verbindung auf diesem PC.

Spotify im Center oder auf der eigenen Website verbinden und das gewünschte Spotify-Gerät öffnen. Spotify-Gerätesteuerung und die Bot-Wiedergabe aus der eigenen Mediathek sind getrennte Abläufe; Spotify-Audio wird nicht durch den Bot weitergeleitet. Die Verwaltungsaktionen hinter einer geöffneten Center-Seite bleiben bewusste Benutzerentscheidungen.

## Android-Control

Den Ordner `android-control` in Android Studio öffnen. Benötigt werden SDK 36 und JDK 17; die Gradle-Projektdateien sind enthalten. Alternativ mit einem installierten Gradle 8.14.3 `gradle :app:testDebugUnitTest :app:assembleDebug` ausführen. Der persönliche Debug-Build ist kein allgemein freigegebener Download.

Für einen anderen Host die URL-/Host-Angaben in `AndroidManifest.xml`, `ControlActivity.java`, `ControlLaunchUrl.java` und den Ressourcen passend aktualisieren. Für eine echte Trusted Web Activity den eigenen Signierzertifikat-Fingerabdruck in `CONTROL_APP_SIGNER_SHA256` und die Digital-Asset-Links-Zuordnung korrekt bereitstellen. Die private Signierdatei bleibt außerhalb des Repositories. Der bestehende Assetlinks-Endpunkt hängt am separat verifizierten Chat-App-Release; ohne dieses optionale Release müssen die eigenen Digital Asset Links unabhängig statisch bereitgestellt werden. Andernfalls öffnet sich die sichere Browserdarstellung, jedoch ohne bestätigten TWA-Vollbildmodus.

Auf dem Handy anmelden, Benachrichtigungen erlauben, Testnachricht auslösen und Ton/Pop-up prüfen. Android-Energiesparen, „Nicht stören“ und abgeschaltete Kanäle können die Darstellung beeinflussen. Eine Registrierung am Server allein garantiert keine sichtbare Handybenachrichtigung.

Nach dem Serverupdate die Handyverwaltung einmal öffnen, damit der aktive Benachrichtigungsdienst seine neue Version bestätigt. Setup-Hinweise bleiben bis dahin gespeichert; die Oberfläche zeigt an, ob Gaming-Setup-Mitteilungen bereits unterstützt werden. Die Aktualisierung der mobilen Website erfordert keine neue Android-APK.

## Robot-SchichtLog

`robot-schichtlog` separat in Android Studio öffnen; SDK 35 und JDK 17 verwenden. `gradle :app:assembleDebug` erstellt einen lokalen Build. Für Updates derselben installierten App wird derselbe private Signierschlüssel benötigt.

Die Verbindung wird für jedes Handy einzeln eingerichtet:

1. In Robot-SchichtLog unter **Fotospeicher** einen Gerätecode über die private Website-Verwaltung anlegen und anschließend in der App verbinden. Der Gerätename beschreibt das Handy; der geheime Code gehört ausschließlich ins Geräte-Token-Feld.
2. Im Control Center unter **Robot SchichtLog → Geräte** genau dieses Handy für die Auftragssynchronisierung freigeben. Eine Freigabe eines anderen Handys genügt nicht.
3. In der Handy-App unter **Control Center · Aufträge** die Synchronisierung einschalten und **Jetzt abgleichen** wählen. Dort stehen wartende Einträge, Fotozustand und letzter erfolgreicher Abgleich. Eine fehlende Freigabe wird ausdrücklich angezeigt.
4. Im Center **Aktive Einträge** öffnen; **Gelöschte Einträge** ist der separate Papierkorb. Auftragsdetails zeigen die zugeordneten Bilder. **Weitere Fotos laden** lädt bei größeren Aufträgen die Folgeseiten.

Zwischenstände aktualisieren denselben Schichteintrag. **Schicht beenden / Abmelden** speichert die eingegebene Schichtendzeit; der Auftrag bleibt für die nächste Anmeldung offen. Erst **Auftrag beenden** schließt ihn vollständig. Bei konkurrierenden Änderungen im Center die aktuelle Version laden und entscheiden. Ein bereits geöffnetes veraltetes Handyformular darf eine bestätigte Centerkorrektur nicht überschreiben.

Auftragsübertragung und Fotos haben getrennte Warteschlangen. Ohne Netz bleiben die Daten lokal; der Hintergrunddienst setzt die Übertragung später fort. Android-Energiesparen kann das verzögern. Einzelne fehlerhafte Bilder oder ungültige Altangaben werden mit Hinweis zurückgehalten, damit andere Datensätze weiter übertragen werden. Nach einer Korrektur kann die Übertragung ausdrücklich erneut angestoßen werden. NAS/WebDAV-/Ordnerziele sind optionale eigene Verbindungen und nicht im Repository vorkonfiguriert; für den Center-Abgleich muss der Website-Fotospeicher gewählt sein.

## Prüfung vor privater Nutzung

`npm test` jeweils in `server` und `desktop` ausführen. Die Tests verwenden synthetische Konten/IDs, temporäre Verzeichnisse und für die Integrationsprüfung lokale HTTP-/SFTP-Server. Die Desktop-Testumgebung muss Verbindungen zu `127.0.0.1` erlauben. Anschließend die eigenen Discord-Rechte, einen Serverbeitritt, eine Freigabe, ein Ticket und die Benachrichtigung auf dem eigenen Handy prüfen. Für Musik muss ein berechtigtes Mitglied tatsächlich in einem erreichbaren Sprachkanal sein.

