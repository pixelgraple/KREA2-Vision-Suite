@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_vast_client.ps1"
if errorlevel 1 (
  echo.
  echo Vast Serverless client installation failed.
  pause
  exit /b 1
)
echo.
echo Vast Serverless client installation completed.
pause
