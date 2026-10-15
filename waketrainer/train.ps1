# Usage: .\train.ps1 --phrase "hey mission control" [--clips folder] [--out file.onnx] [--preset quick|standard|thorough]
. "$PSScriptRoot\env.ps1"
Set-Location $PSScriptRoot
& "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\train.py" @args
exit $LASTEXITCODE
