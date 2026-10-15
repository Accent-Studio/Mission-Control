@echo off
setlocal
set "ROOT=%~dp0"
set "URL=http://127.0.0.1:1700/"
set "HEALTH=http://127.0.0.1:1700/api/health"

call :health
if not errorlevel 1 goto open

rem run-server.bat also starts the runner (the program that owns the Claude processes, so a server restart does not end
rem them) and the phone bridge, once each, in their own minimized windows.
start "Mission Control server" /min /d "%ROOT%" cmd /c ""%ROOT%server\run-server.bat""
for /l %%i in (1,1,30) do (
  call :health
  if not errorlevel 1 goto open
  >nul timeout /t 1 /nobreak
)
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('Mission Control did not answer in time. Look for the minimized window titled Mission Control server to see why.', 'Mission Control')"
exit /b 1

:open
start "" "%URL%"
exit /b 0

:health
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH%' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
exit /b %errorlevel%
