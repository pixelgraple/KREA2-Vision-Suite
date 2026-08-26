@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KREA2 Vision Suite Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Krea2VisionSuite.ps1" %*
set "KREA2_EXIT=%ERRORLEVEL%"
echo.
if not "%KREA2_EXIT%"=="0" echo Installer stopped with exit code %KREA2_EXIT%.
pause
exit /b %KREA2_EXIT%
