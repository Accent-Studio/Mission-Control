@echo off
rem Runs the Mission Control server inside its own console window. Exit code 75 means "restart me".
set "MC_SUPERVISED=1"
cd /d "%~dp0.."
rem The phone bridge runs in its own minimized window, started once (it outlives server restarts).
rem Nothing happens when it was never built. A second bridge exits by itself (lock, exit code 73).
if exist "%~dp0..\bridge\run-bridge.bat" if exist "%~dp0..\bridge\run\mc-bridge.exe" start "Mission Control bridge" /min cmd /c ""%~dp0..\bridge\run-bridge.bat""
if exist "%~dp0..\bridge\run-bridge.bat" if not exist "%~dp0..\bridge\run\mc-bridge.exe" if exist "%~dp0..\bridge\run\mc-bridge.new.exe" start "Mission Control bridge" /min cmd /c ""%~dp0..\bridge\run-bridge.bat""
rem The runner owns the Claude processes, so a restart of this server no longer ends the running conversations. Like the
rem bridge it runs in its own minimized window, is started here only (on a cold start, never by the restart loop below),
rem and a second runner finds its port taken and exits by itself (exit code 73). A new version of the runner is picked
rem up only on the next cold start; the server log says when the running one is older than its code.
if exist "%~dp0runner\run-runner.bat" start "Mission Control runner" /min cmd /c ""%~dp0runner\run-runner.bat""
:again
node server\index.js
if %errorlevel%==75 goto again
if not %errorlevel%==0 pause
exit /b %errorlevel%
