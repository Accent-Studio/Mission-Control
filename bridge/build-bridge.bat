@echo off
rem Builds the phone bridge (release) and puts the result next to run-bridge.bat as run\mc-bridge.new.exe.
rem The running bridge uses run\mc-bridge.exe, which Windows will not let anyone overwrite, so the new
rem build waits under another name. run-bridge.bat swaps it in the next time the bridge starts
rem (for example after the Restart bridge button, which makes the bridge exit with code 75).
setlocal
rem The build goes to \mcb on this drive unless CARGO_TARGET_DIR says otherwise.
if not defined CARGO_TARGET_DIR set "CARGO_TARGET_DIR=%~d0\mcb"
cd /d "%~dp0"
cargo build --release
if errorlevel 1 (
  echo Bridge build failed.
  exit /b 1
)
if not exist "%~dp0run" mkdir "%~dp0run"
copy /y "%CARGO_TARGET_DIR%\release\mc-bridge.exe" "%~dp0run\mc-bridge.new.exe" >nul
if errorlevel 1 (
  echo Could not copy the built bridge into bridge\run.
  exit /b 1
)
echo Bridge built. It is used the next time the bridge starts.
exit /b 0
