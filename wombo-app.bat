@echo off
REM Wombo as one window: clip list + Dolphin player together.
title Wombo
cd /d "%~dp0"
npx electron shell/main.cjs
