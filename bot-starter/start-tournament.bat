@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
set BOT_NAME=nigel
set STRATEGY=hoarder
set TOURNAMENT_ID=2
echo Entering NigelBot in tournament 2 (strategy: hoarder). KEEP THIS WINDOW OPEN until the tournament ends.
call npm start
pause
