# Prüfung dieser Quellcode-Veröffentlichung

Stand: 12. November 2026. **Robot-SchichtLog 1.9.1** ergänzt den sichtbaren Button **ZUM SERVER HOCHLADEN** für den direkten Abgleich gespeicherter Aufträge und Bilder. Desktop 3.7.1, Server 2.3.2, Android-Control und Stream-Deck-Plugin sind gegenüber der vorherigen Veröffentlichung unverändert.

| Neue Prüfung für Robot 1.9.1 | Ergebnis |
| --- | --- |
| Signiertes Android-Paket | Version 1.9.1, Versionscode 11, Datenbankversion 6; dieselbe Paketkennung und Signatur wie die vorhandene private App. APK und Signierschlüssel werden nicht veröffentlicht. |
| Automatisierte Android-Prüfung | **64 Tests bestanden, 0 fehlgeschlagen**, gegen die Klassen des endgültigen APK-Pakets. Die Prüfungen decken den bisherigen Schicht-/Abgleichsablauf sowie den neuen manuellen Upload und seine Oberfläche ab. |
| Bereinigte Android-Quellen | Alle Javaquellen mit Java-17-Ziel und Android SDK 36 kompiliert. App-Quellbytes stimmen mit dem geprüften privaten Build überein; das Projekt bleibt für compileSdk/targetSdk 35 konfiguriert. |
| Grenzen der Prüfung | Keine Installation oder echte Übertragung auf dem persönlichen Handy geprüft. Geräteverbindung, serverseitige Freigabe und Internetzugang bleiben notwendig. |

Die unveränderten Komponenten behalten die unten dokumentierten Prüfergebnisse ihres vorherigen Stands. Ihre Tests wurden für diese reine Android-Ergänzung nicht erneut als neue Ergebnisse ausgegeben.

<!-- ROBOT191_VALIDATION_END -->

## Vorheriger geprüfter Stand: Control Center 3.7.1 / Robot 1.9.0

Stand: 12. November 2026. Desktop 3.7.1, Stream-Deck-Plugin 1.0.0, Server 2.3.2, Android-Control 1.0.0, Robot-SchichtLog 1.9.0. Diese Revision verbessert den Robot-Auftragsabgleich, vollständige private Fotogalerien und den Schichtablauf in der Android-App. Die Ergebnisse beziehen sich auf die bereinigte Exportkopie und die ausdrücklich genannten privaten Paketprüfungen.

