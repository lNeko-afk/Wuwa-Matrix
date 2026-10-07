@echo off
setlocal
pushd "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron runtime not found:
  echo         %~dp0node_modules\electron\dist\electron.exe
  echo Run this to install it:
  echo         npm install
  pause
  exit /b 1
)

rem Pass %CD% (no trailing backslash) instead of %~dp0 -- a path ending in
rem \" makes the closing quote literal and Electron receives a bad path.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%CD%"

popd
endlocal
