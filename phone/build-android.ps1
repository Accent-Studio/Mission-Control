# Builds the Mission Control phone app.
#   build-android.ps1              debug x86_64 (emulator) and release aarch64 (phone)
#   build-android.ps1 -DebugOnly       only the emulator build
#   build-android.ps1 -ReleaseOnly     only the phone build (signed with your key, see keystore.properties.example)
# Nothing here installs or copies the APKs anywhere: it prints where they are.
# No $ErrorActionPreference = 'Stop' on purpose: cargo writes its progress to stderr.
param(
  [switch]$DebugOnly,
  [switch]$ReleaseOnly
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = Join-Path $sdk 'ndk\25.1.8937393'
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr' }
# The build folder: builds\mc-phone in the temp folder (tempRoot in .data\config.json), else \mcp on this drive.
# Keep it short: the Android build is deep enough to hit Windows' path limit with a long one.
if (-not $env:CARGO_TARGET_DIR) {
  try { $c = Get-Content -Raw (Join-Path $here '..\.data\config.json') | ConvertFrom-Json; if ($c.tempRoot) { $env:CARGO_TARGET_DIR = Join-Path $c.tempRoot 'builds\mc-phone' } } catch {}
}
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = (Split-Path -Qualifier $here) + '\mcp' }

if (-not $DebugOnly -and -not $ReleaseOnly) { $DebugOnly = $true; $ReleaseOnly = $true }

function Invoke-Build([string[]]$buildArgs, [string]$apkDir) {
  Write-Host "bun run tauri android build $($buildArgs -join ' ')"
  & bun run tauri android build @buildArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED (exit $LASTEXITCODE)"; return $false }
  $apk = Get-ChildItem (Join-Path $here "src-tauri\gen\android\app\build\outputs\apk\$apkDir") -Filter *.apk -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($apk) { Write-Host "APK: $($apk.FullName)" } else { Write-Host 'No APK found where it was expected.' }
  return $true
}

Set-Location $here
$ok = $true
if ($DebugOnly) { if (-not (Invoke-Build @('--apk', '--debug', '--target', 'x86_64') 'universal/debug')) { $ok = $false } }
if ($ReleaseOnly) { if (-not (Invoke-Build @('--apk', '--target', 'aarch64') 'universal/release')) { $ok = $false } }
if (-not $ok) { exit 1 }
