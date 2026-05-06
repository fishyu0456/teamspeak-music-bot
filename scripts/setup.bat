@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TSMusicBot Setup

:: ============================================================
::  TSMusicBot Setup Script (Robust Edition)
::  - Auto-detect China network, switch to npmmirror
::  - Strict error checking at every step
::  - Detailed logging to setup.log
::  - Skip already-completed steps on re-run
:: ============================================================

set "SCRIPT_VERSION=2.0"
set "MIN_NODE_MAJOR=20"
set "LOG_FILE=%~dp0..\setup.log"
set "FAILED=0"

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    pause
    exit /b 1
)

set "PROJECT_ROOT=%cd%"

:: ---- Initialize log ----
echo. > "%LOG_FILE%"
call :log "============================================"
call :log "  TSMusicBot Setup v%SCRIPT_VERSION%"
call :log "  Started: %date% %time%"
call :log "  Project root: %PROJECT_ROOT%"
call :log "============================================"

echo ============================================
echo   TSMusicBot - First-Time Setup (Windows)
echo   Version %SCRIPT_VERSION%
echo ============================================
echo.
echo Log file: %LOG_FILE%
echo.

:: ============================================================
:: Step 1: Check Node.js
:: ============================================================
call :step "1/6" "Checking Node.js"

where node >nul 2>&1
if errorlevel 1 (
    call :error "Node.js not found in PATH."
    echo.
    echo Please install Node.js %MIN_NODE_MAJOR% LTS or newer from one of:
    echo   - https://nodejs.org/        ^(official^)
    echo   - https://nodejs.cn/         ^(China mirror, recommended for CN users^)
    echo.
    echo After installation:
    echo   1. Close this window completely
    echo   2. Open a NEW Command Prompt
    echo   3. Run scripts\setup.bat again
    echo.
    pause
    exit /b 1
)

:: Check Node version >= 20
for /f "tokens=1 delims=v." %%a in ('node --version 2^>nul') do set "NODE_RAW=%%a"
for /f "tokens=1 delims=v." %%a in ('node --version 2^>nul') do (
    for /f "tokens=1 delims=." %%b in ("%%a") do set "NODE_MAJOR=%%b"
)

:: Robust version parse
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
set "NODE_VER_NUM=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VER_NUM%") do set "NODE_MAJOR=%%a"

call :log "Node.js version: %NODE_VER%"
echo [OK] Node.js found: %NODE_VER%

if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% (
    call :error "Node.js version too old. Need %MIN_NODE_MAJOR%+, found %NODE_VER%."
    echo Please upgrade Node.js to version %MIN_NODE_MAJOR% LTS or newer.
    pause
    exit /b 1
)
echo.

:: ============================================================
:: Step 2: Check npm
:: ============================================================
call :step "2/6" "Checking npm"

where npm >nul 2>&1
if errorlevel 1 (
    call :error "npm not found. This is unusual since Node.js is installed."
    echo Please reinstall Node.js to fix this.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
call :log "npm version: %NPM_VER%"
echo [OK] npm found: %NPM_VER%
echo.

:: ============================================================
:: Step 3: Detect network and configure mirror
:: ============================================================
call :step "3/6" "Checking network"

set "USE_MIRROR=0"

:: Try reaching npm registry with a short timeout
echo Testing connection to registry.npmjs.org...
call :log "Testing npm registry connectivity..."

:: Use curl if available (more reliable than ping for HTTPS)
where curl >nul 2>&1
if not errorlevel 1 (
    curl -s -o nul -m 5 -w "%%{http_code}" https://registry.npmjs.org/ > "%TEMP%\npmtest.txt" 2>nul
    set /p HTTP_CODE=<"%TEMP%\npmtest.txt"
    del "%TEMP%\npmtest.txt" >nul 2>&1
    if "!HTTP_CODE!"=="200" (
        echo [OK] npm registry reachable.
        call :log "npm registry HTTP 200 OK"
    ) else (
        echo [WARN] npm registry slow or unreachable ^(code: !HTTP_CODE!^).
        call :log "npm registry returned: !HTTP_CODE!"
        set "USE_MIRROR=1"
    )
) else (
    :: Fallback to ping
    ping -n 1 -w 3000 registry.npmjs.org >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Cannot reach npm registry quickly.
        set "USE_MIRROR=1"
    ) else (
        echo [OK] npm registry reachable.
    )
)

