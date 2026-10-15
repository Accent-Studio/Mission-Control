// Wake word training: runs the local trainer (waketrainer\train.ps1, see config.js) one job at a time, keeps its progress
// for the page, stores the owner's voice clips, and installs a trained model into BlitzVoice.
//
// Safety: the trainer is started with an argument array and no shell. Every argument is validated first
// (letters, spaces and apostrophes only), the files are named from a slug, and a path from a request is never used.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { publish } from '../lib/events.js';
import { DATA_DIR, WAKETRAINER_DIR } from '../config.js';
import { setWakeSettings, wakeStatus } from './voice.js';

// Estimated minutes per preset on this PC (standard measured at 43 min: generate 7, augment 10, features 7, train 18).
export const PRESETS = { quick: 15, standard: 45, thorough: 120 };
export const STAGES = ['generate', 'augment', 'features', 'train', 'export', 'verify'];
export const MAX_NEGATIVES = 12;
export const MAX_CLIPS = 200;
export const MAX_CLIP_BYTES = 1024 * 1024;
export const MAX_CLIP_FOLDERS = 20;
export const MAX_CLIPS_TOTAL_BYTES = 200 * 1024 * 1024;
const WAV_TRAILING_MAX = 64;
export const CLIP_TARGET = 30;
const CLIP_MAX_SECONDS = 5;
const CLIP_MIN_SECONDS = 0.3;
const KEEP_LOGS = 10;

// Read at call time so tests can point every folder somewhere else with environment variables.
export function paths() {
  const root = process.env.MC_WAKETRAINER_DIR || WAKETRAINER_DIR;
  const appdata = process.env.APPDATA;
  return {
    root,
    trainer: process.env.MC_WAKETRAINER_CMD || path.join(root, 'train.ps1'),
    modelsDir: process.env.MC_WAKETRAINER_MODELS_DIR || path.join(root, 'models'),
    clipsDir: process.env.MC_WAKETRAINER_CLIPS_DIR || path.join(root, 'clips'),
    installDir: process.env.MC_BLITZVOICE_WAKE_DIR || (appdata ? path.join(appdata, 'com.blitzraw.voice', 'wake-models') : null),
  };
}

const logsDir = () => path.join(DATA_DIR, 'logs');
const stateFile = () => path.join(DATA_DIR, 'waketrain.json');
const pidFile = () => path.join(DATA_DIR, 'waketrain.pid');

// ---------- Validation ----------

const fail = (error, status = 400) => ({ ok: false, error, status });

// A phrase: 2 to 40 characters of letters, spaces and apostrophes. Returns the cleaned lower-case phrase or null.
export function cleanPhrase(v) {
  if (typeof v !== 'string') return null;
  // Only plain spaces count as spaces: a tab or a line break is refused below, not turned into a space.
  const s = v.replace(/[\u2018\u2019]/g, "'").replace(/ +/g, ' ').replace(/^ | $/g, '').toLowerCase();
  if (s.length < 2 || s.length > 40) return null;
  if (!/^[a-z' ]+$/.test(s)) return null;
  if ((s.match(/[a-z]/g) || []).length < 2) return null;
  return s;
}

// The file name stem for a phrase (the same rule as the trainer's own run names).
export function slugify(phrase) {
  return String(phrase).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export const isSlug = (s) => typeof s === 'string' && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(s) && s.length <= 60;
export const isClipName = (s) => typeof s === 'string' && /^clip-\d{1,5}\.wav$/.test(s);

// Checks the body of a training request. Returns { ok: true, value } or { ok: false, error, status }.
export function validateStart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Send an object with a phrase');
  const phrase = cleanPhrase(body.phrase);
  if (!phrase) return fail('The phrase must be 2 to 40 characters: letters, spaces and apostrophes');
  const slug = slugify(phrase);
  if (!isSlug(slug)) return fail('The phrase must contain letters');
  const preset = body.preset === undefined ? 'standard' : body.preset;
  if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) return fail('preset must be quick, standard or thorough');
  let steps = null;
  if (body.steps !== undefined && body.steps !== null) {
    if (!Number.isInteger(body.steps) || body.steps < 100 || body.steps > 200000) return fail('steps must be a whole number from 100 to 200000');
    steps = body.steps;
  }
  let raw = body.negatives === undefined || body.negatives === null ? [] : body.negatives;
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) return fail('negatives must be a list of phrases');
  const negatives = [];
  for (const item of raw) {
    if (typeof item === 'string' && !item.trim()) continue; // an empty entry from a trailing comma
    const n = cleanPhrase(item);
    if (!n) return fail('Each near-miss phrase must be 2 to 40 characters: letters, spaces and apostrophes');
    if (n !== phrase && !negatives.includes(n)) negatives.push(n);
  }
  if (negatives.length > MAX_NEGATIVES) return fail(`At most ${MAX_NEGATIVES} near-miss phrases`);
  return { ok: true, value: { phrase, slug, preset, steps, negatives } };
}

