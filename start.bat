@echo off
title Chanh Dien Tinh Tam

:: Kiem tra Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [LOI] Chua cai Node.js. Tai tai: https://nodejs.org
    pause
    exit /b 1
)

:: Cai packages neu chua co
cd /d %~dp0live
if not exist node_modules (
    echo Dang cai packages lan dau, vui long cho...
    npm install
    if errorlevel 1 (
        echo [LOI] npm install that bai.
        pause
        exit /b 1
    )
)

:: Tat server cu neu dang chay tren cong 3000
taskkill /F /IM node.exe >nul 2>&1

:: Mo trinh duyet
echo Dang khoi dong server...
start "" "http://localhost:3000/live/control.html"
start "" "http://localhost:3000/live/overlay.html"

:: Chay server
node server.mjs

pause
