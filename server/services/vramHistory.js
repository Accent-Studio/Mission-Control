// VRAM history: used and total VRAM plus the three biggest processes, sampled every 10 s for 24 h.
// This is the one loop that runs with no page open. The per-process numbers come from one long-lived
// PowerShell child (gpuCounters.js) that the System page shares, and nvidia-smi is read through the
// System collectors' 3 s cache, so a sample costs one nvidia-smi call and no PowerShell start.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { sampleVram, applyCounters } from './system.js';
import { startGpuCounters } from './gpuCounters.js';

const FILE = path.join(DATA_DIR, 'vram-history.json');
const SAMPLE_MS = 10000;
const SAVE_MS = 5 * 60000;
const KEEP_MS = 24 * 3600000;
const MAX_POINTS = 360;
const RANGES = { '1h': 3600000, '6h': 6 * 3600000, '24h': KEEP_MS };

let points = []; // [epochMs, usedGB, [[name, mb], ...]]
let totalGB = null;
let dirty = false;
let started = false;

function prune(now = Date.now()) {
  const cut = now - KEEP_MS;
  let i = 0;
  while (i < points.length && points[i][0] < cut) i++;
  if (i) points = points.slice(i);
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.points)) {
      points = j.points.filter(
        (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Array.isArray(p[2]),
      );
      points.sort((a, b) => a[0] - b[0]);
    }
    if (Number.isFinite(j.totalGB)) totalGB = j.totalGB;
    prune();
  } catch {
    points = []; // no file yet, or one that cannot be read: start empty
  }
}

function save() {
  if (!dirty) return;
  try {
    prune();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ totalGB, points }));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch {
    // The next save retries.
  }
}

let sampling = false;

async function tick() {
  if (sampling) return;
  sampling = true;
  const at = Date.now(); // stamped when the tick starts, the counter refresh can take a few seconds
  try {
    const s = await sampleVram();
    if (!s) return;
    totalGB = s.totalGB;
    points.push([at, s.usedGB, s.top]);
    prune();
    dirty = true;
  } catch {
    // A failed sample is skipped.
  } finally {
    sampling = false;
  }
}

export function startVramHistory() {
  if (started) return;
  started = true;
  load();
  startGpuCounters(applyCounters);
  const sample = setInterval(tick, SAMPLE_MS);
  const saver = setInterval(save, SAVE_MS);
  sample.unref();
  saver.unref();
  setTimeout(tick, 1500).unref();
  // Signals end in process.exit (see jobs.js), so the exit event covers every shutdown.
  process.on('exit', save);
}

// The points of a range, at most 360. Each bucket keeps its highest sample and that sample's list.
export function getVramHistory(range) {
  const span = RANGES[range];
  if (!span) return null;
  const now = Date.now();
  const from = now - span;
  const inRange = points.filter((p) => p[0] >= from);
  if (inRange.length <= MAX_POINTS) return { totalGB, points: inRange };
  const width = span / MAX_POINTS;
  const best = new Map();
  for (const p of inRange) {
    // A point stamped exactly at `now` would land in bucket 360, so the index is clamped to 359.
    const b = Math.min(MAX_POINTS - 1, Math.floor((p[0] - from) / width));
    const cur = best.get(b);
    if (!cur || p[1] > cur[1]) best.set(b, p);
  }
  return { totalGB, points: [...best.keys()].sort((a, b) => a - b).map((k) => best.get(k)) };
}

export const VRAM_RANGES = Object.keys(RANGES);
