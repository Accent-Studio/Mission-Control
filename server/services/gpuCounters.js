// One long-lived PowerShell child that reads the Windows GPU process memory counters every 10 s and
// prints one JSON line per sample (server/scripts/gpu-counters.ps1). A cold PowerShell start costs
// about 0.9 CPU-seconds, so starting one every 10 s all day was far too expensive. The newest sample
// is shared by the VRAM history loop and the System page.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gpu-counters.ps1');
const INTERVAL_SEC = 10;
const STALL_MS = 30000; // no line for this long: the child is killed and started again
const FRESH_MS = 30000; // a sample older than this is not used
const BACKOFF_MS = [2000, 5000, 15000, 60000];
const STABLE_MS = 60000; // a child that lived this long resets the backoff

let child = null;
let started = false;
let attempt = 0;
let spawnedAt = 0;
let lastLineAt = 0;
let latest = null; // { at, json }
let restartTimer = null;
let watchdog = null;
let onSample = null;
let firstWaiters = [];

function flushWaiters() {
  const w = firstWaiters;
  firstWaiters = [];
  for (const f of w) f();
}

function handleLine(line) {
  const text = line.replace(/^﻿/, '').trim();
  if (!text) return;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return; // not a sample (for example a stray warning)
  }
  if (!json || typeof json !== 'object') return;
  lastLineAt = Date.now();
  if (json.error) return; // the child is alive but this sample failed: keep the previous data
  latest = { at: lastLineAt, json };
  if (onSample) {
    try {
      onSample(json, lastLineAt);
    } catch {
      // A bad sample must not stop the stream.
    }
  }
  flushWaiters();
}

function launch() {
  restartTimer = null;
  let c;
  try {
    c = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SCRIPT,
        '-ParentPid',
        String(process.pid),
        '-IntervalSec',
        String(INTERVAL_SEC),
      ],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    scheduleRestart(); // PowerShell cannot be started: the history keeps working with totals only
    return;
  }
  child = c;
  spawnedAt = Date.now();
  lastLineAt = 0;
  let buf = '';
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handleLine(line);
    }
    if (buf.length > 4 * 1024 * 1024) buf = ''; // never grow without bound
  });
  c.stdout.on('error', () => {});
  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (child === c) child = null;
    if (Date.now() - spawnedAt >= STABLE_MS) attempt = 0;
    flushWaiters(); // do not keep a waiter hanging on a dead child
    scheduleRestart();
  };
  c.on('error', onEnd); // for example ENOENT when powershell.exe does not exist
  c.on('exit', onEnd);
  c.on('close', onEnd);
}

function scheduleRestart() {
  if (!started || restartTimer) return;
  const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt++;
  restartTimer = setTimeout(launch, ms);
  restartTimer.unref();
}

function killChild() {
  const c = child;
  if (!c) return;
  try {
    c.kill();
  } catch {
    // Already gone.
  }
}

function watch() {
  if (!child) return;
  const since = lastLineAt || spawnedAt;
  if (Date.now() - since > STALL_MS) killChild(); // the exit handler then schedules the restart
}

// Starts the child once. cb(json, at) is called for every good sample.
export function startGpuCounters(cb) {
  if (started) return;
  started = true;
  onSample = cb || null;
  if (process.platform !== 'win32') return; // the counters exist on Windows only
  launch();
  watchdog = setInterval(watch, 5000);
  watchdog.unref();
  // Every shutdown path ends in process.exit (signals, the restart with code 75), so this covers all of
  // them. The child also exits by itself when this process is gone.
  process.on('exit', () => {
    started = false;
    if (restartTimer) clearTimeout(restartTimer);
    killChild();
  });
}

// True while the child runs and has not stalled. Callers then rely on its samples and spawn nothing.
export function gpuCountersAlive() {
  if (!child) return false;
  return Date.now() - (lastLineAt || spawnedAt) <= STALL_MS;
}

// The newest sample no older than 30 s, or null.
export function latestGpuSample() {
  return latest && Date.now() - latest.at <= FRESH_MS ? latest : null;
}

// Resolves when a first sample exists, the child ends or ms pass, whichever comes first.
export function waitGpuSample(ms) {
  if (latestGpuSample() || !child) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      resolve();
    }
    firstWaiters.push(done);
  });
}
