@echo off
setlocal
cd /d "%~dp0.."
if not exist imports mkdir imports
node scripts\progressive-reading-app.mjs >> imports\app-server-task.stdout.log 2>> imports\app-server-task.stderr.log