// ---------- The trainer's output ----------

// One line of the trainer's stdout. Returns { type: 'progress'|'done'|'error', ... } or null for anything else.
export function parseTrainLine(line) {
  const text = String(line).replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('{')) return null;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (typeof j.error === 'string') return { type: 'error', error: j.error.slice(0, 500) };
  if (j.done === true) {
    const seconds = Number(j.seconds);
    return { type: 'done', out: typeof j.out === 'string' ? j.out : '', seconds: Number.isFinite(seconds) ? seconds : null };
  }
  if (typeof j.stage === 'string' && STAGES.includes(j.stage)) {
    const pct = Number(j.pct);
    return {
      type: 'progress',
      stage: j.stage,
      pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
      msg: typeof j.msg === 'string' ? j.msg.slice(0, 300) : '',
    };
  }
  return null;
}

// Turns chunks of output into whole lines (a line can arrive in pieces, and Windows ends lines with CRLF).
export function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 65536) buf = ''; // a runaway line without a break is dropped
    },
    end() {
      if (buf.trim()) onLine(buf.replace(/\r$/, ''));
      buf = '';
    },
  };
}

// ---------- WAV clips ----------

// Checks a canonical 16kHz mono 16-bit PCM WAV: the whole file may be at most 64 bytes longer than a 44 byte header
// plus its audio. Returns { ok: true, seconds, dataOffset, dataLen } or { ok: false, error }.
export function parseWav(buf) {
  const bad = (error) => ({ ok: false, error });
  if (!Buffer.isBuffer(buf) || buf.length < 44) return bad('That is not a WAV file');
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return bad('That is not a WAV file');
  let pos = 12;
  let fmt = null;
  let dataLen = null;
  let dataOffset = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return bad('The WAV header is damaged');
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      dataLen = Math.min(size, buf.length - body);
      dataOffset = body;
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataLen === null) return bad('The WAV file has no audio');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return bad('The clip must be 16kHz mono 16-bit WAV');
  dataLen -= dataLen % 2;
  if (buf.length > 44 + dataLen + WAV_TRAILING_MAX) return bad('The WAV file has extra data after the audio');
  const seconds = dataLen / (16000 * 2);
  if (seconds < CLIP_MIN_SECONDS) return bad('The clip is too short');
  if (seconds > CLIP_MAX_SECONDS) return bad(`The clip is longer than ${CLIP_MAX_SECONDS}s`);
  return { ok: true, seconds, dataOffset, dataLen };
}

// A canonical 44 byte header followed by the audio only (nothing else from the upload is kept).
function canonicalWav(buf, wav) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + wav.dataLen, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(wav.dataLen, 40);
  return Buffer.concat([h, buf.subarray(wav.dataOffset, wav.dataOffset + wav.dataLen)]);
}

// Folders and bytes under the clips root (for the global caps).
function clipsUsage() {
  let folders = 0;
  let bytes = 0;
  const root = paths().clipsDir;
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { folders, bytes };
  }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    folders++;
    try {
      for (const f of fs.readdirSync(path.join(root, d.name))) {
        try {
          const st = fs.statSync(path.join(root, d.name, f));
          if (st.isFile()) bytes += st.size;
        } catch {
          // gone while counting
        }
      }
    } catch {
      // unreadable folder
    }
  }
  return { folders, bytes };
}

const clipDir = (slug) => path.join(paths().clipsDir, slug);

export function listClips(slug) {
  if (!isSlug(slug)) return [];
  let names;
  try {
    names = fs.readdirSync(clipDir(slug));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!isClipName(name)) continue;
    try {
      const st = fs.statSync(path.join(clipDir(slug), name));
      if (st.isFile()) out.push({ name, bytes: st.size, seconds: Math.round(Math.max(0, st.size - 44) / 320) / 100, n: Number(name.slice(5, -4)) });
    } catch {
      // gone while listing
    }
  }
  return out.sort((a, b) => a.n - b.n).map(({ n, ...rest }) => rest);
}

const clipsLocked = (slug) => state.running && state.slug === slug;

