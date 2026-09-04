@echo off
cd /d "%~dp0"
title Jupiter-8 Ultra-Low Latency Synth Host (ESI U168XT)
echo ========================================================
echo Starting Jupiter-8 Synth Host (WASAPI Exclusive Mode)
echo Hardware Target: ESI U168XT (128-frame buffer)
echo ========================================================
call "node_modules\.bin\electron.cmd" .
if %errorlevel% neq 0 (
    echo.
    echo App exited with an error. Press any key to close...
    pause >nul
)
