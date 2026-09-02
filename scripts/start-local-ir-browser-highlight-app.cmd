@echo off
setlocal
cd /d "%~dp0.."
if not exist imports mkdir imports
set "PROGRESSIVE_READING_WORKFLOW_ROOT=%CD%"
set "PROGRESSIVE_READING_URL_COOKIE_MAP_JSON="
if not defined PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH if exist ".local-ir\cookie-snapshot.path" set /p "PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH="<".local-ir\cookie-snapshot.path"
node scripts\progressive-reading-app.mjs >> imports\app-server-task.stdout.log 2>> imports\app-server-task.stderr.log
