@echo off
rem VTube Pro - first-time setup + start. Double-click me.
rem Checks Node.js / Git (offers to install what is missing), installs the app, builds it, starts it and opens the studio.
rem Extra options, e.g.:  START_HERE.bat -Port 5291
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Setup stopped with an error ^(code %RC%^). Read the messages above, fix it, then double-click START_HERE.bat again.
  pause
)
endlocal & exit /b %RC%
