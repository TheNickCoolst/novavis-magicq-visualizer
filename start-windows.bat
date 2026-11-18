@echo off
setlocal
cd /d "%~dp0"
title NovaVis Visualizer

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte Node.js 18+ von https://nodejs.org installieren.
  pause
  exit /b 1
)

if not exist "node_modules\three" (
  echo Installiere Abhaengigkeiten...
  call npm install --omit=dev
  if errorlevel 1 (
    echo npm install fehlgeschlagen.
    pause
    exit /b 1
  )
)

start "" http://localhost:4321
node server.mjs
pause
