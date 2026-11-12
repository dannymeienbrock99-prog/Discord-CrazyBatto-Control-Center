@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ==================================================
echo   Robot SchichtLog - Debug APK bauen
echo ==================================================
echo.

where java >nul 2>nul
if errorlevel 1 (
  echo [FEHLER] Java wurde nicht gefunden.
  echo Bitte Android Studio installieren und den eingebauten JDK verwenden
  echo oder JAVA_HOME auf ein JDK 17+ setzen.
  pause
  exit /b 1
)

where gradle >nul 2>nul
if not errorlevel 1 (
  echo [OK] Vorhandenes Gradle wird verwendet.
  call gradle :app:assembleDebug
  goto :result
)

set "GRADLE_VERSION=8.9"
set "DIST_DIR=%CD%\.gradle-dist"
set "ZIP_FILE=%DIST_DIR%\gradle-%GRADLE_VERSION%-bin.zip"
set "GRADLE_HOME=%DIST_DIR%\gradle-%GRADLE_VERSION%"

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

if not exist "%GRADLE_HOME%\bin\gradle.bat" (
  echo [INFO] Gradle %GRADLE_VERSION% wird einmalig heruntergeladen...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://services.gradle.org/distributions/gradle-%GRADLE_VERSION%-bin.zip' -OutFile '%ZIP_FILE%'"
  if errorlevel 1 (
    echo [FEHLER] Gradle konnte nicht heruntergeladen werden.
    pause
    exit /b 1
  )
  echo [INFO] Gradle wird entpackt...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%DIST_DIR%' -Force"
  if errorlevel 1 (
    echo [FEHLER] Gradle konnte nicht entpackt werden.
    pause
    exit /b 1
  )
)

call "%GRADLE_HOME%\bin\gradle.bat" :app:assembleDebug

:result
if errorlevel 1 (
  echo.
  echo [FEHLER] APK-Build fehlgeschlagen.
  echo Pruefe, ob Android SDK Platform 35 und Build Tools installiert sind.
  pause
  exit /b 1
)

echo.
echo [FERTIG] APK erstellt:
echo %CD%\app\build\outputs\apk\debug\app-debug.apk
pause
