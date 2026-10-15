// Plan usage (5-hour and weekly windows). Two sources, both through the official claude CLI only:
//  - "run": the rate_limit_event line every headless run streams (free, as fresh as the last model response)
//  - "probe": the CLI's own get_usage control request (no model call, takes about 15 seconds)
// Mission Control never reads a credential file and never talks to an Anthropic endpoint itself.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { readJson } from '../lib/jsonStore.js';

const FILE = path.join(DATA_DIR, 'usage.json');
const PROBE_TIMEOUT_MS = 30000; // measured 14 to 19 seconds on this machine, so 20 would often fail
const PROBE_MIN_GAP_MS = 20000; // a second refresh inside this gap returns the fresh value instead of spawning again
const PERSIST_GAP_MS = 60000; // an unchanged value only refreshes observedAt on disk this often

let state = null; // { fiveHour, sevenDay, status, overageStatus, observedAt, source }
let lastPersist = 0;

function empty() {
  return { fiveHour: null, sevenDay: null, status: null, overageStatus: null, observedAt: null, source: null };
}

function cleanWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.pct);
  if (!Number.isFinite(pct)) return null;
  let resetsAt = null;
  if (typeof w.resetsAt === 'string' && !Number.isNaN(Date.parse(w.resetsAt))) resetsAt = new Date(w.resetsAt).toISOString();
  return { pct: Math.round(pct * 10) / 10, resetsAt };
}

function load() {
  if (state) return state;
  state = empty();
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    if (o && typeof o === 'object') {
      state.fiveHour = cleanWindow(o.fiveHour);
      state.sevenDay = cleanWindow(o.sevenDay);
      state.status = typeof o.status === 'string' ? o.status : null;
      state.overageStatus = typeof o.overageStatus === 'string' ? o.overageStatus : null;
      state.observedAt = typeof o.observedAt === 'string' ? o.observedAt : null;
      state.source = o.source === 'run' || o.source === 'probe' ? o.source : null;
    }
  } catch {
    // no file yet, or unreadable: start empty
  }
  return state;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
    lastPersist = Date.now();
  } catch (err) {
    console.error('[usage] could not save usage.json:', err.message);
  }
}

export function getUsage() {
  const s = load();
  return {
    fiveHour: s.fiveHour,
    sevenDay: s.sevenDay,
    status: s.status,
    overageStatus: s.overageStatus,
    observedAt: s.observedAt,
    source: s.source,
  };
}

const signature = (s) => JSON.stringify([s.fiveHour, s.sevenDay, s.status, s.overageStatus, s.source]);

// patch: any of fiveHour, sevenDay (windows or null), status, overageStatus. Missing keys keep the old value.
function apply(patch, source) {
  const s = load();
  const before = signature(s);
  for (const k of ['fiveHour', 'sevenDay', 'status', 'overageStatus']) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
  }
  s.source = source;
  s.observedAt = new Date().toISOString();
  const changed = before !== signature(s);
  if (changed || Date.now() - lastPersist > PERSIST_GAP_MS) persist();
  if (changed) publish('usage', getUsage());
  noteHistory(s);
  return changed;
}

// ---- History for the Usage page: the two windows over time ----
// A sample when a value changed (at most one every HISTORY_MIN_MS, the newest value replaces a closer one), and one every
// HISTORY_GAP_MS otherwise; 120 days kept. Saved to .data/plan-history.json at most every SAVE_DELAY_MS, off the hot path:
// a rate limit event comes with every answer.
const HISTORY_FILE = path.join(DATA_DIR, 'plan-history.json');
const HISTORY_MIN_MS = 2 * 60e3;
const HISTORY_GAP_MS = 10 * 60e3;
const HISTORY_KEEP_MS = 120 * 24 * 3600e3;
const SAVE_DELAY_MS = 30e3;
let history = null; // [{ t, five, seven, fiveReset, sevenReset }]
let saveT = null;

