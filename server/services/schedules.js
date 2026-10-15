// Windows scheduled tasks. Read-only listing plus running an existing MissionControl task.
import { run, runPS } from '../lib/run.js';
import { cached, invalidate } from '../lib/cache.js';

const MC_FOLDER = '\\MissionControl\\';

// Fixed script (no request input). Emits {mc: [...], other: [...]}.
// Uses the Task Scheduler COM object: one PowerShell process, no ScheduledTasks/CIM module load and
// no per-task Get-ScheduledTaskInfo call. Read-only.
const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stateNames = @{ 0 = 'Unknown'; 1 = 'Disabled'; 2 = 'Queued'; 3 = 'Ready'; 4 = 'Running' }
function Fmt($d) { if ($d -and $d.Year -gt 1999) { $d.ToString('yyyy-MM-ddTHH:mm:ss.fffffffzzz') } else { $null } }
function Trig($t) {
  $time = ''
  if ($t.StartBoundary) { try { $time = ([datetime]$t.StartBoundary).ToString('HH:mm') } catch {} }
  switch ([int]$t.Type) {
    1 { if ($t.StartBoundary) { try { 'Once ' + ([datetime]$t.StartBoundary).ToString('yyyy-MM-dd HH:mm') } catch { 'Once' } } else { 'Once' } }
    2 { if ($t.DaysInterval -gt 1) { "Every $($t.DaysInterval) days $time" } else { "Daily $time" } }
    3 { "Weekly $time" }
    4 { "Monthly $time" }
    5 { 'MonthlyDOW' }
    6 { 'When idle' }
    7 { 'Registration' }
    8 { 'At startup' }
    9 { 'At logon' }
    11 { 'SessionStateChange' }
    default { 'Unknown' }
  }
}
function Rows($folderPath, $full) {
  $out = @()
  try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    $folder = $svc.GetFolder($folderPath)
    foreach ($task in $folder.GetTasks(1)) {
      $o = [ordered]@{
        name = [string]$task.Name
        state = [string]$stateNames[[int]$task.State]
        nextRun = Fmt $task.NextRunTime
      }
      if ($full) {
        $o.lastRun = Fmt $task.LastRunTime
        $r = [int64]$task.LastTaskResult
        if ($r -lt 0) { $r += 4294967296 }
        $o.lastResult = $r
        $w = ''
        try { $w = (@($task.Definition.Triggers | ForEach-Object { Trig $_ }) -join ', ') } catch {}
        $o.when = $w
      }
      $out += ,$o
    }
  } catch {}
  $out
}
$mc = @(Rows '\MissionControl' $true)
$other = @(Rows '\' $false)
[ordered]@{ mc = $mc; other = $other } | ConvertTo-Json -Depth 4 -Compress
`;

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function parseJson(text) {
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export async function getSchedules() {
  try {
    return await cached('schedules', 30000, async () => {
      const r = await runPS(LIST_SCRIPT, { timeoutMs: 25000 });
      const j = r.json || parseJson(r.stdout);
      // A failed or timed out PowerShell must not be cached as "no tasks".
      if (!j || typeof j !== 'object') throw new Error('schedule query failed');
      const tasks = asArray(j.mc).map((t) => ({ ...t, neverRan: t.lastResult === 267011 }));
      return { folder: MC_FOLDER, tasks, other: asArray(j.other) };
    });
  } catch {
    return { folder: MC_FOLDER, tasks: [], other: [], error: 'Could not read scheduled tasks' };
  }
}

export async function runSchedule(name) {
  const list = await getSchedules();
  if (list.error) return { ok: false, status: 500, error: list.error };
  const hit = typeof name === 'string' ? list.tasks.find((t) => t.name === name) : null;
  if (!hit) return { ok: false, status: 404, error: 'No such task in ' + MC_FOLDER };
  // execFile, no shell: the argument is built from the listed task name, never from request text.
  const r = await run('schtasks.exe', ['/Run', '/TN', MC_FOLDER + hit.name], { timeoutMs: 10000 });
  invalidate('schedules');
  return r.code === 0 ? { ok: true } : { ok: false, status: 500, error: 'schtasks failed' };
}
