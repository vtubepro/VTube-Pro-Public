@echo off
rem VTube Pro - double-click me to start. The first time it sets everything up (a few minutes), then it opens the studio.
rem If Windows shows "Windows protected your PC" (SmartScreen): click "More info", then "Run anyway". VTube Pro is not code-signed yet.
rem Options, e.g.:  "Start VTube Pro.cmd" -Port 5291     "Start VTube Pro.cmd" -NoBrowser
setlocal
cd /d "%~dp0"
title VTube Pro
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launcher\start.ps1" %*
set "RC=%ERRORLEVEL%"
if defined VTP_NO_PAUSE goto :done
if "%RC%"=="0" (
  timeout /t 20
) else (
  echo Something went wrong ^(see the message above^). Press any key to close this window.
  pause >nul
)
:done
endlocal & exit /b %RC%
