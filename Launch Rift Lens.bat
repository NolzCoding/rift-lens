@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "REPO=https://github.com/NolzCoding/rift-lens.git"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, restart your PC, then try again.
  pause
  exit /b 1
)

rem Second run after an update: the new launcher carries on from the install step.
rem %2 is the version before the update, or "fresh" after setting up updates.
if "%~1"=="/updated" goto data

rem Updates: your data folder is never touched. Git is needed for them.
where git >nul 2>nul
if errorlevel 1 (
  echo Install Git from https://git-scm.com/download/win to get automatic updates.
  goto data
)
if not exist ".git" (
  rem A copy from a zip: turn it into a git copy once, so it can update from now on.
  echo Setting up automatic updates...
  git init -q >nul 2>nul
  git remote add origin %REPO% >nul 2>nul
  git fetch -q origin main
  if errorlevel 1 (
    echo Could not reach GitHub right now - starting the version you have.
    rmdir /s /q ".git"
    goto data
  )
  git checkout -q -f -B main origin/main
  rem Code files the old version had and the new one does not.
  git clean -fdq -- app components lib scripts tests public
  echo Updated to the latest version.
  rem This file was just replaced: run the new copy instead of reading on.
  call "%~f0" /updated fresh
  exit /b
)
git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>nul
if errorlevel 1 goto data
echo Checking for updates...
for /f %%i in ('git rev-parse HEAD') do set "BEFORE=%%i"
git pull --ff-only --quiet
if errorlevel 1 echo Could not update right now - starting the version you have.
for /f %%i in ('git rev-parse HEAD') do set "AFTER=%%i"
if not "!BEFORE!"=="!AFTER!" (
  echo Updated to the latest version.
  rem This file may have just changed: run the new copy instead of reading on.
  call "%~f0" /updated !BEFORE!
  exit /b
)

:data
rem Older versions kept your games two folders up, in work\rift-lens-memory. Copy them into data once.
set "LEGACY=..\..\work\rift-lens-memory"
if not exist "data" if exist "%LEGACY%\profile-settings.json" (
  findstr /b /c:"RIFT_LENS_MEMORY_DIR=" ".env.local" >nul 2>nul
  if errorlevel 1 (
    echo Copying your games and settings into the data folder...
    robocopy "%LEGACY%" "data" /e /njh /njs /ndl /nfl /nc /ns /np >nul
    if errorlevel 8 (
      echo Could not copy them - your old folder is still at %LEGACY%.
      rmdir /s /q "data" 2>nul
    )
  )
)

rem Packages: first run, after setting up updates, or when an update changed them.
set "INSTALL="
if not exist "node_modules" set "INSTALL=1"
if "%~2"=="fresh" set "INSTALL=1"
if "%~1"=="/updated" if not "%~2"=="fresh" (
  git diff --quiet %~2 HEAD -- package-lock.json
  if errorlevel 1 set "INSTALL=1"
)
if defined INSTALL (
  echo Installing packages, this takes a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo npm install failed - see the messages above.
    pause
    exit /b 1
  )
)

start "Rift Lens Server" /min cmd /c "npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://localhost:3000"
endlocal
