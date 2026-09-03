@echo off
REM Start Clippi and open it in your browser.
REM Close this window to stop the server.
title Clippi
cd /d "%~dp0"

REM If it is already running, just open the page instead of failing on the port.
powershell -NoProfile -Command "if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 5730 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo Clippi is already running.
  start "" http://localhost:5730
  exit /b
)

echo Starting Clippi on http://localhost:5730
echo Leave this window open while you use it.
echo.
start "" http://localhost:5730
node serve.mjs
