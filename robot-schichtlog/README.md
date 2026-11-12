# Robot SchichtLog 1.9.0

**Zwischenstand speichern** aktualisiert deinen Schichtstand, ohne den Auftrag zu schließen oder die Menge doppelt zu zählen. Bekannte Artikelnummern werden vorgeschlagen, bevorzugt HE-Nummern. Eingaben bleiben auch nach Navigation und App-Neustart erhalten.

**Schicht beenden / Abmelden** verlangt Datum und Uhrzeit des tatsächlichen Schichtendes, speichert den Stand und meldet dich ab. Der Auftrag bleibt offen. Bei der nächsten Anmeldung beginnt ein neuer Schichtstand mit Menge null. Nur **Auftrag endgültig beenden** schließt den gesamten Auftrag. Die nächste Schicht wird ab 15 Minuten vor 06:00, 14:00 und 22:00 erkannt.

Der Verlauf zeigt übersichtliche Karten im gewählten Design. **Auftrag als TXT teilen** erstellt eine echte Textdatei mit dem chronologischen Auftragsverlauf und öffnet die Android-Auswahl. Bilder werden als Anhangsnamen erwähnt, nicht in die Textdatei eingebettet. Es wird nichts automatisch versendet.

Die Übertragung sendet Auftragsstände vor größeren Bildmengen und zeigt ausstehende Einträge, den letzten erfolgreichen Abgleich und fehlende Gerätefreigaben. Eine akzeptierte Korrektur aus dem Control Center aktualisiert den gespeicherten Entwurf; ein veraltetes offenes Formular muss bewusst neu geladen werden.

Version 1.9.0 verwendet Versionscode 10 und Datenbankversion 6. Die Migration erhält ältere Einträge, Fotos, Übertragungskennungen und offene Aufträge. Die vorhandene App als Update installieren, nicht vorher deinstallieren.

## Verbindung und bisherige Funktionen

Ein Update benötigt dieselbe Paketkennung und den bisherigen eigenen Signierschlüssel. Die Datenbankmigration von Version 4 oder 5 auf Version 6 erhält Einträge, Bilder, Personalnummern, offene Übertragungen und den laufenden lokalen Auftrag. Signierschlüssel und APKs sind nicht Teil dieses öffentlichen Quellcode-Exports.

Unter **Control Center · Aufträge verbinden** aktivierst du die Auftrags-Synchronisierung. Zuvor den Fotospeicher auf crazybatto.de koppeln und das Handy im Control Center zusätzlich für Aufträge freigeben. Diese Freigabe ist getrennt von der Fotofreigabe und standardmäßig aus.

Aufträge werden versioniert übertragen. Nachträgliche Änderungen und Papierkorb-Aktionen im Center kommen beim nächsten erfolgreichen Abgleich zurück. Gleichzeitige Änderungen bleiben als Konflikt erhalten, bis du im Center einen Stand auswählst. Der aktive Maschinenauftrag wird nicht fernbedient. Die Hintergrundübertragung hängt von Androids Netzwerk- und Energieregeln ab; **Jetzt abgleichen** plant einen sofortigen Auftrag ein.

## Erfassung und Designs

Android-App zum Erfassen von Aufträgen, Ereignissen und Schichtübergaben an acht Robotern. Drei auswählbare Designs mit eigenen Roboterbildern bleiben verfügbar. Für ein Update vorhandener privater Installationen denselben eigenen Signierschlüssel verwenden.

## Design auswählen

Oben auf **Design** tippen. **Schweißlicht** kombiniert einen orangefarbenen Schweißroboter mit dunklen Flächen. **Werkstatt Weiß** zeigt einen silbernen Roboter in einer hellen Werkstatt. **CAD-Nachtschicht** zeigt die Roboterzelle in einer technischen Ansicht mit türkisen Akzenten.

Eine Variante wählen und bei Bedarf das Vorschaubild zur Vergrößerung antippen. Mit **Übernehmen** wird das Design auf diesem Handy gespeichert. Beim ersten Start ist **Schweißlicht** ausgewählt. Im laufenden Auftrag erscheinen die tatsächlichen Auftragsdaten und Fotos anstelle der Beispieldaten aus der Vorschau.

## Aufträge und Fotos

Beim Starten eines Auftrags und beim Anmelden zur nächsten Schicht die eigene Personalnummer eingeben, zum Beispiel `0007`. Sie bleibt für diese angemeldete Schicht hinterlegt; führende Nullen bleiben erhalten. Der Verlauf und der CSV-Export zeigen, wer welchen Vorgang erfasst hat.

