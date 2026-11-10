# Prüfung dieser Quellcode-Veröffentlichung

Stand: 10. November 2026. Desktop 3.5.1, Server 2.3.2, Android-Control 1.0.0, Robot-SchichtLog 1.8.0. Die Ergebnisse beziehen sich auf die bereinigte Exportkopie und die unten genannten lokalen Prüfungen, nicht auf eine neue Installation bei beliebigen Drittanbietern.

| Prüfung | Ergebnis |
| --- | --- |
| Servertests nach der letzten Gaming-Navigationskorrektur | **347 bestanden, 0 fehlgeschlagen**, einschließlich lokaler HTTP-Integration. |
| Desktoptests | **160 bestanden, 0 fehlgeschlagen**, einschließlich echter lokaler SFTP-Verbindung mit Hostschlüsselprüfung und Datei-Rundreise. |
| Desktop-Produktionsbuild | Erfolgreich; 1.615 Module verarbeitet. Vite meldet lediglich den bestehenden Hinweis auf ein JavaScript-Bundle über 500 kB. |
| Erste Betreiberfreigabe | Lokal mit eigener temporärer Testdatenbank geprüft: fehlendes/unbestätigtes Konto, Sperre, anderer vorhandener Admin und ungültige UUID werden abgewiesen; bestätigtes eigenes Erstkonto kann freigegeben werden. Keine Produktivdaten benutzt. |
| Android-Control | Exportquellen erfolgreich kompiliert; **3 Unit-Tests bestanden**; Android-Lint meldet **keine Befunde**. Geprüft mit JDK 21, Gradle 8.14.3, Android Gradle Plugin 8.13.2 und SDK 36. |
| Android-Benachrichtigungsdienst | Der gesamte Zustellablauf behandelt eine verweigerte Android-Berechtigung. Quellkorrektur geprüft; keine neue APK signiert, verteilt oder installiert. |
| Robot-SchichtLog | Vollständige Projektquellen enthalten. Ein erneuter Build wurde in dieser Umgebung **nicht bestätigt**, weil Android Gradle Plugin 8.7.3 nicht lokal verfügbar und Android SDK 35 nicht installiert waren. Die Quellversion bleibt 1.8.0. |
| Quell- und Assetvollständigkeit | 230 statische Router-/Assetreferenzen vollständig; relative JavaScript-Imports und Paketeinstiegspunkte geprüft; JavaScript-Syntaxprüfung bestanden. |
| Veröffentlichungsprüfung | Keine echten blockierenden Treffer für bekannte Produktionskennungen, Anbieterprojektwerte, Zugangstokens, Schlüsseldateien oder private Laufzeitdaten. Synthetische Testpasswörter und absichtlich ungültige Test-URLs wurden einzeln eingeordnet. |
| Medien und Lizenzen | Binärassets auf lesbare private Pfad-/Schlüsselmetadaten geprüft, ohne entsprechenden Befund; vorhandene Oxanium-, Icon- und Lucide-Lizenztexte erhalten. |

Die Prüfung verwendete vorhandene lokale Abhängigkeiten außerhalb des Exportordners. `node_modules`, Build-Ausgaben, Testdatenbanken, Testprotokolle, lokale SDK-Pfade und Signierdateien sind nicht im Repository enthalten. Git bewahrt die Quellbytes, damit die Quellhashes der selbst erzeugten BetterDiscord-Brücke unverändert bleiben.

Discord-Rechte, reale TikTok-Verfügbarkeit, Musik in einem echten Sprachkanal sowie Ton/Pop-up auf einem konkreten Android-Handy hängen von der eigenen Installation ab und werden durch diese automatisierten Prüfungen nicht garantiert. Auch ein erfolgreicher Quellbuild ist keine signierte, auf dem Zielgerät geprüfte APK. Die persönliche App-Verteilung bleibt getrennt von dieser Veröffentlichung.
