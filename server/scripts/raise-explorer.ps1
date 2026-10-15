# Brings the Explorer window that shows $env:MC_REVEAL_DIR to the front (server/services/paths.js starts it right after
# explorer.exe). A program in the background may not take the focus on its own, so the window is made topmost for a
# moment (always allowed), then normal again, and given the focus after a tap of Alt, which lifts the focus lock.
# The folder comes in through the environment, never through the command line.
$ErrorActionPreference = 'SilentlyContinue'
$want = "$env:MC_REVEAL_DIR".TrimEnd('\').ToLowerInvariant()
if (-not $want) { exit 0 }
Add-Type -Namespace MC -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
'@
$shell = New-Object -ComObject Shell.Application
$deadline = (Get-Date).AddSeconds(6)
$hwnd = [IntPtr]::Zero
while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  foreach ($w in @($shell.Windows())) {
    $p = $null
    try { $p = $w.Document.Folder.Self.Path } catch { }
    if ($p -and $p.TrimEnd('\').ToLowerInvariant() -eq $want) { $hwnd = [IntPtr]$w.HWND }
  }
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
}
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
if ([MC.Win]::IsIconic($hwnd)) { [void][MC.Win]::ShowWindow($hwnd, 9) }   # SW_RESTORE
$flags = 0x0001 -bor 0x0002 -bor 0x0040                                     # NOSIZE, NOMOVE, SHOWWINDOW
[void][MC.Win]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags)       # topmost
[void][MC.Win]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, $flags)       # back to normal, still on top
[MC.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)                          # Alt down
[MC.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)                          # Alt up
[void][MC.Win]::SetForegroundWindow($hwnd)
