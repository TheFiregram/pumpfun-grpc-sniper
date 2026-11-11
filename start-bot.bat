@echo off
REM Double-click this file to start the bot on Windows.
cd /d "%~dp0"
title Pump.fun sniper

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed yet. Opening nodejs.org - install the LTS version,
  echo then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo I made your settings file .env and opened it in Notepad.
  echo 1. After HELIUS_API_KEY=  paste your Helius API key
  echo 2. After PRIVATE_KEY=     paste the private key of your NEW bot wallet
  echo 3. Press Ctrl+S to save, close Notepad, then double-click this file again.
  notepad ".env"
  pause
  exit /b 0
)

findstr /c:"HELIUS_API_KEY=your-helius-api-key" ".env" >nul
if not errorlevel 1 goto :fixenv
findstr /r /c:"^HELIUS_API_KEY=..*" ".env" >nul
if errorlevel 1 goto :fixenv
findstr /r /c:"^PRIVATE_KEY=..*" ".env" >nul
if errorlevel 1 goto :fixenv

if not exist "node_modules" (
  echo.
  echo Installing the bot's parts. This takes a minute or two the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Take a photo of this window and send it to Claude.
    pause
    exit /b 1
  )
)

echo.
echo Starting the bot. Press Ctrl+C in this window to stop it.
echo.
call npm start
echo.
echo The bot has stopped.
pause
exit /b 0

:fixenv
echo.
echo Your .env file still needs your HELIUS_API_KEY and PRIVATE_KEY.
echo Fill them in, press Ctrl+S to save, close Notepad, then double-click this file again.
notepad ".env"
pause
exit /b 1