// Saves one clip as clip-<n>.wav. Resolves { status, body }.
export function saveClip(slug, buf) {
  if (!isSlug(slug)) return { status: 400, body: { error: 'Unknown phrase' } };
  if (clipsLocked(slug)) return { status: 409, body: { error: 'Training is using these clips right now' } };
  const wav = parseWav(buf);
  if (!wav.ok) return { status: 400, body: { error: wav.error } };
  const existing = listClips(slug);
  if (existing.length >= MAX_CLIPS) return { status: 409, body: { error: `At most ${MAX_CLIPS} clips per phrase` } };
  const out = canonicalWav(buf, wav);
  const dir = clipDir(slug);
  const use = clipsUsage();
  if (!fs.existsSync(dir) && use.folders >= MAX_CLIP_FOLDERS) {
    return { status: 413, body: { error: `At most ${MAX_CLIP_FOLDERS} phrases can keep voice clips. Delete the clips of another phrase first.` } };
  }
  if (use.bytes + out.length > MAX_CLIPS_TOTAL_BYTES) {
    return { status: 413, body: { error: `The saved voice clips are full (${Math.round(MAX_CLIPS_TOTAL_BYTES / 1048576)}MB). Delete some clips first.` } };
  }
  fs.mkdirSync(dir, { recursive: true });
  let n = existing.reduce((m, c) => Math.max(m, Number(c.name.slice(5, -4))), 0) + 1;
  for (let tries = 0; tries < 5; tries++, n++) {
    const name = `clip-${n}.wav`;
    try {
      fs.writeFileSync(path.join(dir, name), out, { flag: 'wx' });
      return { status: 200, body: { name, seconds: Math.round(wav.seconds * 100) / 100, clips: listClips(slug) } };
    } catch (err) {
      if (err.code !== 'EEXIST') return { status: 500, body: { error: 'The clip could not be saved' } };
    }
  }
  return { status: 500, body: { error: 'The clip could not be saved' } };
}

export function deleteClip(slug, name) {
  if (!isSlug(slug) || !isClipName(name)) return { status: 400, body: { error: 'Unknown clip' } };
  if (clipsLocked(slug)) return { status: 409, body: { error: 'Training is using these clips right now' } };
  try {
    fs.unlinkSync(path.join(clipDir(slug), name));
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 404, body: { error: 'Unknown clip' } };
    return { status: 500, body: { error: 'The clip could not be deleted' } };
  }
  return { status: 200, body: { ok: true, clips: listClips(slug) } };
}

// The full path of one clip for playback, or null.
export function clipFile(slug, name) {
  if (!isSlug(slug) || !isClipName(name)) return null;
  const file = path.join(clipDir(slug), name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

// ---------- The training job (one at a time) ----------

function blankState() {
  return {
    phase: 'idle', // idle | running | done | error | stopped | interrupted
    running: false,
    phrase: null,
    slug: null,
    preset: null,
    negatives: [],
    clips: 0,
    startedAt: null,
    finishedAt: null,
    stage: null,
    pct: 0,
    msg: '',
    stages: {},
    out: null,
    seconds: null,
    error: null,
    log: null,
  };
}

let state = loadSavedState();
let job = null; // { child (null when adopted after a restart), pid, stopping, log (write stream), killTimer, adopted }

function loadSavedState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (j && typeof j === 'object' && ['done', 'error', 'stopped', 'interrupted'].includes(j.phase)) return { ...blankState(), ...j, running: false };
  } catch {
    // no saved result yet
  }
  return blankState();
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // the page keeps working from memory
  }
}

// What the page gets: the state plus the elapsed seconds.
export function trainState() {
  const end = state.running ? Date.now() : state.finishedAt;
  const elapsed = state.startedAt && end ? Math.max(0, Math.round((end - state.startedAt) / 1000)) : 0;
  return { ...state, elapsed };
}

function announce(kind) {
  publish('waketrain', { kind, ...trainState() });
}

function logLine(text) {
  if (job && job.log) {
    try {
      job.log.write(`[${new Date().toTimeString().slice(0, 8)}] ${text}\n`);
    } catch {
      // the log is a convenience
    }
  }
}

function pruneLogs() {
  try {
    const files = fs.readdirSync(logsDir()).filter((f) => /^waketrain-.*\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOGS))) fs.unlinkSync(path.join(logsDir(), f));
  } catch {
    // nothing to prune
  }
}

