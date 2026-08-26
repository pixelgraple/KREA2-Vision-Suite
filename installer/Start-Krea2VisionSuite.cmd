@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KREA2 Vision Suite
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Krea2VisionSuite.ps1"
set "KREA2_EXIT=%ERRORLEVEL%"
if not "%KREA2_EXIT%"=="0" (
  echo.
  echo KREA2 Vision Suite could not start. Run the Repair shortcut on your desktop.
  pause
)
exit /b %KREA2_EXIT%
