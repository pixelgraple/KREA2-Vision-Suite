@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KREA2 Vision Prompt Studio - First-time setup
echo KREA2 Vision Prompt Studio setup
echo This installs free local components. Qwen3-VL models are several GB.

where winget >nul 2>nul
if errorlevel 1 (
  echo Automatic setup needs Windows App Installer / winget.
  echo Install Python 3.11+ and Ollama manually, then use start.bat.
  pause
  exit /b 1
)
where py >nul 2>nul
if errorlevel 1 (
  echo Installing Python 3.12...
  winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements || goto :fail
  set "STUDIO_PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else (set "STUDIO_PY=py -3")
where ollama >nul 2>nul
if errorlevel 1 (
  echo Installing Ollama...
  winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements || goto :fail
  set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
)
if not exist .env copy .env.example .env >nul
if not exist .venv\Scripts\python.exe (
  %STUDIO_PY% -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt || goto :fail

echo.
echo Optional free Qwen3-VL models. Each missing model is offered separately.
call :offer_model "Fast 8B" qwen3-vl:8b || goto :fail
call :offer_model "Quality 30B" qwen3-vl:30b || goto :fail
ollama show qwen3-vl:30b >nul 2>nul
if not errorlevel 1 set "STUDIO_MODEL=qwen3-vl:30b"
if not defined STUDIO_MODEL (
  ollama show qwen3-vl:8b >nul 2>nul
  if not errorlevel 1 set "STUDIO_MODEL=qwen3-vl:8b"
)
if not defined STUDIO_MODEL (
  echo No supported Qwen3-VL model is installed. Run setup again and choose at least one model.
  goto :fail
)
powershell -NoProfile -Command "$p='.env'; $c=Get-Content -Raw $p; $c=[regex]::Replace($c,'(?m)^QWEN_MODEL=.*$','QWEN_MODEL=%STUDIO_MODEL%'); [IO.File]::WriteAllText($p,$c,[Text.UTF8Encoding]::new($false))"
echo Starting Studio at http://127.0.0.1:7870
python -m uvicorn app.main:app --host 127.0.0.1 --port 7870
goto :end
:offer_model
set "MODEL_LABEL=%~1"
set "MODEL_TAG=%~2"
ollama show %MODEL_TAG% >nul 2>nul
if not errorlevel 1 (
  echo %MODEL_LABEL% (%MODEL_TAG%) is already installed.
  exit /b 0
)
choice /C YN /N /M "Download %MODEL_LABEL% (%MODEL_TAG%) now"
if errorlevel 2 (
  echo Skipped %MODEL_LABEL%.
  exit /b 0
)
echo Downloading %MODEL_TAG%. This is a one-time, several-GB download...
ollama pull %MODEL_TAG% || exit /b 1
exit /b 0
:fail
echo Setup did not finish. Read the message above and run this file again.
pause
:end
endlocal
