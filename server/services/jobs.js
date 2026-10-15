// Project jobs: scan a project folder for scripts, run the tracked ones, keep their logs and history.
// A captured job runs with its output streamed to SSE `job` events and a log file. An interactive job opens
// its own console window instead. Nothing here builds a shell string from request text: the script comes from
// the catalog, is checked by resolveScript(), and the only request text used is the typed confirmation name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { run } from '../lib/run.js';
import { readJson } from '../lib/jsonStore.js';
import { getProject, isSafeId, resolveScript, loadCatalog } from './catalog.js';
import { clearCache, fixOf } from './projects.js';

// ---- Check fixes: a build check's own build step, run as a job with the id "check-<key>" ----

const ARG_RE = /^[A-Za-z0-9._=-]{1,40}$/;

// The script and its arguments come only from the catalog check. A script may live in another project's folder
// (one project's installer may be built by a script in another project), but it must sit inside some catalog project folder.
function checkJob(project, key) {
  const def = (project.checks || []).find((d) => d.key === key);
  const fix = fixOf(project, key);
  if (!def || !fix) return null;
  const runPath = def.build.run.trim();
  const args = (typeof def.build.args === 'string' ? def.build.args.trim() : '').split(/\s+/).filter(Boolean);
  if (args.length > 6 || args.some((a) => !ARG_RE.test(a))) return { error: 'The check has build arguments that are not safe to pass' };
  let root = project.folder;
  let rel = runPath;
  if (/^[A-Za-z]:[\\/]/.test(runPath)) {
    const abs = path.resolve(runPath).toLowerCase();
    const owner = loadCatalog()
      .filter((p) => typeof p.folder === 'string')
      .map((p) => path.resolve(p.folder))
      .filter((f) => abs.startsWith(f.toLowerCase() + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) return { error: 'The build script is not inside a project folder' };
    root = owner;
    rel = path.relative(owner, path.resolve(runPath));
  }
  return { id: `check-${key}`, label: fix.label, kind: 'check', outward: fix.outward, interactive: fix.interactive, root, file: rel, args };
}

// The same list as OUTWARD_KINDS in app\project.html: kinds of job that send something off the PC.
const OUTWARD_KINDS = new Set(['push-github', 'publish-website', 'release', 'deploy', 'sync']);

const MAX_CAPTURED = 3;
const WINDOW_GUARD_MS = 4000;
const windowOpened = new Map(); // "project/job" -> time a window was last opened
const MAX_FINISHED = 50;
const KEEP_LOGS = 20;
const FLUSH_MS = 200;
const MAX_LIVE_LINES = 500; // per flush; the rest is only in the log
const MAX_LINE = 4000;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_ROOT = path.join(DATA_DIR, 'logs');
const HISTORY_FILE = path.join(DATA_DIR, 'jobs-history.json');

function fail(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

// ---- Scripts in a folder ----

const SCAN_SKIP = new Set(['node_modules', 'target', '.git', 'dist', 'build', 'out', 'research', '.godot']);
const SCAN_DEPTH = 3;
const MAX_SCRIPTS = 300;
const SCRIPTS_TTL_MS = 30000;
const scriptsCache = new Map(); // projectId -> { at, files: [{file, interactiveGuess}] }

export function clearScriptsCache(id) {
  if (id) scriptsCache.delete(id);
  else scriptsCache.clear();
}

// A script that waits for a key or a typed answer cannot run with its output captured.
function guessInteractive(full) {
  let text = '';
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return /^\s*@?pause\b/im.test(text) || /\bset\s+\/p\b/i.test(text) || /\bRead-Host\b/i.test(text) || /\bchoice(\.exe)?\s/i.test(text);
}

function scanScripts(folder) {
  const files = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= MAX_SCRIPTS) return;
      const relPath = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isDirectory()) {
        const low = e.name.toLowerCase();
        if (depth >= SCAN_DEPTH || SCAN_SKIP.has(low)) continue;
        if (`${relPath}`.toLowerCase().replace(/\\/g, '/').endsWith('src-tauri/gen')) continue;
        walk(path.join(dir, e.name), relPath, depth + 1);
      } else if (e.isFile() && /\.(bat|cmd|ps1)$/i.test(e.name)) {
        files.push({ file: relPath, interactiveGuess: guessInteractive(path.join(dir, e.name)) });
      }
    }
  };
  walk(folder, '', 0);
  return files;
}

