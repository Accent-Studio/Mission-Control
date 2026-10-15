// System snapshot: CPU, RAM, GPU, processes. Also process killing and the older Ollama helpers.
import os from 'node:os';
import { run, runPS } from '../lib/run.js';
import { cached } from '../lib/cache.js';
import { publish } from '../lib/events.js';
import { peekEngineModels, unloadModel, ollamaState } from './engines.js';
import { gpuCountersAlive, latestGpuSample, waitGpuSample } from './gpuCounters.js';

const GB = 1024 ** 3;
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

// ---- Process list (one PowerShell call, shared by /api/system and /api/servers) ----

const PROC_SCRIPT =
  'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { ' +
  '[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; ' +
  'ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine; WorkingSetSize = $_.WorkingSetSize; ' +
  'Started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }) } })';

let snap = null; // newest successful process list: { at, list }

export function getProcesses(fresh = false) {
  const load = async () => {
    const r = await runPS(PROC_SCRIPT, { timeoutMs: 20000 });
    const list = Array.isArray(r.json) ? r.json : r.json ? [r.json] : [];
    if (!list.length) throw new Error('process list is empty');
    const mapped = list.map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name || '',
      exe: p.ExecutablePath || null,
      commandLine: p.CommandLine || null,
      ramMB: p.WorkingSetSize ? Math.round(p.WorkingSetSize / 1048576) : 0,
      startedAt: p.Started || null,
    }));
    snap = { at: Date.now(), list: mapped };
    return mapped;
  };
  if (fresh) return load();
  return cached('procs', 5000, load);
}

// A process list no older than maxAgeMs, loading a new one only when the newest is too old.
export function getProcessSnapshot(maxAgeMs) {
  if (snap && Date.now() - snap.at <= maxAgeMs) return Promise.resolve(snap.list);
  return getProcesses(true);
}

// ---- CPU load from two os.cpus() samples ----

let lastSample = null;
let lastLoad = 0;

function sampleCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total, at: Date.now() };
}

async function cpuLoadPct() {
  if (!lastSample) {
    lastSample = sampleCpu();
    await new Promise((r) => setTimeout(r, 500));
  }
  const now = sampleCpu();
  if (now.at - lastSample.at >= 400) {
    const dTotal = now.total - lastSample.total;
    const dIdle = now.idle - lastSample.idle;
    if (dTotal > 0) lastLoad = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
    lastSample = now;
  }
  return round(lastLoad, 1);
}

// ---- GPU ----

