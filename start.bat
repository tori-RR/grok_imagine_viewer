@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY="
if exist "%~dp0runtime\win64\python.exe" set "PY=%~dp0runtime\win64\python.exe"
if not defined PY (
  where py >nul 2>nul && set "PY=py"
)
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3 not found.
  echo Use the portable zip that includes runtime\win64, or install Python 3.
  pause
  exit /b 1
)

"%PY%" "%~dp0server.py" --open --port 19706 %*
if errorlevel 1 pause
endlocal
