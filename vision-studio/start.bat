@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  py -3 -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt || goto :fail
if not exist .env copy .env.example .env >nul
echo.
echo KREA2 Vision Prompt Studio: http://127.0.0.1:7870
echo Keep this window open while using the Studio.
python -m uvicorn app.main:app --host 127.0.0.1 --port 7870
goto :end
:fail
echo Setup failed. Install Python 3.11+ and run this file again.
pause
:end
endlocal
