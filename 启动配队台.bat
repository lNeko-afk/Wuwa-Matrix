@echo off
setlocal
pushd "%~dp0"

if exist "%~dp0node_modules\electron\dist\electron.exe" goto launch

echo.
echo   [wuwa-matrix] Electron runtime not found.
echo.
echo   This usually means dependencies have not been installed yet.
echo   Expected file:
echo     %~dp0node_modules\electron\dist\electron.exe
echo.
echo   Requires Node.js 20 or newer:  https://nodejs.org/
echo.

where npm >nul 2>nul
if errorlevel 1 goto nonpm

choice /c YN /n /m "  Run "npm install" now? [Y/N] "
if errorlevel 2 goto abort

echo.
echo   Installing dependencies. This can take a few minutes...
echo.
call npm install

if exist "%~dp0node_modules\electron\dist\electron.exe" goto launch
echo.
echo   Still missing after install. Please check the output above.
pause
exit /b 1

:nonpm
echo   [ERROR] "npm" was not found on PATH.
echo           Please install Node.js 20 or newer first:  https://nodejs.org/
pause
exit /b 1

:abort
echo.
echo   Cancelled. When ready, open a terminal in this folder and run:
echo     npm install
pause
exit /b 1

:launch
rem Pass %CD% (no trailing backslash) instead of %~dp0 -- a path ending in
rem \" makes the closing quote literal and Electron receives a bad path.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%CD%"

popd
endlocal
