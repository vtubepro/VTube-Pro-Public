@echo off
rem Runs Blender headless at LOW CPU priority so it never starves the live studio's tracking.
rem Usage: tools\blender_low.cmd -b --factory-startup --python script.py -- args
start "" /low /b /wait "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" %*
