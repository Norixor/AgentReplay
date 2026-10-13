@echo off
rem Thin launcher for Windows (untested): all logic lives in src\cli.py.
rem Tries "py -3" first and falls back to "python". Without arguments (double-click) it runs "serve".
setlocal
set "DIR=%~dp0"
set "PY="
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY set "PY=python"
if not "%~1"=="" goto :withargs
%PY% "%DIR%src\cli.py" serve
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo agent-replay exited with an error. Press any key to close this window.
  pause >nul
)
exit /b %RC%
:withargs
%PY% "%DIR%src\cli.py" %*
exit /b %errorlevel%
