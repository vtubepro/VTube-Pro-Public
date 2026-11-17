@echo off
rem VTube Pro: put your own relay online (Discord parties + interview guest links). Guide: docs\HOSTING_SETUP.md
title VTube Pro - relay setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
echo.
pause
