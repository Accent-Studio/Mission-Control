# One-time data download (about 23GB). Resumable: run again if it is interrupted.
. "$PSScriptRoot\env.ps1"
Set-Location $PSScriptRoot
& "$PSScriptRoot\.venv\Scripts\livekit-wakeword.exe" setup --data-dir "$PSScriptRoot\data"