export function listScripts(project) {
  let hit = scriptsCache.get(project.id);
  if (!hit || Date.now() - hit.at > SCRIPTS_TTL_MS) {
    hit = { at: Date.now(), files: scanScripts(project.folder) };
    scriptsCache.set(project.id, hit);
  }
  const jobs = project.jobs || [];
  const tracked = new Set(jobs.filter((j) => j.file).map((j) => j.file.replace(/\//g, '\\').toLowerCase()));
  const list = hit.files.map((f) => ({ file: f.file, tracked: tracked.has(f.file.toLowerCase()), interactiveGuess: f.interactiveGuess }));
  // Built-in jobs have no file. Offer them as pseudo entries (builtin is set, file holds the display name).
  if (isRepo(project.folder)) {
    list.unshift({ file: 'Git push (built in)', builtin: 'git-push', tracked: jobs.some((j) => j.builtin === 'git-push'), interactiveGuess: false });
  }
  return list;
}

function isRepo(folder) {
  try {
    return fs.existsSync(path.join(folder, '.git'));
  } catch {
    return false;
  }
}

// ---- Built-in git push ----

// Reads `git status --porcelain=v2 --branch`.
export async function pushState(folder) {
  const r = await run('git', ['--no-optional-locks', '-C', folder, 'status', '--porcelain=v2', '--branch'], { cwd: folder, timeoutMs: 20000 });
  if (r.code !== 0) {
    throw fail(409, `Could not read the git status: ${(r.stderr || '').trim().slice(0, 200) || 'git failed'}`, { blocked: true, reason: 'git-failed' });
  }
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        st.ahead = Number(m[1]);
        st.behind = Number(m[2]);
      }
    } else if (/^[12u] /.test(line)) st.dirty++; // changed tracked files; untracked files are not pushed, so they do not block
  }
  return st;
}

// Refuses (409 with blocked: true and a reason) unless there is a branch, an upstream, a clean tracked tree and something to push.
async function checkPush(folder) {
  const st = await pushState(folder);
  const info = { branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind };
  if (!st.branch || st.branch === '(detached)') {
    throw fail(409, 'The repository is not on a branch (detached HEAD), so there is nothing to push.', { blocked: true, reason: 'detached', ...info });
  }
  if (!st.upstream) {
    throw fail(409, `The branch ${st.branch} has no upstream, so git push has nowhere to send it. Set one first (git push -u).`, { blocked: true, reason: 'no-upstream', ...info });
  }
  if (st.dirty > 0) {
    const files = st.dirty === 1 ? '1 tracked file has' : `${st.dirty} tracked files have`;
    throw fail(409, `${files} uncommitted changes. Commit them first so you know what goes out.`, { blocked: true, reason: 'dirty', dirty: st.dirty, ...info });
  }
  if (st.ahead === 0) {
    throw fail(409, `Nothing to push: ${st.branch} is up to date with ${st.upstream}.`, { blocked: true, reason: 'nothing-to-push', ...info });
  }
  return info;
}

// ---- Command lines ----

// Windows console titles keep letters, digits and a few marks. Anything else would be read by cmd.exe.
function safeTitle(label) {
  return `${String(label).replace(/[^\p{L}\p{N} ._()-]/gu, ' ').replace(/\s+/g, ' ').trim() || 'Job'} (Mission Control)`;
}

// What to spawn for a job. mode "captured": output piped back. mode "window": a new visible console.
// `abs` and `cwd` must already have passed resolveScript() (no quote, percent, caret, ampersand, pipe, angle bracket).
// `args` (check build arguments) are plain tokens already checked against ARG_RE, so they are safe on a cmd line.
export function buildCommand({ mode, label, abs, cwd, builtin, args = [] }) {
  const tail = args.length ? ' ' + args.join(' ') : '';
  if (builtin === 'git-push') {
    // No other arguments: never --force, never a refspec. Prompts are off so a missing credential fails instead of hanging.
    return {
      file: 'git',
      args: ['-C', cwd, 'push'],
      options: { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    };
  }
  const ps = /\.ps1$/i.test(abs);
  if (mode === 'window') {
    // The new console's cmd.exe strips the first and last quote after /k when the line has two quotes and a special
    // character (parentheses, @, ...) sits between them, which breaks the path. Starting the command with a word
    // (`call`) means the first character after /k is not a quote, so cmd leaves the quotes alone.
    const run = (ps ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${abs}"` : `call "${abs}"`) + tail;
    return {
      file: 'cmd.exe',
      args: [`/d /c start "${safeTitle(label)}" /d "${cwd}" cmd.exe /k ${run}`],
      options: { cwd, windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false, shell: false },
    };
  }
  if (ps) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', abs, ...args],
      options: { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
    };
  }
  // The extra pair of quotes survives cmd's /s rule (it strips the first and last quote), so paths with spaces work.
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `""${abs}"${tail}"`],
    options: { cwd, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false },
  };
}