function applyLine(line) {
  logLine(`out: ${line}`);
  const ev = parseTrainLine(line);
  if (!ev || !state.running) return;
  if (ev.type === 'progress') {
    const idx = STAGES.indexOf(ev.stage);
    for (const s of STAGES.slice(0, idx)) state.stages[s] = 100; // an earlier stage is finished once a later one reports
    state.stages[ev.stage] = ev.pct;
    state.stage = ev.stage;
    state.pct = ev.pct;
    state.msg = ev.msg;
    announce('progress');
  } else if (ev.type === 'done') {
    job.sawDone = ev;
  } else if (ev.type === 'error') {
    job.sawError = ev.error;
  }
}

function finish(code, signal) {
  if (!job) return;
  const j = job;
  clearTimeout(j.killTimer);
  clearInterval(j.watch);
  removePidFile();
  state.running = false;
  state.finishedAt = Date.now();
  const modelFile = path.join(paths().modelsDir, `${state.slug}.onnx`);
  // A Stop that arrives after the trainer already reported success keeps the result.
  if (j.sawDone && (code === 0 || j.stopping) && fs.existsSync(modelFile)) {
    state.phase = 'done';
    state.error = null;
    state.out = `${state.slug}.onnx`;
    state.seconds = j.sawDone.seconds;
    for (const s of STAGES) state.stages[s] = 100;
    state.pct = 100;
  } else if (j.stopping) {
    state.phase = 'stopped';
    state.error = null;
  } else if (j.sawError) {
    state.phase = 'error';
    state.error = j.sawError;
  } else if (j.adopted) {
    // Started before a restart: its output was not ours to read, so the model file is the only evidence.
    let fresh = false;
    try {
      fresh = fs.statSync(modelFile).mtimeMs >= (state.startedAt || 0);
    } catch {
      // no model
    }
    if (fresh) {
      state.phase = 'done';
      state.error = null;
      state.out = `${state.slug}.onnx`;
      state.seconds = Math.round((state.finishedAt - state.startedAt) / 1000);
      for (const s of STAGES) state.stages[s] = 100;
      state.pct = 100;
    } else {
      state.phase = 'interrupted';
      state.error = 'The trainer ended after Mission Control restarted, without a model.';
    }
  } else if (j.sawDone && code === 0) {
    state.phase = 'error';
    state.error = 'The trainer finished but the model file is missing';
  } else {
    state.phase = 'error';
    state.error = `The trainer stopped without a result (${signal || `exit code ${code}`}). See the log.`;
  }
  logLine(`finished: ${state.phase} (code ${code}${signal ? `, ${signal}` : ''})`);
  job = null;
  try {
    j.log && j.log.end();
  } catch {
    // ignore
  }
  saveState();
  announce(state.phase);
}

// The command and its argument array (never a command line string, never a shell).
function launchSpec(trainer, args) {
  const ext = path.extname(trainer).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return { file: process.execPath, args: [trainer, ...args] };
  if (ext === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', trainer, ...args] };
  }
  return null;
}

// ---------- A trainer that outlived the server ----------

function removePidFile() {
  try {
    fs.unlinkSync(pidFile());
  } catch {
    // none
  }
}

function writePidFile(rec) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(pidFile(), JSON.stringify(rec));
  } catch {
    // without it a hard kill of the server loses track of the trainer, nothing worse
  }
}

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// The command line of a process, or '' when it cannot be read.
function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      return String(r.stdout || '').trim();
    }
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return String(r.stdout || '').trim();
  } catch {
    return '';
  }
}

// True when the process is alive AND its command line names the trainer's folder (a reused pid is not ours).
function isOurTrainer(pid) {
  if (!isAlive(pid)) return false;
  const norm = (x) => String(x).replace(/\//g, '\\').toLowerCase();
  const folder = norm(path.dirname(paths().trainer)).replace(/\\+$/, '');
  return !!folder && norm(commandLineOf(pid)).includes(folder);
}

// Called when the server starts (and by tests): picks up a trainer a previous server left running, or records that
// it did not survive.
export function recoverTrainer() {
  if (job) return;
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
  } catch {
    return;
  }
  if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.pid)) {
    removePidFile();
    return;
  }
  const base = { ...blankState(), phrase: rec.phrase || null, slug: rec.slug || null, preset: rec.preset || null, negatives: Array.isArray(rec.negatives) ? rec.negatives : [], clips: rec.clips || 0, startedAt: rec.startedAt || null, log: rec.log || null };
  if (!isOurTrainer(rec.pid)) {
    state = { ...base, phase: 'interrupted', finishedAt: Date.now(), error: 'Mission Control restarted while this was training, and the trainer did not survive.' };
    removePidFile();
    saveState();
    return;
  }
  state = { ...base, phase: 'running', running: true, msg: 'running (started before a restart)' };
  job = { child: null, pid: rec.pid, stopping: false, log: null, killTimer: null, sawDone: null, sawError: null, adopted: true, watch: null };
  const mine = job;
  mine.watch = setInterval(() => {
    if (job === mine && !isAlive(mine.pid)) finish(null, null);
  }, 3000);
  mine.watch.unref();
}

