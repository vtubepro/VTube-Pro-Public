@echo off
rem VTube Pro - start (after the first START_HERE.bat). Reinstalls / rebuilds only when something changed.
rem Options, e.g.:  START.bat -Port 5291     START.bat -NoBrowser
setlocal
cd /d "%~dp0"
rem No options: the same as double-clicking "Start VTube Pro" (runs in the background; "Stop VTube Pro" stops it).
if "%~1"=="" if exist "%~dp0Start VTube Pro.cmd" (
  call "%~dp0Start VTube Pro.cmd"
  goto :eof
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Quick %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo VTube Pro stopped with an error ^(code %RC%^). Try START_HERE.bat for a full setup.
  pause
)
endlocal & exit /b %RC%