// ---- Run records and history ----

const runs = new Map(); // runId -> record
const children = new Map(); // runId -> ChildProcess

function publicRun(r) {
  return {
    runId: r.runId,
    projectId: r.projectId,
    jobId: r.jobId,
    label: r.label,
    mode: r.mode,
    state: r.state,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    code: r.code,
    durationMs: r.durationMs,
    hasLog: !!r.logFile,
    ...(r.note ? { note: r.note } : {}),
  };
}

// A file that could not be read at start is read again before the next save, and nothing is saved until it could be:
// the history on disk is never replaced by only the runs of this session (jsonStore.js). A run already known here wins.
let historyRead = false;
function loadHistory() {
  const r = readJson(HISTORY_FILE, 'jobs');
  if (!r.ok) return;
  historyRead = true;
  const parsed = r.value;
  for (const x of Array.isArray(parsed && parsed.runs) ? parsed.runs : []) {
    if (!x || typeof x.runId !== 'string' || !isSafeId(x.projectId) || !isSafeId(x.jobId) || runs.has(x.runId)) continue;
    // A run that was alive when the server went down is over now.
    runs.set(x.runId, { ...x, state: x.state === 'running' ? 'stopped' : x.state, endedAt: x.endedAt || x.startedAt });
  }
}

function saveHistory() {
  if (!historyRead) loadHistory();
  if (!historyRead) return;
  const finished = [...runs.values()].filter((r) => r.state !== 'running').sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  for (const r of finished.slice(MAX_FINISHED)) runs.delete(r.runId);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ runs: finished.slice(0, MAX_FINISHED) }, null, 2));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    console.error('[jobs] could not save the history:', err.message);
  }
}

export function listRuns() {
  const all = [...runs.values()];
  const running = all.filter((r) => r.state === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const done = all.filter((r) => r.state !== 'running').sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, MAX_FINISHED);
  return [...running, ...done].map(publicRun);
}

// ---- Log files ----

