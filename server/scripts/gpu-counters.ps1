# Long-lived GPU counter reader for Mission Control (Windows PowerShell 5.1, pure ASCII).
# Every IntervalSec seconds it prints ONE line of compact JSON to stdout:
#   {"t":<epoch ms>,"procs":[{Name,DedicatedUsage}],"adapters":[{Name,DedicatedUsage}],"names":[{Id,ProcessName}]}
# or {"t":<epoch ms>,"error":"..."} when a sample failed. It exits by itself when ParentPid is gone, so
# it can never outlive the Mission Control server, even after a crash.
param(
    [Parameter(Mandatory = $true)][int]$ParentPid,
    [int]$IntervalSec = 10
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Holding the parent's process handle makes the wait below exact and immune to pid reuse.
try {
    $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid)
}
catch {
    exit 0
}

$epoch = New-Object System.DateTime(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
$procClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory'
$adapterClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory'
$session = $null
try {
    $session = New-CimSession
}
catch {
    $session = $null
}

while ($true) {
    if ($parent.HasExited) { break }
    $t = [long][math]::Floor(([System.DateTime]::UtcNow - $epoch).TotalMilliseconds)
    try {
        # The WMI class and property names are English on every Windows language, unlike Get-Counter paths.
        if ($session) {
            $rawP = Get-CimInstance -CimSession $session -ClassName $procClass
            $rawA = Get-CimInstance -CimSession $session -ClassName $adapterClass
        }
        else {
            $rawP = Get-CimInstance -ClassName $procClass
            $rawA = Get-CimInstance -ClassName $adapterClass
        }
        $p = @($rawP | Where-Object { $_.DedicatedUsage -gt 0 } | Select-Object Name, DedicatedUsage)
        $a = @($rawA | Select-Object Name, DedicatedUsage)
        $ids = @($p | ForEach-Object { if ($_.Name -match '^pid_(\d+)_') { [int]$Matches[1] } } | Select-Object -Unique)
        # Image names for those pids. GetProcesses is about 15 times cheaper than Get-Process -Id.
        $want = @{}
        foreach ($i in $ids) { $want[[int]$i] = 1 }
        $n = New-Object System.Collections.ArrayList
        if ($want.Count -gt 0) {
            foreach ($pr in [System.Diagnostics.Process]::GetProcesses()) {
                if ($want.ContainsKey($pr.Id)) {
                    [void]$n.Add([pscustomobject]@{ Id = $pr.Id; ProcessName = $pr.ProcessName })
                }
                $pr.Dispose()
            }
        }
        $line = ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ t = $t; procs = $p; adapters = $a; names = @($n) })
    }
    catch {
        $msg = ([string]$_.Exception.Message) -replace '[^\x20-\x7E]', '?'
        $line = ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ t = $t; error = $msg })
    }
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
    if ($parent.WaitForExit($IntervalSec * 1000)) { break }
}
exit 0
