@echo off
rem ===================================================================
rem  DeskBasket one-click launcher -- just double-click this file.
rem
rem  Real logic lives in scripts\launch.js (cross-platform, unit tested;
rem  every Chinese message you read comes from there). This shim only
rem  finds Node and forwards its own arguments, e.g. "this file --settings"
rem  opens the settings panel right away.
rem
rem  NOTE: keep this file PURE ASCII -- comments included.
rem    * cmd.exe reads .cmd files in the console code page, so Chinese here
rem      only ever shows up as garbage.
rem    * A "chcp" line used to live here and it was worse than useless: the
rem      code page change made cmd re-parse this file at a wrong offset and
rem      execute words out of these very comments ("DeskBasket is not
rem      recognized as a command"). Dropped -- the Chinese the user reads is
rem      written by Node as UTF-16, which is always correct.
rem
rem  Exit code is passed straight through from launch.js:
rem    0 = started, 2 = already running, 1 = failed to start.
rem ===================================================================
setlocal
where node >nul 2>nul
if errorlevel 1 echo.
if errorlevel 1 echo   Node.js not found - DeskBasket needs Node.js to run.
if errorlevel 1 echo   Install Node.js and run "npm install" once in this
if errorlevel 1 echo   folder, then double-click this file again.
if errorlevel 1 echo.
if errorlevel 1 pause
if errorlevel 1 exit /b 1
node "%~dp0scripts\launch.js" %*
set RC=%ERRORLEVEL%
rem 2 = already running: nothing was started, and that is not an error. Hold
rem the window a few seconds so the message is readable -- the default
rem terminal here is Windows Terminal, whose tab closes the moment we exit.
if "%RC%"=="2" timeout /t 4 >nul 2>nul
rem 1 = failed to start: wait for a key so the log tail stays readable.
if "%RC%"=="1" pause
exit /b %RC%