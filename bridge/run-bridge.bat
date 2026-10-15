@echo off
rem Supervisor for the phone bridge (mc-bridge). run-server.bat starts it once, in its own window.
rem Exit codes of mc-bridge: 0 stop or orphan (end), 73 another bridge holds the lock (end),
rem 75 restart (loop), 1 or 2 cannot start (retry with backoff, then end).
rem Optional environment, mainly for tests: MC_DATA_DIR, MC_BRIDGE_PORT (a number, or off for no bridge),
rem MC_BRIDGE_ORPHAN_SECS, MC_BRIDGE_RELAY (default or off).
setlocal
set "HERE=%~dp0"
set "RUN=%HERE%run\"
set "EXE=%RUN%mc-bridge.exe"
set "NEWEXE=%RUN%mc-bridge.new.exe"
if "%MC_BRIDGE_PORT%"=="off" exit /b 0
if defined MC_DATA_DIR (set "DATA=%MC_DATA_DIR%") else (set "DATA=%HERE%..\.data")
set "PORT=1701"
if defined MC_BRIDGE_PORT set "PORT=%MC_BRIDGE_PORT%"
set "EXTRA="
if defined MC_BRIDGE_ORPHAN_SECS set "EXTRA=%EXTRA% --orphan-secs %MC_BRIDGE_ORPHAN_SECS%"
if defined MC_BRIDGE_RELAY set "EXTRA=%EXTRA% --relay %MC_BRIDGE_RELAY%"
set /a FAILS=0

:again
rem A build waits as mc-bridge.new.exe while the old one runs. Swap it in now, between runs.
rem If the old exe is still running (a second supervisor), the move fails and the old one is used.
if exist "%NEWEXE%" move /y "%NEWEXE%" "%EXE%" >nul 2>nul
if not exist "%EXE%" (
  echo mc-bridge.exe is not built. Run bridge\build-bridge.bat.
  exit /b 1
)
"%EXE%" --data-dir "%DATA%" --server 127.0.0.1:%PORT%%EXTRA%
set "CODE=%errorlevel%"
if "%CODE%"=="75" (
  set /a FAILS=0
  goto again
)
if "%CODE%"=="73" exit /b 0
if "%CODE%"=="0" exit /b 0

rem Exit 1 or 2 (or anything unexpected): wait a little longer each time, give up after 5 in a row.
set /a FAILS+=1
if %FAILS% geq 5 (
  echo mc-bridge failed %FAILS% times in a row, giving up. Last exit code %CODE%.
  exit /b %CODE%
)
set /a WAIT=FAILS*3
echo mc-bridge exited with code %CODE%. Trying again in %WAIT% seconds.
ping -n %WAIT% 127.0.0.1 >nul
goto again
