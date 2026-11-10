# Aufbau und Verantwortlichkeiten

Die Windows-App besteht aus React/Vite und einem Electron-Hauptprozess. Das Frontend erhält eine eng begrenzte IPC-Schnittstelle. Website-Verwaltung und Bot-Aktionen laufen über die authentifizierte Server-API; lokale SFTP-Verbindungen und die BetterDiscord-Brücke bleiben Aufgaben des eigenen PCs.

Die optionale Stream-Deck-Brücke bindet ausschließlich an `127.0.0.1:17654`. Ein lokal erzeugter, unter Windows geschützt gespeicherter und widerrufbarer Schlüssel erlaubt nur fest vorgegebene Aktionen. Anfragen aus Browser-Origin-Kontexten werden abgewiesen. Wartende Aktionen speichern die bei Annahme gültige Kontositzung und werden nach einem Kontowechsel verworfen. Das separate Plugin speichert seinen Schlüssel in lokalen globalen Einstellungen, nicht in exportierbaren Tastenprofilen.

Der Node-Server stellt Website-Dateien und APIs bereit. Er verwaltet Discord-Zugriff, Gateway-Ereignisse, Live-Abfragen, Mitgliederfreigaben, Tickets, PC-Aufträge, Gaming-Setups und Push-Zustellung. E-Mail-Anmeldung verwendet den konfigurierten Auth-Dienst. Konten und Verwaltungsdaten liegen im privaten SQLite-/Datenspeicher; Geheimnisse werden mit dem privaten Installationsschlüssel geschützt.

Die Android-Control-App öffnet die geschützte mobile Verwaltungsoberfläche als Trusted Web Activity. Der Android-Dienst unterstützt die Benachrichtigungsdelegation des vertrauenswürdigen Browsers. Ohne gültige Host-/Zertifikatsbindung ist ein Browser-Fallback möglich. Die serverseitige Autorisierung gilt unabhängig vom Gerät.

Robot-SchichtLog ist ein separates Android-Projekt. Seine optionale Website-Synchronisation verwendet die vorhandene Kontogrenze; Aufträge tragen Versionen, damit konkurrierende Nacharbeiten nicht stillschweigend überschrieben werden. Native Zugangssitzungen sind nicht mit Browser-Sitzungen gleichzusetzen.

## Wichtige Abläufe

- **Registrierung:** E-Mail-Anmeldung → Bestätigungs-E-Mail → Konto sichtbar → Admin entscheidet über Mitgliederfunktionen. Betreiberrechte entstehen nicht durch Registrierung.
- **Gaming-Setup:** Mitglied reicht ein → Admin prüft → Veröffentlichung auf Website und Discord-Forum. Fehlerzustände lassen sich prüfen und erneut synchronisieren.
- **Setup-Hinweis:** Jede eingereichte Version erhält einen dauerhaften Beleg. Offene ältere Einreichungen können bei der ersten Geräteanmeldung nachgemeldet werden; neue Entwürfe erzeugen keinen Hinweis. Erst wenn der aktive Handy-Service-Worker die Unterstützung bestätigt hat, werden Setup-Hinweise für dieses Gerät zugestellt. Alte Worker verlieren dadurch keine vorgemerkten Hinweise. Unmittelbar vor dem Versand werden Freigabestatus, Rücknahme und Version erneut geprüft. Bereits entschiedene oder ersetzte Einreichungen werden verworfen.
- **Bot-Musik:** Ein ausdrücklicher Beitritt bindet die Verbindung an den Initiator. Dessen Verlassen oder Kanalwechsel stoppt Wiedergabe und Warteschlange. Nach einem Gateway-Neuaufbau entscheidet erst der vollständige Sprachstatus über die Sitzung; verwaiste eigene Bot-Verbindungen werden getrennt. Veraltete wartende Beitrittsbefehle können eine gestoppte Sitzung nicht wiederherstellen.
- **PC-Auftrag:** Problemticket mit Pflichtangaben → optionaler Auftrag ab 10 € mit Kontakt → Betreiber bestätigt/ändert/ablehnt nach dem vorgesehenen Ablauf.
- **Meldung:** Person + Kategorie + Pflichtgrund → geschützter Fall → manuelle Teamentscheidung → Discord prüft die ausführbaren Rechte.
- **Handyhinweis:** Neues serverseitiges Ereignis → registriertes Betreibergerät → Push-Dienst/Browser → Android-Kanal. Vertrauliche Ticket- und Kontaktdetails gehören nicht in öffentliche Benachrichtigungstexte.

## Grenzen des Exports

Private Laufzeitdaten, produktive Datensätze, fremde BetterDiscord-Plugin-Dateien und fertige unabhängige Apps sind ausgeschlossen. Enthalten sind der aktuelle Control-Center-Code und der Website-Unterbau, auf den seine Funktionen angewiesen sind. Die optionalen Apps/Produktinformationen im Website-Menü sind eigene Module bzw. Verweise; deren fremde Quellprojekte werden durch dieses Repository nicht mitlizenziert oder vorgetäuscht.