Unter **Auftrag → Fotos hinzufügen** mehrere Bilder auswählen. Im Verlauf lassen sich auch zu einem abgeschlossenen Auftrag weitere Fotos ergänzen. Auftrag und Artikel bestimmen die Galerie. Sie zeigt die neuesten Bilder zuerst. Ein Tipp auf ein Vorschaubild öffnet die Großansicht. Im manuellen Eintrag kann man wie bisher auch Videos verknüpfen.

## Privaten Fotobereich verbinden

1. In der App **Fotospeicher** öffnen und **Geräte-Token auf crazybatto.de holen** antippen. Auf der Webseite mit dem für Robot SchichtLog freigeschalteten Konto anmelden. [Privaten Fotobereich öffnen](https://crazybatto.de/robot-schichtlog/)
2. Unter **Handys** für das gewünschte Handy **Fotos in der App ansehen** einschalten. Bei einem schon gekoppelten Gerät reicht dieses Häkchen. Für ein neues Handy einen Gerätenamen eintragen, die Freigabe auswählen, **Gerätecode erstellen** wählen und den einmalig angezeigten Code kopieren.
3. Zur App zurückkehren, den Code in **Geräte-Token** einfügen und **crazybatto.de verbinden** antippen. Die App prüft den Code, bevor sie das erste Foto überträgt.
4. Im Auftrag **Fotos hinzufügen** wählen. Sobald die Webseite die Kopie bestätigt, erscheint in der App-Galerie **Privat auf crazybatto.de**.

## Bilder auf dem Handy ansehen

Im Reiter **Fotos** einen zuletzt verwendeten Auftrag antippen oder die genaue Auftragsnummer und die zugehörige Artikelnummer eingeben und **Fotos anzeigen** wählen. Hat der Auftrag keine Artikelnummer, bleibt das Feld leer. Die Galerie zeigt die Bilder dieses Auftrags von freigeschalteten Handys und vom eigenen Gerät. Ein Tipp auf das Vorschaubild öffnet es groß. Dieselbe Galerie ist im aktiven Auftrag und im Verlauf erreichbar.

Für Serverfotos braucht das Handy eine Internetverbindung. Die eigenen lokal gespeicherten Fotos bleiben auch offline sichtbar. Unter **Handys** auf der Website lässt sich die Lesefreigabe einzeln ändern.

Die App behält eine lokale Kopie der Auftragsfotos und versucht ausstehende Übertragungen wieder, sobald das Ziel erreichbar ist. Unter **Handys** auf der Webseite lässt sich der Zugang für ein einzelnes Gerät widerrufen. Für eine neue Verbindung auf diesem Handy einen neuen Gerätecode erstellen und in der App eingeben.

## NAS als Fotoziel wählen

In der App **Fotospeicher → NAS-Ordner oder WebDAV einrichten** öffnen. Für WebDAV die HTTPS-Adresse eines vorhandenen, beschreibbaren Zielordners eingeben und die Zugangsdaten auf dem Handy hinterlegen. **NAS-Ordner auswählen** verwenden, wenn das NAS bereits im Android-Dateidialog sichtbar ist. Nach einem Wechsel des Ziels gehen die offenen und neuen Fotos an das neu gewählte Ziel.

Auf dem NAS entsteht zum Beispiel der Ordner `2026-11-05/Artikel-4711/Auftrag-A123/`. Die App verwendet das Datum der Fotozuordnung, bei älteren Fotos ohne eigenes Zuordnungsdatum das Datum des Eintrags. Einträge ohne Artikelnummer landen unter `Artikel-ohne-Nummer`.

## Projekt öffnen und bauen

Den entpackten Projektordner in Android Studio öffnen. Das Projekt verwendet Android Gradle Plugin 8.7.3, Gradle 8.9, Java 17, compileSdk und targetSdk 35. Unterstützt werden Geräte ab Android 8.0 (API 26). Die Android-Paketkennung lautet `de.crazybatto.robotschichtlog.work`. Die Version ist 1.9.0 mit Versionscode 10.

Eine lokale Entwicklungs-APK lässt sich unter Windows mit `BUILD_APK_WINDOWS.bat` erstellen. Für ein Update einer schon installierten Version braucht man denselben Signaturschlüssel wie beim ursprünglichen Build.

Für einen anderen Host die Website-Adressen im eigenen Build anpassen und eigene Konten/Geräte einrichten. Dieser Quellcode enthält keine Zugangsdaten oder Betreiberfreigaben. Weitere Einrichtung und konkrete Prüfergebnisse: [Installation](../docs/INSTALLATION.md), [Validierung](../docs/VALIDATION.md).
