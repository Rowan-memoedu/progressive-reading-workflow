@echo off
setlocal
cd /d "%~dp0.."
npm run rss:sync -- --no-miniflux --opencli-timeout-ms 210000
