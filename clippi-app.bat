@echo off
REM Clippi as one window: clip list + Dolphin player together.
title Clippi
cd /d "%~dp0"
npx electron shell/main.cjs