const LOG_NAME = /^[A-Za-z0-9_-]+-\d{8}-\d{6}(-\d+)?\.log$/;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Opens a new log file for a run. Folder and file names come only from validated ids and the clock.
function openLog(projectId, jobId) {
  const dir = path.join(LOG_ROOT, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${jobId}-${stamp(new Date())}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${base}.log` : `${base}-${n}.log`;
    try {
      const fd = fs.openSync(path.join(dir, name), 'wx');
      return { fd, rel: `${projectId}/${name}` };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not create a log file');
}

function pruneLogs(projectId, jobId, keepRel) {
  const dir = path.join(LOG_ROOT, projectId);
  try {
    const mine = fs.readdirSync(dir).filter((n) => LOG_NAME.test(n) && n.startsWith(`${jobId}-`) && /^\d{8}-\d{6}/.test(n.slice(jobId.length + 1)));
    mine.sort().reverse();
    for (const n of mine.slice(KEEP_LOGS)) {
      if (`${projectId}/${n}` === keepRel) continue;
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch {
        // already gone
      }
    }
  } catch {
    // no log folder yet
  }
}

// Last `tail` lines of a run's log, or null when the run or its file is unknown.
export function readLog(runId, tail = 400) {
  const rec = runs.get(runId);
  if (!rec || !rec.logFile) return null;
  const m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+-\d{8}-\d{6}(?:-\d+)?\.log)$/.exec(rec.logFile);
  if (!m) return null;
  const full = path.resolve(LOG_ROOT, m[1], m[2]);
  if (!full.startsWith(LOG_ROOT + path.sep)) return null;
  let text;
  let cut = false;
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - MAX_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      cut = start > 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (cut) lines.shift(); // the first line may be partial
  const truncated = cut || lines.length > tail;
  if (lines.length > tail) lines = lines.slice(-tail);
  return { runId, state: rec.state, lines, truncated };
}

// ---- Output decoding ----

// cargo, npm, git and node print UTF-8. Windows PowerShell 5.1 and cmd built-ins print in the console (OEM) code
// page instead (850 on a French system, 932 on a Japanese one). Forcing the console to UTF-8 (chcp 65001) would
// also change how cmd reads non-ASCII bytes in the user's own scripts, so nothing is forced. Instead each line
// is decoded as strict UTF-8 and, only when that fails, with the OEM code page.
const OEM_TABLES = {
  437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
  850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
};
const OEM_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 866: 'ibm866' };
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let oemDecoder = null; // (Buffer) => string, set once the console code page is known

function setOemCodePage(cp) {
  if (OEM_TABLES[cp]) {
    const table = OEM_TABLES[cp];
    oemDecoder = (buf) => {
      let s = '';
      for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
      return s;
    };
  } else if (OEM_LABELS[cp]) {
    try {
      const td = new TextDecoder(OEM_LABELS[cp]);
      oemDecoder = (buf) => td.decode(buf);
    } catch {
      oemDecoder = null;
    }
  }
}

// The OEM code page from the registry, read once in the background (a missing answer just leaves the UTF-8 fallback).
execFile('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { windowsHide: true, timeout: 5000 }, (err, out) => {
  const m = !err && /OEMCP\s+REG_SZ\s+(\d+)/.exec(String(out));
  if (m) setOemCodePage(Number(m[1]));
});

export function decodeLine(buf) {
  try {
    return utf8Strict.decode(buf);
  } catch {
    return oemDecoder ? oemDecoder(buf) : buf.toString('utf8');
  }
}

// ---- Commit (local only: stage everything and commit with the user's message; never pushes) ----

export async function commitAll(projectId, message) {
  const project = typeof projectId === 'string' ? getProject(projectId) : null;
  if (!project) throw fail(404, 'Unknown project');
  const msg = typeof message === 'string' ? message.replace(/\r\n/g, '\n').trim() : '';
  if (!msg) throw fail(400, 'Write a commit message first');
  if (msg.length > 2000 || /\u0000/.test(msg)) throw fail(400, 'The commit message is too long or has a character git cannot take');
  if (!isRepo(project.folder)) throw fail(400, 'This folder is not a git repository');
  const cwd = path.resolve(project.folder);
  const add = await run('git', ['-C', cwd, 'add', '-A'], { timeoutMs: 60000 });
  if (add.code !== 0) throw fail(500, 'git add failed: ' + (add.stderr || add.stdout).trim().split('\n').slice(-1)[0]);
  const c = await run('git', ['-C', cwd, 'commit', '-m', msg], { timeoutMs: 60000 });
  if (c.code !== 0) {
    const out = (c.stdout + '\n' + c.stderr).trim();
    if (/nothing to commit/i.test(out)) throw fail(409, 'Nothing to commit');
    throw fail(500, 'git commit failed: ' + out.split('\n').slice(-1)[0]);
  }
  clearCache();
  publish('projects.changed', {});
  return { ok: true, summary: c.stdout.trim().split('\n')[0] };
}

// ---- Starting a job ----

// `remote` is true when the request came from a paired phone: jobs that send something off the PC stay at the PC.
export async function startJob({ projectId, jobId, confirm, remote = false } = {}) {
  const project = typeof projectId === 'string' ? getProject(projectId) : null;
  if (!project) throw fail(404, 'Unknown project');
  let job = typeof jobId === 'string' ? (project.jobs || []).find((j) => j.id === jobId) : null;
  if (!job && typeof jobId === 'string' && /^check-[A-Za-z0-9_-]{1,40}$/.test(jobId)) {
    job = checkJob(project, jobId.slice(6));
    if (job && job.error) throw fail(400, job.error);
  }
  if (!job) throw fail(404, 'Unknown job');
  // Checked before anything runs (the push check below talks to git), and before the typed confirmation, which a phone cannot satisfy.
  if (remote && (job.outward || job.builtin === 'git-push' || OUTWARD_KINDS.has(job.kind))) throw fail(403, 'pc_only');
  if (!isSafeId(project.id) || !isSafeId(job.id)) throw fail(400, 'This project or job id cannot be used for a run');
  if (!fs.existsSync(project.folder)) throw fail(400, 'The project folder does not exist');
  let script = null;
  let cwd;
  let push = null;
  if (job.builtin) {
    if (job.builtin !== 'git-push') throw fail(400, 'Unknown built-in job');
    if (!/^[A-Za-z]:\\/.test(project.folder) || /["%^&|<>\u0000-\u001f]/.test(project.folder)) {
      throw fail(400, 'The project folder cannot be used for a push');
    }
    if (!isRepo(project.folder)) throw fail(400, 'The project folder is not a git repository');
    cwd = path.resolve(project.folder);
    push = await checkPush(cwd);
  } else {
    script = resolveScript(job.root || project.folder, job.file);
    if (script.error) throw fail(400, `The script ${job.file} cannot be run: ${script.error}`);
    cwd = path.dirname(script.abs);
    if (job.interactive == null) job = { ...job, interactive: guessInteractive(script.abs) };
    if (/["%^&|<>\u0000-\u001f]/.test(cwd)) throw fail(400, 'The script folder has a character that is not safe to run');
  }

  if (job.outward && confirm !== project.name) {
    throw fail(409, 'This job sends something off this PC. Type the project name to confirm.', {
      needsConfirm: true,
      confirmName: project.name,
      ...(push ? { push } : {}),
    });
  }

  // Check and register with no await in between, so two quick requests cannot both pass.
  const mode = job.interactive && !job.builtin ? 'window' : 'captured';
  if (mode === 'captured') {
    for (const r of runs.values()) {
      if (r.state === 'running' && r.projectId === project.id && r.jobId === job.id) {
        throw fail(409, 'This job is already running', { runId: r.runId });
      }
    }
    const active = [...runs.values()].filter((r) => r.state === 'running').length;
    if (active >= MAX_CAPTURED) throw fail(429, `Too many jobs running at once (limit ${MAX_CAPTURED})`);
  }

  if (mode === 'window') {
    // A window cannot be tracked, so a double click would open two consoles running the same script.
    const key = `${project.id}/${job.id}`;
    const last = windowOpened.get(key);
    if (last && Date.now() - last < WINDOW_GUARD_MS) throw fail(409, 'A window for this job was just opened');
    windowOpened.set(key, Date.now());
  }

  const rec = {
    runId: crypto.randomUUID(),
    projectId: project.id,
    jobId: job.id,
    label: job.label,
    mode,
    state: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    code: null,
    durationMs: null,
    logFile: null,
    stopRequested: false,
  };

  if (mode === 'window') {
    const cmd = buildCommand({ mode, label: job.label, abs: script.abs, cwd, args: job.args || [] });
    try {
      await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(cmd.file, cmd.args, cmd.options);
        } catch (err) {
          return reject(fail(500, `Could not open a window: ${err.message}`));
        }
        child.once('error', (err) => reject(fail(500, `Could not open a window: ${err.message}`)));
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    } catch (err) {
      windowOpened.delete(`${project.id}/${job.id}`); // nothing opened, so a retry is allowed
      throw err;
    }
    rec.state = 'window';
    rec.endedAt = rec.startedAt;
    rec.note = 'opened in a window';
    runs.set(rec.runId, rec);
    saveHistory();
    return { runId: rec.runId, mode: 'window' };
  }

  const cmd = buildCommand({ mode, label: job.label, abs: script && script.abs, cwd, builtin: job.builtin, args: job.args || [] });
  const log = openLog(project.id, job.id);
  rec.logFile = log.rel;
  runs.set(rec.runId, rec);
  try {
    launch(rec, cmd, log.fd);
  } catch (err) {
    runs.delete(rec.runId);
    try {
      fs.closeSync(log.fd);
    } catch {
      // closed
    }
    throw fail(500, `Could not start the job: ${err.message}`);
  }
  pruneLogs(project.id, job.id, log.rel);
  return { runId: rec.runId, mode: 'captured', projectId: rec.projectId, jobId: rec.jobId, startedAt: rec.startedAt };
}

function launch(rec, cmd, fd) {
  const child = spawn(cmd.file, cmd.args, cmd.options);
  children.set(rec.runId, child);

  const pending = [];
  let logBytes = 0;
  let logFull = false;
  const base = { projectId: rec.projectId, jobId: rec.jobId, runId: rec.runId };

  const flush = () => {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    if (!logFull) {
      const text = batch.map((b) => b.line).join('\n') + '\n';
      logBytes += Buffer.byteLength(text);
      try {
        fs.writeSync(fd, logBytes > MAX_LOG_BYTES ? '... log limit reached, output stops here\n' : text);
      } catch {
        // log is best effort
      }
      if (logBytes > MAX_LOG_BYTES) logFull = true;
    }
    for (const b of batch.slice(0, MAX_LIVE_LINES)) publish('job', { ...base, stream: b.stream, line: b.line });
    if (batch.length > MAX_LIVE_LINES) {
      publish('job', { ...base, stream: 'err', line: `... ${batch.length - MAX_LIVE_LINES} more lines not shown live, see the log` });
    }
  };
  const timer = setInterval(flush, FLUSH_MS);
  timer.unref();

  // Lines are cut on the raw bytes and decoded one by one (see decodeLine), so a tool that prints in the
  // console code page does not turn the rest of the output into garbage.
  const drains = [];
  const attach = (stream, name) => {
    let carry = Buffer.alloc(0);
    const push = (buf) => {
      if (buf.length && buf[buf.length - 1] === 0x0d) buf = buf.subarray(0, buf.length - 1);
      const line = decodeLine(buf);
      pending.push({ stream: name, line: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} ...` : line });
    };
    stream.on('data', (chunk) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let i;
      while ((i = carry.indexOf(0x0a)) >= 0) {
        push(carry.subarray(0, i));
        carry = carry.subarray(i + 1);
      }
      if (carry.length > MAX_LINE * 4) {
        // A line this long is cut here; the bytes are kept whole, so no character is split in two.
        let cut = MAX_LINE * 4;
        while (cut > 0 && (carry[cut] & 0xc0) === 0x80) cut--;
        push(carry.subarray(0, cut || MAX_LINE * 4));
        carry = carry.subarray(cut || MAX_LINE * 4);
      }
    });
    const drain = () => {
      if (carry.length) push(carry);
      carry = Buffer.alloc(0);
    };
    drains.push(drain);
    stream.on('end', drain);
  };
  attach(child.stdout, 'out');
  attach(child.stderr, 'err');

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    // Last partial lines first, then close the pipes (a background helper may still hold them open).
    for (const d of drains) d();
    for (const s of [child.stdout, child.stderr]) {
      try {
        s.destroy();
      } catch {
        // already closed
      }
    }
    flush();
    try {
      fs.closeSync(fd);
    } catch {
      // closed
    }
    children.delete(rec.runId);
    rec.endedAt = new Date().toISOString();
    rec.durationMs = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
    rec.code = code;
    rec.state = rec.stopRequested ? 'stopped' : code === 0 ? 'done' : 'failed';
    publish('job', { ...base, done: true, code, durationMs: rec.durationMs, state: rec.state });
    saveHistory();
    // The job probably changed files the status checks look at.
    clearCache();
    publish('projects.changed', {});
    if (rec.onEnd) rec.onEnd();
  };

  child.on('error', (err) => {
    pending.push({ stream: 'err', line: `Could not run the script: ${err.message}` });
    finish(-1);
  });
  // A helper left running in the background can hold the pipes open after the script itself has ended.
  child.on('exit', (code) => {
    setTimeout(() => finish(code === null ? -1 : code), 1500).unref();
  });
  child.on('close', (code) => finish(code === null ? -1 : code));
}

