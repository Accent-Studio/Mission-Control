@echo off
rem Test stand-in for train.bat: passes every argument on to the fake Node trainer, so the cmd.exe route is exercised.
node "%~dp0fake-waketrainer.mjs" %*
exit /b %ERRORLEVEL%
