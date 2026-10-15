@echo off
rem Starts the Mission Control runner (server\runner\index.js), the program that owns the Claude processes so they survive a
rem server restart. run-server.bat starts this once on a cold start, in its own minimized window; the restart loop does not.
rem Exit codes of the runner: 0 normal end, 73 another runner already holds the port (this one ends at once), 1 cannot start.
rem Optional environment, mainly for tests: MC_DATA_DIR, MC_RUNNER_PORT (a number, or off for no runner).
setlocal
if /i "%MC_RUNNER_PORT%"=="off" exit /b 0
cd /d "%~dp0..\.."
node server\runner\index.js
set "CODE=%errorlevel%"
if "%CODE%"=="0" exit /b 0
if "%CODE%"=="73" exit /b 0
if "%CODE%"=="130" exit /b 0
if "%CODE%"=="143" exit /b 0
echo The runner stopped with exit code %CODE%. See .data\runner\runner.log.
pause
exit /b %CODE%