// A file that could not be read right now gives an empty answer that is not kept: the next call reads again, and no
// sample is added meanwhile, so 120 days of history are never written over by a nearly empty list (jsonStore.js).
function loadHistory() {
  if (history) return history;
  const r = readJson(HISTORY_FILE, 'usage');
  const o = r.value;
  const list = Array.isArray(o && o.samples) ? o.samples.filter((x) => x && Number.isFinite(x.t)) : [];
  if (r.ok) history = list;
  return list;
}

function noteHistory(s) {
  const h = loadHistory();
  if (!history) return;
  const five = s.fiveHour ? s.fiveHour.pct : null;
  const seven = s.sevenDay ? s.sevenDay.pct : null;
  if (five === null && seven === null) return;
  const now = Date.now();
  const last = h[h.length - 1];
  const same = last && last.five === five && last.seven === seven;
  if (same && now - last.t < HISTORY_GAP_MS) return;
  const sample = { t: now, five, seven, fiveReset: s.fiveHour ? s.fiveHour.resetsAt : null, sevenReset: s.sevenDay ? s.sevenDay.resetsAt : null };
  // A change soon after the last sample replaces it, unless that one starts the run (two points draw the line)
  if (!same && last && now - last.t < HISTORY_MIN_MS && h.length > 1) h[h.length - 1] = sample;
  else h.push(sample);
  while (h.length && now - h[0].t > HISTORY_KEEP_MS) h.shift();
  if (!saveT) {
    saveT = setTimeout(saveHistory, SAVE_DELAY_MS);
    if (saveT.unref) saveT.unref();
  }
}

function saveHistory() {
  saveT = null;
  if (!history) return;
  const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
  fs.promises
    .writeFile(tmp, JSON.stringify({ samples: history || [] }))
    .then(() => fs.promises.rename(tmp, HISTORY_FILE))
    .catch((err) => console.error('[usage] could not save plan-history.json:', err.message));
}

// The samples between two times (ms), oldest first, at most about `max` of them: a long range keeps the highest value of
// each slice of time (a limit that was nearly reached must still show).
export function planHistory(from = 0, to = Infinity, max = 400) {
  const list = loadHistory().filter((x) => x.t >= from && x.t <= to);
  if (list.length <= max) return list;
  const span = (list[list.length - 1].t - list[0].t) / max;
  const out = [];
  let slot = -1;
  for (const x of list) {
    const k = Math.floor((x.t - list[0].t) / span);
    const cur = out[out.length - 1];
    if (k !== slot || !cur) {
      out.push({ ...x });
      slot = k;
    } else {
      if ((x.five ?? -1) > (cur.five ?? -1)) cur.five = x.five;
      if ((x.seven ?? -1) > (cur.seven ?? -1)) cur.seven = x.seven;
    }
  }
  return out;
}

function fromEventWindow(w) {
  if (!w || typeof w !== 'object' || w.utilization === null || w.utilization === undefined || w.utilization === '') return undefined;
  const u = Number(w.utilization);
  if (!Number.isFinite(u)) return undefined;
  const r = Number(w.resetsAt);
  return { pct: Math.round(u * 1000) / 10, resetsAt: Number.isFinite(r) && r > 0 ? new Date(r * 1000).toISOString() : null };
}

// Called by the run reader for every stream line of type rate_limit_event.
export function ingestRateLimitEvent(event) {
  const info = event && event.rate_limit_info;
  if (!info || typeof info !== 'object') return;
  const patch = {};
  const uw = info.unifiedWindows;
  if (uw && typeof uw === 'object') {
    const five = fromEventWindow(uw.five_hour);
    const seven = fromEventWindow(uw.seven_day);
    if (five) patch.fiveHour = five;
    if (seven) patch.sevenDay = seven;
  }
  if (!Object.keys(patch).length) return; // API-key sessions carry no plan windows
  if (typeof info.status === 'string') patch.status = info.status;
  if (typeof info.overageStatus === 'string') patch.overageStatus = info.overageStatus;
  apply(patch, 'run');
}

// ---- Probe through the CLI's get_usage control request ----

function fail(message) {
  return Object.assign(new Error(message), { status: 502 });
}

