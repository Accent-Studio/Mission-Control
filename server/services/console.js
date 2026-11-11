// The Console module's terminals: one shell process per console panel, its output kept here and streamed to the page,
// and each line the user types sent to it. PowerShell on Windows (PowerShell 7 when it is installed, else Windows
// PowerShell), zsh on a Mac. No pseudo terminal (no npm packages): the shell reads its commands from a pipe, so a program
// that wants a real terminal (a full-screen editor, a password prompt) does not work in it, and the Ctrl+C key does not
// reach it. "Stop" does what Ctrl+C would (stopConsole): it interrupts the processes the running command started and keeps
// the shell. "Restart" ends the shell with everything it started and opens a new one in the same folder.
//
// Each command the user sends ends with a marker (\x1e MCDONE <folder>, consoleShell().wrap): it says the command is over
// and in which folder the shell is now. The marker is taken out of the output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { getProcesses } from './system.js';

const MAX_CONSOLES = 8;
const MAX_KEEP = 256 * 1024; // characters of output kept per console (the oldest go first)
const MAX_LINE = 32 * 1024; // what is typed or pasted in at once
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const MARK = '\x1eMCDONE ';

export const isConsoleId = (id) => typeof id === 'string' && ID.test(id);

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return null;
}

let shellCache = null;
// Which shell a console runs. MC_CONSOLE_SHELL overrides the program (tests); its kind follows from its name.
export function consoleShell() {
  if (shellCache) return shellCache;
  let exe = process.env.MC_CONSOLE_SHELL || '';
  if (!exe) {
    if (process.platform === 'win32') {
      const seven = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
      exe = onPath('pwsh.exe') || (fs.existsSync(seven) ? seven : 'powershell.exe');
    } else {
      exe = fs.existsSync('/bin/zsh') ? '/bin/zsh' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    }
  }
  const base = path.basename(exe).toLowerCase().replace(/\.exe$/, '');
  const psMark = "[Console]::Out.Write([string][char]30 + 'MCDONE ' + $PWD.Path + [string][char]10); [Console]::Out.Flush()";
  const shMark = "printf '\\036MCDONE %s\\n' \"$PWD\"";
  const ps = base === 'pwsh' || base === 'powershell';
  shellCache = {
    exe,
    kind: ps ? 'powershell' : base,
    name: base === 'pwsh' ? 'PowerShell 7' : base === 'powershell' ? 'Windows PowerShell' : base,
    prompt: ps ? 'PS>' : base === 'zsh' ? '%' : '$',
    // PowerShell: the profile is not loaded (a profile that draws a fancy prompt or waits for keys misbehaves without a
    // terminal); commands come from the pipe, one line at a time. zsh: a login shell, so PATH is the one from .zprofile.
    args: ps ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] : base === 'zsh' || base === 'bash' ? ['-l', '-s'] : ['-s'],
    // The line that prints the marker, and the first lines a new shell runs (UTF-8 out, no progress bars).
    mark: ps ? psMark : shMark,
    // One command and its marker as one line: the shell reads all of it before it runs anything, so a command that reads
    // its input (zsh's read) never swallows the marker, and an error in the command (PowerShell: even a syntax error,
    // since Invoke-Expression parses at run time) still ends with the marker. The command runs in the shell's own scope,
    // so cd and variables stay.
    wrap: ps
      ? (text) => `try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))) } finally { ${psMark} }`
      : (text) => `eval '${text.replace(/'/g, "'\\''")}'; ${shMark}`,
    init: ps
      ? ["$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8"]
      : [],
  };
  return shellCache;
}

const consoles = new Map(); // id -> console record
const listeners = new Set(); // fn(event)

function emit(ev) {
  if (ev.type === 'state') { const c = consoles.get(ev.id); if (c) ev.ver = ++c.ver; }
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // one broken page stream must not stop the others
    }
  }
}

