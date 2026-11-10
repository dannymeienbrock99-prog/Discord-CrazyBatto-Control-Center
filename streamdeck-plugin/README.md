# Crazy_Batto · Stream Deck Control

Eigenes Windows-Plugin für das **Crazy_Batto Control Center ab 3.6.0**. Voraussetzung: Stream Deck **7.1 oder neuer**; der mitgelieferte Node-24-Pluginruntime wird von Stream Deck verwaltet.

## Einrichten

1. Das neue Control Center installieren und auf diesem PC öffnen. Mit dem eigenen Website-Konto anmelden.
2. Im Center **Stream Deck** öffnen, die lokale Verbindung einschalten und den Verbindungsschlüssel kopieren.
3. Die Datei `CrazyBatto-Control-Center-1.0.0.streamDeckPlugin` doppelt anklicken und das eigene Plugin in Stream Deck hinzufügen.
4. Unter **Crazy_Batto Control Center** eine Aktion auf eine Taste ziehen. Im Einstellungsbereich den Schlüssel einfügen und **Verbinden** anklicken. Diese Kopplung gilt für alle Tasten des Plugins.
5. Gewünschte Aktion, Spotify-Gerät oder Control-Center-Seite wählen. Das Center muss geöffnet bleiben. Die Spotify-Anmeldung erfolgt im Center; der Bot verwendet dessen bestehende Website-Verbindung.

Wenn die Kopplung im Center zurückgesetzt wurde, den neuen Schlüssel hier erneut mit **Verbinden** übernehmen. **Aktualisieren** prüft den Status. **Kopplung entfernen** löscht die Verbindung dieses Plugins; die Sperrung/Rotation im Center entzieht dem alten Schlüssel die Gültigkeit.

## Steuerung

| Tasten | Möglichkeiten |
|---|---|
| Spotify · Wiedergabe | Start/Pause umschalten, ausdrücklich starten oder pausieren; aktuellen Titel anzeigen. |
| Spotify · Nächster/Vorheriger Titel | Wiedergabe vor- oder zurückschalten. |
| Spotify · Lautstärke | 5 % lauter/leiser oder einen festen Wert von 0 bis 100 setzen. |
| Spotify · Zufall / Wiederholen | Zufall umschalten; Wiederholung zwischen Aus, Alles und Titel wechseln. |
| Spotify · Gerät wechseln | Eines der verfügbaren Spotify-Geräte auswählen. Spotify auf dem Zielgerät öffnen und die Liste aktualisieren. |
| Spotify · Favorit starten | Offiziellen Spotify-Link oder URI für einen Titel, ein Album oder eine Playlist hinterlegen und per Taste starten. |
| Bot · Meinem Sprachkanal beitreten | Den bestehenden Bot in den Sprachkanal des verbundenen Discord-Mitglieds holen. |
| Bot · Sprachkanal verlassen | Musik stoppen und die Sprachverbindung beenden. |
| Bot · Musik steuern | Start/Pause, ausdrücklich starten/pausieren; optional Titel- oder Playlist-ID aus der eigenen Mediathek. Ohne ID verwendet das Center die aktuelle Wiedergabe bzw. seinen Standardtitel. |
| Bot · Vorheriger/Nächster Titel, Lautstärke | Die Mediathek-Wiedergabe und Bot-Lautstärke steuern. |
| Control Center · Bereich öffnen | Alle 33 Bereiche erreichen, unter anderem Mitglieder, Meldungen, Tickets, PC-Hilfe, Robot-Aufträge, Einbettungen, Kalender, Server, Rollen und Dateien. Veröffentlichungen und Verwaltungsentscheidungen prüfst du anschließend im Center. |

Spotify steuert **deine Spotify-Geräte**. Der Discord-Bot spielt **deine eigene Mediathek** ab. Die Spotify-API stellt dem Bot keinen Audio-Stream zum Weiterleiten zur Verfügung. Die Verfügbarkeit der Spotify-Steuerung hängt von Kontoberechtigungen und einem erreichbaren Spotify-Gerät ab.

Der Bot verlässt den Sprachkanal entsprechend der serverseitigen Besitzer-/Sprachkanalverwaltung des Centers. Diese Entscheidung erfolgt auf dem Server und ist nicht von einer gedrückten Stream-Deck-Taste abhängig.

## Datenschutz und Grenzen

- Keine Bot-, Spotify- oder Website-Anmeldedaten im Pluginpaket. Es wird nur der lokal erzeugte, widerrufbare Control-Center-Schlüssel verwendet.
- Der Schlüssel wird in den lokalen globalen Stream-Deck-Einstellungen gespeichert. Er wird nicht in einzelne Tasten, exportierte Profile oder die Plugin-Installationsdatei geschrieben.
- Das Plugin verbindet sich ausschließlich mit `127.0.0.1:17654` auf diesem PC. Webseiten rufen diese Verbindung nicht direkt auf; der lokale Node-Prozess übernimmt die Anfragen.
- Es gibt keine frei eingebbaren Serveradressen oder beliebigen Verwaltungsbefehle. Die erlaubten Aktionen sind fest vorgegeben. Im Einstellungsbereich werden Geräte und Titelnamen als Text dargestellt.
- Der Status wird für alle Tasten gemeinsam höchstens alle zehn Sekunden automatisch abgefragt; ausgeführte Aktionen und manuelle Aktualisierung lösen eine aktuelle Prüfung aus.
- Tasten in Stream-Deck-Mehrfachaktionen sind bewusst nicht freigegeben. Verwaltungsentscheidungen und Veröffentlichungen erfolgen im Center.

## Quellen und Paketbau

```sh
npm ci
npm test
node scripts/build-assets.cjs
npm run validate
npm run package
```

Das Paket enthält ausschließlich `de.crazybatto.controlcenter.sdPlugin/`. Entwicklungswerkzeuge, Tests und Referenzarchive werden nicht mitgeliefert. Das Laufzeitplugin benötigt keine zusätzlichen npm-Pakete.

Dieses Plugin ist eine eigene Implementierung. Fremde Spotify-Plugins und Marketplace-Pakete sind nicht enthalten.

Offizielle Grundlagen: [Elgato Plugin-Laufzeit](https://docs.elgato.com/streamdeck/sdk/introduction/plugin-environment/), [WebSocket-API](https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/), [Property Inspector](https://docs.elgato.com/streamdeck/sdk/references/websocket/ui/), [Paketbau](https://docs.elgato.com/streamdeck/cli/commands/pack/).

Die automatisierten Tests enthalten einen echten lokalen WebSocket-/HTTP-Protokolltest mit erfundenem Schlüssel. Eine reale Spotify-Wiedergabe, ein echter Discord-Beitritt und das Drücken einer Hardwaretaste werden dadurch nicht vorgetäuscht.
