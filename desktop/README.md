# Crazy_Batto Control Center 3.6.1

Windows-App mit deutscher React-Oberfläche für die Website, Discord-Verwaltung, Mitgliederfreigaben, Meldungen, Gaming-Setups, Musik, PC-Hilfe und synchronisierte Robot-SchichtLog-Aufträge. Sie nutzt das vorhandene Administratorkonto der eigenen Serverinstallation.

Version 3.6.1 ergänzt die Fallmoderation mit privaten Abmahnungen, serverseitigem Stumm-/Entstummen, zeitweisen Discord-Sperren, Kick, Bann und Fallabschluss. Maßnahmen benötigen eine Begründung, einen aktuellen Fallstand und eine ausdrückliche Bestätigung. Der Verlauf bleibt erhalten; ungeklärte Ergebnisse werden nicht automatisch erneut ausgeführt.

Die lokale Stream-Deck-Verbindung aus Version 3.6.0 steuert Spotify, Bot-Musik und die Navigation. Sie verwendet eine widerrufbare, geschützte Kopplung und stellt keine Moderationsaktionen bereit. Die Handyverwaltung und deren Benachrichtigungen laufen über die zugehörige Website.

## Entwicklung und privater Installer

```sh
npm ci
npm test
npm run build
npm start
npm run package
```

Der Installer wird im lokalen Ordner `release/` gebaut. Zugangsdaten, Verbindungsprofile, Kopplungsschlüssel und fertige Programme werden nicht veröffentlicht. Der Dateimanager prüft SSH-Hostschlüssel; Sitzungstokens werden nicht an die Oberfläche weitergegeben. Discord-Rechte und die Rollenreihenfolge bleiben wirksam.

Einrichtung: [Installationsanleitung](../docs/INSTALLATION.md). Gesamtumfang und Grenzen: [Projektübersicht](../README.md). Nachgewiesene Prüfungen: [Validierung](../docs/VALIDATION.md).