// fn({ type: 'out', id, seq, text } | { type: 'state', ...publicConsole }). Returns a function that stops it.
export function onConsole(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publicConsole(c) {
  // ver: counts the state changes, so a page can tell an older answer from a newer event
  return { id: c.id, shell: c.shell.name, kind: c.shell.kind, prompt: c.shell.prompt, cwd: c.cwd, busy: c.busy, alive: c.alive, startedAt: c.startedAt, seq: c.seq, ver: c.ver };
}

function goodDir(dir) {
  try {
    return typeof dir === 'string' && dir && path.isAbsolute(dir) && fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function keep(c, text) {
  if (!text) return;
  c.seq++;
  c.out.push({ seq: c.seq, text });
  c.size += text.length;
  while (c.size > MAX_KEEP && c.out.length > 1) c.size -= c.out.shift().text.length;
  emit({ type: 'out', id: c.id, seq: c.seq, text });
}

// Output of the shell: the marker lines are taken out (they end a command and give the folder); everything else is kept.
// Text after a marker start is held until its line ends, so a marker cut in two chunks is still found.
function takeOut(c, text) {
  let s = c.hold + text.replace(/\r\n/g, '\n');
  c.hold = '';
  let out = '';
  for (;;) {
    const i = s.indexOf('\x1e');
    if (i < 0) { out += s; break; }
    out += s.slice(0, i);
    const end = s.indexOf('\n', i);
    if (end < 0) {
      const rest = s.slice(i);
      // not (yet) a marker: a stray \x1e in a program's output, or the marker's first bytes
      if (rest.length < 4096 && MARK.startsWith(rest.slice(0, MARK.length))) c.hold = rest;
      else out += rest.slice(1);
      break;
    }
    const line = s.slice(i, end);
    if (line.startsWith(MARK)) {
      const dir = line.slice(MARK.length).trim();
      keep(c, out); out = '';
      if (dir) c.cwd = dir;
      if (c.pending > 0) c.pending--;
      c.starting = false;
      const was = c.busy;
      c.busy = c.pending > 0;
      if (was !== c.busy || dir) emit({ type: 'state', ...publicConsole(c) });
    } else {
      out += line.slice(1) + '\n';
    }
    s = s.slice(end + 1);
  }
  keep(c, out);
}

function start(c) {
  const sh = c.shell;
  let child;
  try {
    child = spawn(sh.exe, sh.args, {
      cwd: c.cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // its own process group on a Mac, so Restart ends what the shell started too
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    keep(c, `Could not start ${sh.name}: ${err.message}\n`);
    c.alive = false;
    return;
  }
  c.child = child;
  c.alive = true;
  c.busy = true;
  c.pending = 1; // the first marker says it is ready
  c.starting = true; // until then, what is typed is a command (it waits in the pipe), not input for a running one
  const dec = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  child.stdout.on('data', (b) => takeOut(c, dec.out.write(b)));
  child.stderr.on('data', (b) => keep(c, dec.err.write(b).replace(/\r\n/g, '\n')));
  child.stdin.on('error', () => {}); // a shell that ended while a line was on its way
  child.on('error', (err) => {
    keep(c, `Could not start ${sh.name}: ${err.message}\n`);
  });
  child.on('exit', (code) => {
    if (c.child !== child) return; // an old shell of a console that was restarted
    c.child = null;
    c.alive = false;
    c.busy = false;
    c.pending = 0;
    if (c.hold) { keep(c, c.hold.slice(1)); c.hold = ''; }
    if (!c.closing) keep(c, `\n[${sh.name} ended${code != null ? `, exit code ${code}` : ''}. Press Enter to start a new one.]\n`);
    emit({ type: 'state', ...publicConsole(c) });
  });
  for (const l of sh.init) child.stdin.write(l + '\n');
  child.stdin.write(sh.mark + '\n');
  emit({ type: 'state', ...publicConsole(c) });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// The console with this id, started when it is new (in `cwd`, or the home folder).
export function openConsole(id, { cwd } = {}) {
  if (!isConsoleId(id)) throw Object.assign(new Error('Bad console id'), { status: 400 });
  let c = consoles.get(id);
  if (!c) {
    if (consoles.size >= MAX_CONSOLES) {
      // the console nobody used for the longest time makes room
      const old = [...consoles.values()].sort((a, b) => a.usedAt - b.usedAt)[0];
      closeConsole(old.id);
    }
    c = { id, shell: consoleShell(), cwd: goodDir(cwd) || os.homedir(), out: [], size: 0, seq: 0, hold: '', busy: false, pending: 0, alive: false, child: null, startedAt: Date.now(), usedAt: Date.now(), ver: 0 };
    consoles.set(id, c);
    start(c);
  } else if (!c.alive) {
    c.startedAt = Date.now();
    start(c);
  }
  return c;
}

// What a page needs to draw a console: its state and the output after `since`.
export function consoleSnapshot(id, since = 0) {
  const c = consoles.get(id);
  if (!c) return null;
  const out = c.out.filter((x) => x.seq > since);
  const cut = since && c.out.length && c.out[0].seq > since + 1; // part of what the page missed is gone
  return { ...publicConsole(c), text: out.map((x) => x.text).join(''), cut: !!cut || (!since && c.out.length && c.out[0].seq > 1) };
}

export function listConsoles() {
  return [...consoles.values()].map(publicConsole);
}

// What the user typed (one line, or a pasted block of several): echoed in the output (the shell does not echo what it reads
// from a pipe), then run. The lines of a block go in together with one marker after them, so a command that goes on over
// several lines (a backtick in PowerShell, a backslash in zsh) stays whole.
export function sendLine(id, line, opts = {}) {
  if (typeof line !== 'string') throw Object.assign(new Error('line must be text'), { status: 400 });
  if (line.length > MAX_LINE) throw Object.assign(new Error('That is too long for the console'), { status: 413 });
  const lines = line.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const c = openConsole(id, opts);
  c.usedAt = Date.now();
  if (!c.child) return publicConsole(c);
  // While a command runs, what is typed is its input, as in a terminal (a "y" to its question): no prompt, no marker.
  if (c.busy && !c.starting && opts.asInput !== false) {
    keep(c, lines.join('\n') + '\n');
    c.child.stdin.write(lines.join('\n') + '\n');
    return publicConsole(c);
  }
  keep(c, lines.map((l, i) => `${i ? '>>' : c.shell.prompt} ${l}\n`).join(''));
  const text = lines.join('\n');
  c.child.stdin.write((text.trim() ? c.shell.wrap(text) : c.shell.mark) + '\n');
  c.pending++;
  if (!c.busy) { c.busy = true; emit({ type: 'state', ...publicConsole(c) }); }
  return publicConsole(c);
}

// The processes the running command started: every process under the shell, deepest last. On Windows the shell's own
// console host (conhost.exe) is left out: ending it would end the shell.
async function underShell(shellPid) {
  const list = await getProcesses(true);
  const kids = new Map();
  for (const p of list) {
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([shellPid]);
  const walk = (pid, depth) => {
    for (const p of kids.get(pid) || []) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      if (depth === 0 && process.platform === 'win32' && /^conhost(\.exe)?$/i.test(p.name)) continue;
      out.push({ pid: p.pid, name: p.name, top: depth === 0 });
      walk(p.pid, depth + 1);
    }
  };
  walk(shellPid, 0);
  return out;
}

// Stop: what Ctrl+C does in a terminal, for the command that runs now; the shell stays, with its folder and variables.
// On a Mac every process the command started gets SIGINT (force: SIGKILL). Windows has no Ctrl+C to send from outside a
// console, so there the command's process trees are ended (taskkill /T /F). A command that runs inside the shell itself
// (a loop written in PowerShell or zsh) has no process of its own: { inShell: true }, and only Restart ends it.
export async function stopConsole(id, { force = false } = {}) {
  const c = consoles.get(id);
  if (!c) throw Object.assign(new Error('Unknown console'), { status: 404 });
  if (!c.child || !c.busy || c.starting) return { stopped: 0, idle: true };
  const shellPid = c.child.pid;
  let procs;
  try {
    procs = await underShell(shellPid);
  } catch (err) {
    throw Object.assign(new Error('Could not read the process list: ' + err.message), { status: 500 });
  }
  if (!c.child || c.child.pid !== shellPid) return { stopped: 0, idle: true }; // restarted meanwhile
  if (!procs.length) return { stopped: 0, inShell: true };
  const win = process.platform === 'win32';
  if (win) {
    for (const p of procs.filter((x) => x.top)) {
      spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    }
  } else {
    for (const p of procs) {
      try {
        process.kill(p.pid, force ? 'SIGKILL' : 'SIGINT');
      } catch {
        // ended already
      }
    }
  }
  const forced = win || force;
  keep(c, forced ? `^C [ended: ${procs.filter((x) => x.top).map((x) => x.name || x.pid).join(', ')}]\n` : '^C\n');
  return { stopped: procs.length, forced };
}

// Ends the shell (and what it started) and opens a new one in the folder it was in.
export function restartConsole(id) {
  const c = consoles.get(id);
  if (!c) return openConsole(id);
  const old = c.child;
  c.child = null;
  c.alive = false;
  c.hold = '';
  killTree(old);
  keep(c, `\n[Restarted: a new ${c.shell.name} in ${c.cwd}]\n`);
  c.startedAt = Date.now();
  start(c);
  return c;
}

export function closeConsole(id) {
  const c = consoles.get(id);
  if (!c) return false;
  consoles.delete(id);
  c.closing = true;
  const old = c.child;
  c.child = null;
  killTree(old);
  emit({ type: 'state', ...publicConsole(c), closed: true });
  return true;
}

// The shells end with the server (a restart opens new ones when the page types again).
process.on('exit', () => {
  for (const c of consoles.values()) {
    try {
      if (c.child) process.platform === 'win32' ? c.child.kill() : process.kill(-c.child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});