// ---- Stopping ----

export async function stopJob(runId) {
  const rec = runs.get(runId);
  if (!rec) throw fail(404, 'Unknown run');
  if (rec.mode === 'window') throw fail(409, 'This job runs in its own window. Close that window to stop it.');
  if (rec.state !== 'running') throw fail(409, 'Run is not running');
  rec.stopRequested = true;
  const child = children.get(runId);
  if (!child || !child.pid) return publicRun(rec);
  const ended = new Promise((resolve) => {
    const prev = rec.onEnd; // a second stop request must not strand the first
    rec.onEnd = () => {
      if (prev) prev();
      resolve();
    };
    setTimeout(resolve, 5000).unref();
  });
  // A script can start a new child while the first sweep runs, so the sweep is repeated until the run has ended.
  const sweep = (n) => {
    if (rec.state !== 'running' || n > 3) return;
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, (err, out, errOut) => {
      if (err && !/not found|no running instance/i.test(String(errOut))) console.error(`[jobs] taskkill for run ${runId} (attempt ${n}):`, String(errOut || err.message).trim().slice(0, 300));
    });
    setTimeout(() => sweep(n + 1), 1500).unref();
  };
  sweep(1);
  await ended;
  return publicRun(rec);
}

// Do not leave job processes behind when the dashboard server ends.
function killAll() {
  for (const child of children.values()) {
    if (!child.pid) continue;
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}
process.on('exit', killAll);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
process.on('SIGHUP', () => process.exit(129)); // console window closed
process.on('SIGBREAK', () => process.exit(131)); // Ctrl+Break

loadHistory();
