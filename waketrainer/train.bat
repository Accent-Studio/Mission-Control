@echo off
rem Usage: train.bat --phrase "hey mission control" [--clips folder] [--out file.onnx] [--preset quick|standard|thorough]
call "%~dp0env.bat"
cd /d "%~dp0"
"%~dp0.venv\Scripts\python.exe" "%~dp0train.py" %*
exit /b %ERRORLEVEL%
