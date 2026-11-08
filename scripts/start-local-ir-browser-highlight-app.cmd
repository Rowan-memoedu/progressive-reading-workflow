@echo off
rem The persistent, hidden Windows task owns the service, not this console.
schtasks /Run /TN "Local IR Browser Highlight"
exit /b %ERRORLEVEL%