if "%USE_MIRROR%"=="1" (
    echo.
    echo Slow connection detected. Switching to China mirror ^(npmmirror.com^)...
    call :log "Switching to npmmirror.com"
    call npm config set registry https://registry.npmmirror.com >>"%LOG_FILE%" 2>&1
    call npm config set disturl https://registry.npmmirror.com/-/binary/node >>"%LOG_FILE%" 2>&1
    call npm config set electron_mirror https://registry.npmmirror.com/-/binary/electron/ >>"%LOG_FILE%" 2>&1
    call npm config set sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3 >>"%LOG_FILE%" 2>&1
    call npm config set node_sqlite3_binary_host_mirror https://registry.npmmirror.com/-/binary/better-sqlite3 >>"%LOG_FILE%" 2>&1
    call npm config set sharp_binary_host https://registry.npmmirror.com/-/binary/sharp >>"%LOG_FILE%" 2>&1
    call npm config set sharp_libvips_binary_host https://registry.npmmirror.com/-/binary/sharp-libvips >>"%LOG_FILE%" 2>&1
    call npm config set FFMPEG_BINARIES_URL https://registry.npmmirror.com/-/binary/ffmpeg-static >>"%LOG_FILE%" 2>&1
    call npm config set @discordjs:registry https://registry.npmmirror.com >>"%LOG_FILE%" 2>&1
    echo [OK] Mirror configured.
)
echo.

:: ============================================================
:: Step 4: Install backend dependencies
:: ============================================================
call :step "4/6" "Installing backend dependencies"

if exist "node_modules\.package-lock.json" (
    echo Found existing node_modules. Checking integrity...
    call :log "Existing node_modules detected, running npm install to verify"
)

echo Running: npm install ^(this can take 5-15 minutes on slow networks^)
echo Press Ctrl+C to abort.
echo.

call npm install >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Backend npm install failed."
    echo.
    echo Common causes:
    echo   - Network timeout ^(retry with VPN or check %LOG_FILE%^)
    echo   - Native module compile failure ^(missing Python/VS Build Tools^)
    echo   - Disk space full
    echo.
    echo Try manually:
    echo   cd /d "%PROJECT_ROOT%"
    echo   npm install --verbose
    echo.
    pause
    exit /b 1
)
echo [OK] Backend dependencies installed.
echo.

:: ============================================================
:: Step 5: Install frontend dependencies
:: ============================================================
call :step "5/6" "Installing frontend dependencies"

if not exist "web\package.json" (
    call :error "web\package.json not found. Repository may be incomplete."
    echo Please re-clone the repository:
    echo   git clone https://github.com/ZHANGTIANYAO1/teamspeak-music-bot.git
    pause
    exit /b 1
)

echo Running: npm install ^(in web/ directory^)
echo.

pushd web >nul
call npm install >>"%LOG_FILE%" 2>&1
set "WEB_INSTALL_RESULT=!errorlevel!"
popd >nul

if !WEB_INSTALL_RESULT! neq 0 (
    call :error "Frontend npm install failed ^(exit code !WEB_INSTALL_RESULT!^)."
    echo.
    echo Try manually:
    echo   cd /d "%PROJECT_ROOT%\web"
    echo   npm install --verbose
    echo.
    pause
    exit /b 1
)
echo [OK] Frontend dependencies installed.
echo.

:: ============================================================
:: Step 6: Build project (backend + frontend)
:: ============================================================
call :step "6/6" "Building project"

echo Running: npm run build
echo.

call npm run build >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Build failed."
    echo.
    echo Check the log file for details: %LOG_FILE%
    echo.
    echo Try manually:
    echo   cd /d "%PROJECT_ROOT%"
    echo   npm run build
    echo.
    pause
    exit /b 1
)
echo [OK] Build succeeded.
echo.

:: ============================================================
:: Verify build outputs
:: ============================================================
echo Verifying build outputs...
set "BUILD_OK=1"

if not exist "dist" (
    call :error "dist/ directory missing after build."
    set "BUILD_OK=0"
)
if not exist "web\dist" (
    call :error "web\dist/ directory missing after build."
    set "BUILD_OK=0"
)

if "!BUILD_OK!"=="0" (
    echo.
    echo Build completed but expected output is missing.
    echo Check %LOG_FILE% for details.
    pause
    exit /b 1
)
echo [OK] Build outputs verified.
echo.

:: ============================================================
:: Optional: config.json hint
:: ============================================================
if not exist "config.json" (
    echo [INFO] config.json will be auto-generated on first launch.
) else (
    echo [OK] config.json already exists.
)
echo.

:: ============================================================
:: Done
:: ============================================================
call :log "Setup completed successfully at %date% %time%"

echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo   1. Run:  scripts\start.bat
echo   2. Open: http://localhost:3000
echo   3. Follow the in-browser setup wizard.
echo.
echo Setup log saved to: %LOG_FILE%
echo.
pause
exit /b 0

:: ============================================================
:: Subroutines
:: ============================================================
:step
echo ---- Step %~1: %~2 ----
call :log ""
call :log "---- Step %~1: %~2 ----"
goto :eof

:error
echo.
echo [ERROR] %~1
call :log "[ERROR] %~1"
goto :eof

:log
echo [%time%] %~1 >> "%LOG_FILE%"
goto :eof