| Prüfung | Ergebnis |
| --- | --- |
| Serverexport | **508 Tests bestanden, 0 fehlgeschlagen**. Der Netzwerk-Wächter erlaubt ausschließlich von den Tests selbst geöffnete lokale Testserver. Enthalten sind die acht Kalender-Integrationstests des bestehenden Exports zusätzlich zur aktuellen Staging-Auswahl. |
| Robot-Serverprotokoll | **11 Tests** innerhalb der Serversuite: ausdrückliche Gerätefreigabe, idempotente Wiederholung, Konfliktauflösung, reversible Löschung, echte persistierte Bildbytes, Namensänderungen, Unicode-Leerzeichen und 87 Bilder über mehrere Seiten. Ungültige oder zu einem anderen Auftrag gehörende Fotocursor werden abgewiesen. Schlüsselähnliche Gerätenamen erscheinen nicht in Listen-/Auftragsantworten. |
| Desktopexport | **192 Tests bestanden, 0 fehlgeschlagen**. Einschließlich gültiger Foto-Folgeseiten, stabiler Zuordnung zum ausgewählten Auftrag und Schutz vor verspäteten Antworten während einer Bearbeitung oder eines Konto-/Auftragswechsels. Bestehende Moderations-, SFTP-, Musik-, Stream-Deck- und Statistikprüfungen sind enthalten. |
| Desktop-Produktionsbuild | Bereinigte Version **3.7.1** erfolgreich gebaut; **1.623 Module** verarbeitet. Vite weist weiterhin auf ein JavaScript-Bundle über 500 kB hin. Der Build verwendet eine separate lokale Prüfkopie; erzeugte Dateien sind nicht Bestandteil des Exports. |
| Installierter Windows-Desktop | Version **3.7.1** mit echter Admin-Sitzung in einem Fenster von **1.426 × 973** geprüft: Filterwechsel zwischen aktiven und gelöschten Einträgen in beide Richtungen, echte Auftragsdetails und private Fotogalerie einschließlich Rastervorschau erfolgreich. Keine sichtbaren Überlappungen; Konsole und kleinere Fenster wurden nicht zusätzlich geprüft. Private Auftragswerte und Bilder werden nicht veröffentlicht. |
| Robot-Javaquellen | Sämtliche Javaquellen der bereinigten Version **1.9.0** erfolgreich mit JDK 21, Java-17-Ziel und Android SDK 36 kompiliert. Das Projekt bleibt für SDK/Target 35 konfiguriert. Die lokale Prüfung verwendete die erzeugten Ressourcen des vollständigen privaten APK-Builds; ein Gradle-Download war dafür nicht nötig. |
| Robot-Migration und Synchronisierung | Gegen die Klassen des endgültigen privaten 1.9-Pakets **12 Workflow- und 12 Sync-Tests bestanden**: Datenbankmigration auf Version 6, Zwischenstände ohne doppelte Mengen, Schichtende bei offenem Auftrag, frühe Schichtzuordnung, Zeitwechsel, UTF-8-Begrenzung von Übertragungen, Wiederholungen, Konflikte und Centerkorrekturen ohne Überschreiben eines neueren lokalen Stands. |
| Robot-Oberfläche | **6 UI-/Darstellungstests bestanden**; die drei vorhandenen Designs wurden visuell geprüft. Das ist keine Installation oder Netzwerkprüfung auf dem persönlichen Android-Handy. |
| Bestehende Besucherübersicht | Der vorherige Stand 3.7.0 wurde im installierten Windows-Desktop mit echten Adminantworten, 7/30/90-Tage-Wechsel, Tageswerten und Aktualisieren geprüft. Diese Revision ändert die Besucherübersicht nicht. Private Statistikwerte und Screenshots werden nicht veröffentlicht. |
| Unverändertes Stream-Deck-Plugin | Bereits geprüfter Stand: **23 Tests**, echter lokaler WebSocket-/HTTP-Protokolltest mit synthetischem Schlüssel sowie erfolgreiche Elgato-CLI-Validierung. Quellen bleiben in dieser Revision unverändert. |
| Unverändertes Android-Control | Bereits geprüfter Stand: Exportquellen kompiliert, **3 Unit-Tests bestanden**, Android-Lint ohne Befunde. Quellen bleiben unverändert; Benachrichtigungen benötigen weiterhin einen Test auf dem eigenen Handy. |
| Quell- und Assetvollständigkeit | Relative JavaScript-Imports und Paketeinstiege in **241 Dateien**, **232 Router-/Assetreferenzen**, **211 Syntaxprüfungen** und **116 Binärassets** geprüft; keine offenen Befunde. |
| Veröffentlichungsumfang | Keine Installer, APKs, Signierschlüssel, privaten Bilder, Datenbanken, Gerätezugänge oder echten Serverkennungen enthalten. Bestehende synthetische Testpasswörter und ungültige Test-URLs bleiben als Testfälle erhalten. |

Abhängigkeiten, SDK, erzeugte Ressourcen, Testdatenbanken und Prüfprotokolle liegen außerhalb des Repositories. Git bewahrt die Quellbytes, damit die selbst erzeugte BetterDiscord-Brücke ihre geprüften Quellhashes behält. Die private App-Verteilung ist ein eigener Schritt und wird durch diesen Quellcode-Export nicht öffentlich gemacht.

Ein erfolgreicher Test ersetzt nicht die Einrichtung des konkreten Geräts: Fotospeicher koppeln, genau dieses Handy für Aufträge freigeben und den Abgleich aktivieren. Netzwerk, Android-Energiesparen und entzogene Berechtigungen können Hintergrundübertragungen verzögern oder verhindern. Ebenso benötigen Discord-Rechte, TikTok-Verfügbarkeit, echte Musik-/Spotify-Wiedergabe, Stream-Deck-Hardware und Ton/Pop-up auf dem persönlichen Handy jeweils die eigene Installation.