// Starts a training. Resolves { status, body }.
export function startTraining(body) {
  const v = validateStart(body);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  if (state.running || job) return { status: 409, body: { error: 'busy', message: 'A training is already running', phrase: state.phrase } };
  const { phrase, slug, preset, steps, negatives } = v.value;
  const p = paths();
  if (!fs.existsSync(p.trainer)) return { status: 503, body: { error: 'trainer_missing', message: 'The trainer is not installed' } };
  const out = path.join(p.modelsDir, `${slug}.onnx`);
  const clips = listClips(slug);
  const args = ['--phrase', phrase, '--out', out, '--preset', preset];
  if (clips.length) args.push('--clips', clipDir(slug));
  if (negatives.length) args.push('--negatives', negatives.join(','));
  if (steps) args.push('--steps', String(steps));
  const spec = launchSpec(p.trainer, args);
  if (!spec) return { status: 500, body: { error: 'bad_trainer', message: 'The trainer must be a .ps1 script' } };
  try {
    fs.mkdirSync(p.modelsDir, { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
  } catch {
    return { status: 500, body: { error: 'The models folder could not be created' } };
  }
  const logName = `waketrain-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  const log = fs.createWriteStream(path.join(logsDir(), logName), { flags: 'a' });
  log.on('error', () => {});
  let child;
  try {
    child = spawn(spec.file, spec.args, { cwd: path.dirname(p.trainer), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  } catch (err) {
    log.end();
    return { status: 500, body: { error: `The trainer could not start: ${String(err.message).slice(0, 200)}` } };
  }
  state = { ...blankState(), phase: 'running', running: true, phrase, slug, preset, negatives, clips: clips.length, startedAt: Date.now(), log: logName, msg: 'Starting' };
  job = { child, pid: child.pid, stopping: false, log, killTimer: null, sawDone: null, sawError: null };
  writePidFile({ pid: child.pid, startedAt: state.startedAt, out, phrase, slug, preset, negatives, clips: clips.length, log: logName });
  const mine = job;
  logLine(`start: pid ${child.pid}, preset ${preset}, ${clips.length} clips, ${negatives.length} near-miss phrases`);
  logLine(`command: ${[spec.file, ...spec.args].join(' ')}`);
  const out1 = lineSplitter(applyLine);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => out1.push(c));
  child.stdout.on('end', () => out1.end());
  const err1 = lineSplitter((l) => logLine(`err: ${l}`));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => err1.push(c));
  child.stderr.on('end', () => err1.end());
  child.on('error', (err) => {
    if (job !== mine) return;
    mine.sawError = `The trainer could not start: ${String(err.message).slice(0, 200)}`;
    finish(null, null);
  });
  child.on('close', (code, signal) => {
    if (job === mine) finish(code, signal);
  });
  pruneLogs();
  announce('started');
  return { status: 200, body: trainState() };
}

// Kills the process tree of the trainer we started, by its exact pid. Never by name.
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const t = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    t.on('error', () => {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    });
  } else {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}

export function stopTraining() {
  if (!state.running || !job) return { status: 409, body: { error: 'idle', message: 'No training is running' } };
  if (job.stopping) return { status: 200, body: trainState() };
  job.stopping = true;
  logLine(`stop requested for pid ${job.pid}`);
  const mine = job;
  killTree(mine.pid);
  // If the close event never comes, do not leave the page waiting.
  mine.killTimer = setTimeout(() => {
    if (job === mine) finish(null, 'killed');
  }, 8000);
  mine.killTimer.unref();
  state.msg = 'Stopping';
  announce('progress');
  return { status: 200, body: trainState() };
}

// A training must not outlive the dashboard: its output pipe would break and the run would be lost anyway.
process.on('exit', () => {
  if (job) removePidFile(); // a normal exit stops the trainer below; only a hard kill leaves the file behind
  if (job && Number.isInteger(job.pid) && process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch {
      // nothing more to do
    }
  }
});

// ---------- Models ----------

// "hey_mission_control" -> "Hey Mission Control" (the same rule BlitzVoice uses).
export function phraseOf(id) {
  return String(id)
    .replace(/_v\d+(\.\d+)*$/i, '')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const isModelId = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(s) && !s.includes('..');

function onnxStems(dir) {
  const out = new Map();
  if (!dir) return out;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.onnx')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.set(name.slice(0, -5), { bytes: st.size, modifiedAt: st.mtimeMs });
    } catch {
      // gone while listing
    }
  }
  return out;
}

// One list: every trained model, every installed model and BlitzVoice's own, with which one is in use.
export function listModels() {
  const p = paths();
  const trained = onnxStems(p.modelsDir);
  const installed = onnxStems(p.installDir);
  const ws = wakeStatus();
  const wake = ws.available ? ws.wake : null;
  const selected = wake && typeof wake.model === 'string' ? wake.model : null;
  const bundled = new Set(wake ? wake.models.filter((m) => m.bundled).map((m) => m.id) : []);
  const ids = new Set([...trained.keys(), ...installed.keys(), ...bundled]);
  if (selected) ids.add(selected);
  const models = [...ids].map((id) => {
    const t = trained.get(id);
    const i = installed.get(id);
    return {
      id,
      phrase: phraseOf(id),
      trained: !!t,
      installed: !!i || bundled.has(id),
      bundled: bundled.has(id),
      // The trained file is newer than the installed copy (a retrain): installing again updates BlitzVoice.
      stale: !!t && !!i && t.modifiedAt > i.modifiedAt,
      selected: id === selected,
      bytes: (t || i || {}).bytes || null,
      modifiedAt: (t || i || {}).modifiedAt || null,
      clips: isSlug(id) ? listClips(id).length : 0,
    };
  });
  models.sort((a, b) => Number(b.selected) - Number(a.selected) || Number(a.bundled) - Number(b.bundled) || (b.modifiedAt || 0) - (a.modifiedAt || 0) || a.id.localeCompare(b.id));
  return { linked: ws.available, selected, canInstall: !!p.installDir, models };
}

// Copies a trained model into BlitzVoice's folder and, when BlitzVoice is linked, makes it the one in use.
// `model` is the file stem of a model in the trained folder. Resolves { status, body }.
export async function installModel(model) {
  if (!isModelId(model)) return { status: 400, body: { error: 'model must be the name of a trained model' } };
  const p = paths();
  if (!p.installDir) return { status: 503, body: { error: 'The BlitzVoice folder is unknown' } };
  // Only a file that really sits in the trained folder counts; the name is matched against that folder's own listing.
  const known = onnxStems(p.modelsDir);
  if (!known.has(model)) return { status: 404, body: { error: 'That model is not in the trained folder' } };
  const id = slugify(model);
  if (!isSlug(id)) return { status: 400, body: { error: 'model must be the name of a trained model' } };
  const from = path.join(p.modelsDir, `${model}.onnx`);
  const to = path.join(p.installDir, `${id}.onnx`);
  const tmp = `${to}.part`;
  try {
    fs.mkdirSync(p.installDir, { recursive: true });
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, to); // BlitzVoice never sees half a file
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    return { status: 500, body: { error: `The model could not be copied: ${String(err.code || err.message).slice(0, 80)}` } };
  }
  const result = { ok: true, id, phrase: phraseOf(id), selected: false, reason: null };
  const ws = wakeStatus();
  if (!ws.available) {
    result.reason = 'not_linked';
    return { status: 200, body: result };
  }
  // BlitzVoice rescans its folder whenever it answers a wake change, but Mission Control checks a model id against
  // the list it saw last. Re-sending the current on/off value is a no-op that brings that list up to date.
  if (ws.wake && typeof ws.wake.enabled === 'boolean') await setWakeSettings({ enabled: ws.wake.enabled });
  const r = await setWakeSettings({ model: id });
  if (r.status === 200) result.selected = true;
  else result.reason = 'not_accepted';
  return { status: 200, body: result };
}

recoverTrainer();

export function overview() {
  return { presets: PRESETS, stages: STAGES, clipTarget: CLIP_TARGET, maxNegatives: MAX_NEGATIVES, state: trainState() };
}

// For tests: forget the saved result and the in-memory state (never touches a running job).
export function resetStateForTests() {
  if (job) return false;
  state = blankState();
  try {
    fs.unlinkSync(stateFile());
  } catch {
    // none saved
  }
  return true;
}
