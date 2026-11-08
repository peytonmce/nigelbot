@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, first run only...
  call npm install
)
set BOT_NAME=nigel
rem Strategy: hoarder (big rack, huge words), whale (aggressive spender), or nigel (careful original).
set STRATEGY=hoarder
if not "%1"=="" set TOURNAMENT_ID=%1
echo Starting NigelBot (strategy: %STRATEGY%). Leave this window open. Press Ctrl+C to stop.
call npm start
pause
