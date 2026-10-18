@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
setlocal enabledelayedexpansion
title Antigravity Phone Connect - LOCAL MODE

:: Navigate to the script's directory
cd /d "%~dp0"
set "PATH=%~dp0;%~dp0bin;%PATH%"

echo ===================================================
echo   Antigravity Phone Connect - LOCAL ACCESS MODE
echo ===================================================
echo.

:: 0. Clean up previous instances
echo [0/2] Cleaning up previous instances...
taskkill /f /im cloudflared.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*launcher.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

:: 1. Check for .env file
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env file not found. Creating from .env.example...
        copy .env.example .env >nul
    )
)

:: 2. Select Python (prefer project venv)
set "PY_EXE="
if exist "%~dp0venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Python missing.
        pause
        exit /b 1
    )
    python -m venv venv
    set "PY_EXE=%~dp0venv\Scripts\python.exe"
)

echo [STARTING] Launching Antigravity Phone Connect...
"%PY_EXE%" -u launcher.py --mode local

echo.
echo [INFO] Server stopped. Press any key to exit.
pause >nul
