@echo off
setlocal
title KREA2 Vision Suite Setup
call "%~dp0installer\Krea2VisionSuite-Installer.cmd" -Mode Install -Model 8B
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the message above, then double-click
  echo the Repair KREA2 Vision Suite shortcut created on your desktop.
  pause
)
endlocal
