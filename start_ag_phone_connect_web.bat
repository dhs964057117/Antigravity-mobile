@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
setlocal enabledelayedexpansion
title Antigravity Phone Connect - WEB MODE

:: Navigate to script directory
cd /d "%~dp0"
set "PATH=%~dp0;%~dp0bin;%PATH%"

echo ===================================================
echo   Antigravity Phone Connect - WEB ACCESS MODE
echo ===================================================
echo.

:: 0. Aggressive Cleanup (Clear any stuck processes from previous runs)
echo [0/2] Cleaning up previous instances...
taskkill /f /im cloudflared.exe >nul 2>&1
taskkill /f /im ngrok.exe >nul 2>&1
taskkill /f /im pinggy.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*launcher.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

:: 1. Ensure Node.js dependencies
if not exist "node_modules" (
    echo [INFO] Installing Node.js dependencies...
    call npm install
)

:: 2. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js missing.
    pause
    exit /b 1
)

:: 3. Select Python (prefer project venv)
set "PY_EXE="
if exist "%~dp0venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Python missing. Required for the web tunnel.
        pause
        exit /b 1
    )
    echo [INFO] Creating Python virtual environment...
    python -m venv venv
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
)

:: 4. Check for .env file
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Creating .env from .env.example...
        copy .env.example .env >nul
    ) else (
        echo [ERROR] .env file not found.
        pause
        exit /b 1
    )
)
echo [INFO] .env configuration found.

:: 5. Launch everything via Python
echo [1/1] Launching Antigravity Phone Connect...
echo (Starting server and web tunnel, please wait a few seconds...)
echo.

"%PY_EXE%" -u launcher.py --mode web
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Launcher failed with exit code %errorlevel%.
    echo Check for any error messages above.
    pause
    exit /b %errorlevel%
)

exit /b 0
