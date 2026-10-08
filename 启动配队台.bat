@echo off
setlocal
pushd "%~dp0"

if exist "%~dp0node_modules\electron\dist\electron.exe" goto launch

echo [ERROR] Electron runtime not found:
echo         %~dp0node_modules\electron\dist\electron.exe
echo.
echo Run this to install it:
echo         npm install
echo.
pause
exit /b 1

:launch
rem Pass %CD% (no trailing backslash) instead of %~dp0 -- a path ending in
rem \" makes the closing quote literal and Electron receives a bad path.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%CD%"

popd
endlocal