async function nvidia(args) {
  const r = await run('nvidia-smi', args, { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout : null;
}

const num = (s) => {
  const n = Number(String(s).trim());
  return Number.isFinite(n) && String(s).trim() !== '' ? n : null;
};

async function gpuInfo() {
  const out = await nvidia([
    '--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (!out || !out.trim()) return null;
  const f = out.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  // The CUDA version only changes with the driver, so the slow table call runs once per 10 minutes.
  const cuda = await cached('cuda', 600000, async () => {
    const table = await nvidia([]);
    const m = table && /CUDA (?:UMD )?Version:\s*([\d.]+)/.exec(table);
    return m ? m[1] : null;
  });
  return {
    name: f[0],
    driver: f[1],
    cuda,
    vramTotalGB: round((num(f[2]) ?? 0) / 1024),
    vramUsedGB: round((num(f[3]) ?? 0) / 1024),
    utilPct: num(f[4]),
    tempC: num(f[5]),
  };
}

// Per-process VRAM. nvidia-smi reports N/A for every process under WDDM, so the Windows
// "GPU Process Memory" counters are the real source. Slow (1 to 2 s), so they come from one long-lived
// PowerShell child (gpuCounters.js) that samples every 10 s. Only when that child is not running does
// refreshVram below read them with a one-off PowerShell call.
let vramByPid = new Map();
let vramNames = new Map(); // pid -> image name, read in the same PowerShell call as the counters
let vramAt = 0;
let vramBusy = false;

// A per-process figure above what the whole adapter reports is a driver quirk (dwm.exe has been
// seen at 11.7 GB on a card using 2.2 GB), so it is reported as unknown instead of as a number.
async function refreshVram() {
  if (vramBusy) return;
  vramBusy = true;
  try {
    // The WMI class and property names are English on every Windows language, unlike
    // Get-Counter paths, so this works on a French install. Instance names look like
    // pid_1756_luid_0x00000000_0x00019764_phys_0 and are not localized either.
    const r = await runPS(
      '$p = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ' +
        'Where-Object { $_.DedicatedUsage -gt 0 } | Select-Object Name, DedicatedUsage); ' +
        '$a = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ' +
        'Select-Object Name, DedicatedUsage); ' +
        '$ids = @($p | ForEach-Object { if ($_.Name -match "^pid_(\\d+)_") { [int]$Matches[1] } } | Select-Object -Unique); ' +
        '$n = @(if ($ids.Count) { Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id, ProcessName }); ' +
        'ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ procs = $p; adapters = $a; names = $n })',
      { timeoutMs: 20000 },
    );
    applyCounters(r.json);
  } finally {
    vramAt = Date.now(); // also after a failure, so a broken query is retried every 10 s, not every tick
    vramBusy = false;
  }
}

// Turns one counter sample ({ procs, adapters, names } as the PowerShell side prints it) into the
// per-process maps. Used for the child's samples and for the one-off fallback call.
export function applyCounters(json) {
  const procs = json && Array.isArray(json.procs) ? json.procs : [];
  const adapters = json && Array.isArray(json.adapters) ? json.adapters : [];
  // The busiest adapter is the NVIDIA card (other adapters, such as the basic render driver, sit at 0).
  let adapter = null;
  for (const a of adapters) if (!adapter || a.DedicatedUsage > adapter.DedicatedUsage) adapter = a;
  const limit = adapter && adapter.DedicatedUsage > 0 ? adapter.DedicatedUsage * 1.1 + 64 * 1048576 : Infinity;
  const next = new Map();
  for (const row of procs) {
    const m = /^pid_(\d+)_(.+)$/.exec(row.Name || '');
    if (!m) continue;
    if (adapter && m[2] !== adapter.Name) continue; // other adapters would double count
    const pid = Number(m[1]);
    const prev = next.get(pid) || { bytes: 0, suspect: false };
    prev.bytes += row.DedicatedUsage;
    if (row.DedicatedUsage > limit) prev.suspect = true;
    next.set(pid, prev);
  }
  vramByPid = new Map(
    [...next].map(([pid, v]) => [pid, { mb: v.suspect ? null : v.bytes / 1048576, suspect: v.suspect }]),
  );
  const names = json && Array.isArray(json.names) ? json.names : [];
  vramNames = new Map(names.filter((x) => x && x.ProcessName).map((x) => [x.Id, `${x.ProcessName}.exe`]));
  vramAt = Date.now();
}

async function gpuProcs(procs) {
  if (gpuCountersAlive()) {
    // The long-lived child keeps the numbers current, so nothing is spawned here. Only the very first
    // call can find no sample yet, and it waits a few seconds for one.
    if (!vramAt) await waitGpuSample(6000);
  } else if (Date.now() - vramAt > 10000) {
    const p = refreshVram().catch(() => {});
    if (!vramAt) await p; // first call waits so the first answer is real
  }
  const names = new Map(procs.map((p) => [p.pid, p.name]));
  for (const [pid, n] of vramNames) if (!names.has(pid)) names.set(pid, n);
  const rows = new Map();
  for (const [pid, v] of vramByPid) {
    const row = { pid, name: names.get(pid) || null, vramMB: v.mb == null ? null : Math.round(v.mb) };
    if (v.suspect) row.note = 'counter unreliable';
    rows.set(pid, row);
  }
  // Compute apps nvidia-smi knows about but the counters missed: report null honestly.
  const out = await nvidia(['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']);
  if (out) {
    for (const line of out.trim().split(/\r?\n/).filter(Boolean)) {
      const [pidS, , memS] = line.split(',').map((s) => s.trim());
      const pid = num(pidS);
      if (pid == null || rows.has(pid)) continue;
      rows.set(pid, { pid, name: names.get(pid) || null, vramMB: num(memS) });
    }
  }
  const list = [...rows.values()]
    .filter((r) => r.vramMB == null || r.vramMB > 0)
    .sort((a, b) => (b.vramMB ?? -1) - (a.vramMB ?? -1))
    .slice(0, 15);
  return attachModels(list, procs);
}

// Gives every row the models of the local AI engine it owns (the process that listens on the engine's
// port). Engines like Ollama keep their models in child processes, so the models go to the rows of the
// owner and everything below it: the owner's own row does not win just because it is the owner (a
// launcher can show 1 MB while its runner holds the GBs). With several runners each model goes to the
// runner whose VRAM is closest to the model's own size, each runner once while unused runners remain.
// A model of unknown size, or an owner tree with no usable figure, falls back to the biggest row.
// Uses the cached engine list only. Rows must be sorted by vramMB, biggest first.
const RUNNER_MIN_MB = 128; // smaller rows are launchers and helpers, not runners

export function attachModels(rows, procs) {
  return assignModels(rows, procs, peekEngineModels());
}

// The pure part of attachModels: ownerPid -> models is given, so it can be checked without any engine.
export function assignModels(rows, procs, modelsByOwner) {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const below = (pid, owner) => {
    let cur = pid;
    for (let i = 0; i < 8 && cur; i++) {
      cur = parent.get(cur);
      if (cur === owner) return true;
    }
    return false;
  };
  const size = (r) => (r.vramMB == null ? -1 : r.vramMB);
  const given = new Map();
  for (const [owner, models] of modelsByOwner) {
    const tree = rows.filter((r) => r.pid === owner || below(r.pid, owner));
    if (!tree.length) continue;
    const biggest = tree.reduce((x, y) => (size(y) > size(x) ? y : x));
    let runners = tree.filter((r) => size(r) >= RUNNER_MIN_MB);
    if (!runners.length) runners = [biggest];
    const used = new Set();
    // Big models choose first; models of unknown size go last.
    const order = [...models].sort((m, n) => (Number.isFinite(n.vramMB) ? n.vramMB : -1) - (Number.isFinite(m.vramMB) ? m.vramMB : -1));
    for (const m of order) {
      const free = runners.filter((r) => !used.has(r.pid));
      const pool = free.length ? free : runners;
      let target = pool.reduce((x, y) => (size(y) > size(x) ? y : x)); // biggest of the pool
      if (Number.isFinite(m.vramMB) && m.vramMB > 0) {
        for (const r of pool) {
          if (Math.abs(size(r) - m.vramMB) < Math.abs(size(target) - m.vramMB)) target = r;
        }
      }
      used.add(target.pid);
      given.set(target.pid, [...(given.get(target.pid) || []), m]);
    }
  }
  for (const r of rows) r.models = given.get(r.pid) || [];
  return rows;
}

// Latest per-process VRAM of a process and everything below it, in MB (null when none is known).
// Reads the newest process list without loading a new one. Engines use it for a single loaded model.
export function vramOfTree(rootPid) {
  const kids = new Map();
  for (const p of snap ? snap.list : []) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  let sum = 0;
  let any = false;
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const v = vramByPid.get(pid);
    if (v && v.mb != null) {
      sum += v.mb;
      any = true;
    }
    stack.push(...(kids.get(pid) || []));
  }
  return any ? Math.round(sum) : null;
}

// One history sample: used and total VRAM plus the three biggest processes. Called every 10 s by
// vramHistory.js, with or without a page open. The counters refresh here (the same refresh the System
// page uses, so a page open at the same time reads the same numbers) and nvidia-smi is shared through
// the 3 s cache. Null when there is no NVIDIA card or nvidia-smi.
export async function sampleVram() {
  const gpu = await cached('gpuinfo', 3000, gpuInfo).catch(() => null);
  if (!gpu || !gpu.vramTotalGB) return null;
  // The per-process list comes from the long-lived child. Without a fresh sample (PowerShell cannot
  // start, or the child is restarting) the point is saved with totals only and nothing is spawned.
  if (gpuCountersAlive() && !latestGpuSample()) await waitGpuSample(5000);
  const fresh = latestGpuSample();
  const top = (fresh ? [...vramByPid] : [])
    .filter(([, v]) => v.mb != null && v.mb > 0)
    .sort((a, b) => b[1].mb - a[1].mb)
    .slice(0, 3)
    .map(([pid, v]) => [vramNames.get(pid) || `pid ${pid}`, Math.round(v.mb)]);
  return { usedGB: gpu.vramUsedGB, totalGB: gpu.vramTotalGB, top };
}

// ---- Snapshot ----

export function getSystem() {
  return cached('system', 3000, async () => {
    const [cpuPct, gpu, procs] = await Promise.all([
      cpuLoadPct(),
      cached('gpuinfo', 3000, gpuInfo).catch(() => null),
      getProcesses().catch(() => []),
    ]);
    const total = os.totalmem();
    const cpus = os.cpus();
    return {
      cpu: { name: cpus[0] ? cpus[0].model.trim() : 'unknown', cores: cpus.length, loadPct: cpuPct },
      ram: { totalGB: round(total / GB), usedGB: round((total - os.freemem()) / GB) },
      gpu,
      gpuProcs: gpu ? await gpuProcs(procs).catch(() => []) : [],
      topRam: [...procs]
        .sort((a, b) => b.ramMB - a.ramMB)
        .slice(0, 12)
        .map((p) => ({ pid: p.pid, name: p.name, ramMB: p.ramMB })),
    };
  });
}

// ---- Kill ----

// Compared lowercase and without ".exe".
const PROTECTED_NAMES = new Set([
  'system', 'system idle process', 'secure system', 'registry', 'memory compression', 'memcompression',
  'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsm', 'svchost', 'sihost', 'ctfmon',
  'explorer', 'dwm', 'fontdrvhost', 'audiodg', 'wudfhost', 'securityhealthservice', 'nvdisplay.container',
  'msmpeng', 'msmpengcp', 'nissrv', 'mssense', 'mbamservice', 'mbamtray', 'claude',
  'mc-bridge', // the phone bridge program
]);

function baseName(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/, '');
}

function protectedReason(p, guarded) {
  if (p.pid === 0 || p.pid === 4) return 'system process';
  if (guarded.has(p.pid)) {
    return p.pid === process.pid ? 'this is the Mission Control server itself' : 'it started the Mission Control server';
  }
  const n = baseName(p.name);
  if (PROTECTED_NAMES.has(n) || n.startsWith('mbam')) return `${p.name} is on the protected list`;
  const hay = `${p.exe || ''}\n${p.commandLine || ''}`.toLowerCase();
  if (hay.includes('\\anthropicclaude\\') || hay.includes('claude_pzs8sxrjxfjjc')) return 'part of the Claude app';
  return null;
}

// The server itself plus every ancestor, so that nothing above it in the process tree can be killed
// (it is often started from a terminal or by Claude, and /T-style kills take the whole subtree).
function guardedPids(byPid) {
  const guarded = new Set([process.pid]);
  if (process.ppid) guarded.add(process.ppid);
  let cur = byPid.get(process.pid);
  while (cur && cur.ppid && !guarded.has(cur.ppid)) {
    guarded.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  // Follow the chain from the ppid reported by node too, in case the server is missing from the list.
  cur = byPid.get(process.ppid);
  while (cur && cur.ppid && !guarded.has(cur.ppid)) {
    guarded.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return guarded;
}

// Descendants of root. With strict=true a child must have started after its parent, which drops
// links that only exist because a dead parent's pid was reused. Refusal checks use strict=false
// (more cautious); the kill list uses strict=true (never kills a process that is not really a child).
function subtree(root, kids, strict) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    for (const c of kids.get(p.pid) || []) {
      if (strict && p.startedAt && c.startedAt && c.startedAt < p.startedAt) continue;
      stack.push(c);
    }
  }
  return out;
}

// Current pid to image name map from tasklist (native, about 0.3 s). Image names are not localized.
async function liveNames() {
  const r = await run('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 10000 });
  if (r.code !== 0) return null;
  const map = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)",/.exec(line);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map.size ? map : null;
}

const MAX_SNAPSHOT_AGE_MS = 10000;

export async function killProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return { ok: false, status: 400, error: 'pid must be a positive integer' };
  }
  // The snapshot only decides the tree and the refusals. It may be up to 10 s old (the dashboard
  // refreshes it every 5 s), which makes a kill take well under a second instead of a full
  // PowerShell round trip. Every pid is re-checked by name against the live process table right
  // before the kill, so a reused pid or a changed process is refused instead of killed.
  let procs;
  try {
    procs = await getProcessSnapshot(MAX_SNAPSHOT_AGE_MS);
    // A process started after the snapshot is not in it: look again before saying it does not exist.
    if (!procs.some((p) => p.pid === pid) && snap && Date.now() - snap.at > 1000) procs = await getProcesses(true);
  } catch {
    return { ok: false, status: 503, error: 'Could not read the process list, try again' };
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const target = byPid.get(pid);
  if (!target) return { ok: false, status: 404, error: `No process with pid ${pid}` };
  const guarded = guardedPids(byPid);
  const direct = protectedReason(target, guarded);
  if (direct) return { ok: false, status: 403, error: `Refused: ${direct}`, pid, name: target.name };
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  for (const p of subtree(target, kids, false).slice(1)) {
    const why = protectedReason(p, guarded);
    if (why) {
      return { ok: false, status: 403, error: `Refused: child ${p.name} (${p.pid}) would also die, ${why}`, pid, name: target.name };
    }
  }
  // Kill exactly the checked pids (no /T), so a child that appeared after the snapshot is never touched.
  const tree = subtree(target, kids, true);
  const live = await liveNames();
  if (!live) return { ok: false, status: 500, error: 'Could not read the live process table', pid, name: target.name };
  for (const p of tree) {
    const now = live.get(p.pid);
    if (now === undefined) continue; // already gone, fine
    if (baseName(now) !== baseName(p.name)) {
      return { ok: false, status: 409, error: `Refused: pid ${p.pid} is now ${now}, not ${p.name}. Refresh and try again`, pid, name: target.name };
    }
  }
  const pids = tree.filter((p) => live.has(p.pid)).map((p) => p.pid);
  if (!live.has(pid)) return { ok: false, status: 404, error: `No process with pid ${pid}` };
  const args = [];
  for (const id of pids) args.push('/PID', String(id));
  args.push('/F');
  const r = await run('taskkill', args, { timeoutMs: 10000 });
  // Signal 0 only tests that the pid exists (no tasklist round trip). Give the kill a moment to land.
  const exists = (id) => {
    try {
      process.kill(id, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  for (let i = 0; i < 10 && exists(pid); i++) await new Promise((res) => setTimeout(res, 100));
  const ok = !exists(pid);
  if (ok) publish('system.changed', { action: 'kill', pid });
  return {
    ok,
    status: ok ? 200 : 500,
    pid,
    name: target.name,
    killed: ok ? tree.filter((p) => live.has(p.pid) && !exists(p.pid)).map((p) => `${p.name} (${p.pid})`) : [],
    detail: (r.stdout + r.stderr).trim().slice(0, 300),
  };
}

// ---- Ollama (older routes, now served by the engine adapter in engines.js) ----

export function getOllama() {
  return ollamaState();
}

// Only names that look like Ollama model names ("llama3:8b", "library/qwen2.5:7b-q4", "hf.co/x/y:Q4_K_M").
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,199}$/;

export function validModelName(name) {
  return typeof name === 'string' && MODEL_NAME.test(name);
}

// Unloads a model that is currently loaded (the name must be in Ollama's own list, so an unload can
// never make Ollama load a model).
export async function unloadOllama(model) {
  if (!validModelName(model)) return { ok: false, status: 400, error: 'Invalid model name' };
  const r = await unloadModel('ollama', model, { settleMs: 0 });
  if (r.engineDown) return { ok: false, status: 502, error: 'Ollama is not reachable' };
  if (!r.ok) return { ok: false, status: r.status, model, error: r.error };
  return { ok: true, status: 200, model };
}