function killTree(child) {
  if (!child || !child.pid) return;
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {});
}

function fromProbeWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const u = Number(w.utilization);
  if (w.utilization === null || !Number.isFinite(u)) return null;
  let resetsAt = null;
  if (typeof w.resets_at === 'string' && !Number.isNaN(Date.parse(w.resets_at))) resetsAt = new Date(w.resets_at).toISOString();
  return { pct: Math.round(u * 10) / 10, resetsAt };
}

function statusFromProbe(rl, five, seven) {
  const rows = Array.isArray(rl.limits) ? rl.limits : [];
  if ((five && five.pct >= 100) || (seven && seven.pct >= 100)) return 'rejected';
  if (rows.some((r) => r && (r.severity === 'warning' || r.severity === 'critical'))) return 'allowed_warning';
  return 'allowed';
}

function probeOnce() {
  return new Promise((resolve, reject) => {
    import('./runs.js')
      .then(({ resolveClaude }) => resolveClaude())
      .then((entry) => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // The folder is neutral (not a project), and nothing is saved to the session history.
        // -p is required for the stream-json input mode. No prompt is ever written, so no model is called.
        const args = [
          ...entry.pre,
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
        ];
        const requestId = 'mc-usage-' + Date.now();
        let child;
        try {
          child = spawn(entry.cmd, args, { cwd: DATA_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        } catch (err) {
          return reject(fail('Could not start the claude CLI: ' + String(err.message).slice(0, 120)));
        }
        let done = false;
        let buf = '';
        let errTail = '';
        const end = (err, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            child.stdin.end();
          } catch {
            // already closed
          }
          setTimeout(() => killTree(child), 300).unref();
          if (err) reject(err);
          else resolve(value);
        };
        const timer = setTimeout(() => end(fail(`The CLI did not answer get_usage within ${PROBE_TIMEOUT_MS / 1000} seconds`)), PROBE_TIMEOUT_MS);
        child.on('error', (err) => end(fail('Could not run the claude CLI: ' + String(err.message).slice(0, 120))));
        child.on('close', (code) =>
          end(fail(`The CLI exited (code ${code}) before answering get_usage` + (errTail.trim() ? ': ' + errTail.trim().slice(-120) : ''))),
        );
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c) => {
          errTail = (errTail + c).slice(-500);
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          if (buf.length > 16 * 1024 * 1024) buf = '';
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.startsWith('{')) continue;
            let o;
            try {
              o = JSON.parse(line);
            } catch {
              continue;
            }
            if (!o || o.type !== 'control_response' || !o.response || o.response.request_id !== requestId) continue;
            if (o.response.subtype !== 'success') {
              return end(fail('get_usage was refused: ' + String(o.response.error || o.response.subtype).slice(0, 120)));
            }
            return end(null, o.response.response || {});
          }
        });
        const req = { type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } };
        child.stdin.on('error', () => {});
        child.stdin.write(JSON.stringify(req) + '\n');
      })
      .catch((err) => reject(err && err.status ? err : fail('Could not find the claude CLI')));
  });
}

let inflight = null;
let lastOk = 0;

// Asks the CLI for the current plan usage. Resolves to the same object GET /api/usage returns,
// or rejects with an error whose message is a short reason (status 502).
export function refreshUsage() {
  if (inflight) return inflight;
  if (Date.now() - lastOk < PROBE_MIN_GAP_MS) return Promise.resolve(getUsage());
  inflight = probeOnce()
    .then((r) => {
      if (!r || r.rate_limits_available === false || !r.rate_limits || typeof r.rate_limits !== 'object') {
        throw fail('The CLI reports no plan limits for this login (rate_limits_available is false)');
      }
      const five = fromProbeWindow(r.rate_limits.five_hour);
      const seven = fromProbeWindow(r.rate_limits.seven_day);
      if (!five && !seven) throw fail('The CLI answered but gave no five-hour or weekly figures');
      apply({ fiveHour: five, sevenDay: seven, status: statusFromProbe(r.rate_limits, five, seven) }, 'probe');
      lastOk = Date.now();
      return getUsage();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
