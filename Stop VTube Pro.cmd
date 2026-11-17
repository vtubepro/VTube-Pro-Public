@echo off
rem VTube Pro - double-click me to stop VTube Pro (only the copy that "Start VTube Pro" started from this folder).
setlocal
cd /d "%~dp0"
title Stop VTube Pro
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launcher\stop.ps1"
set "RC=%ERRORLEVEL%"
if not defined VTP_NO_PAUSE timeout /t 8
endlocal & exit /b %RC%
