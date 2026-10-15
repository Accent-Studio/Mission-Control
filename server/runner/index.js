// Mission Control runner: owns the Claude Code processes so they survive a restart of the server.
//
// The server (runs.js) used to start one `claude -p` process per conversation as its own child and killed them all when
// it exited, so the Restart button ended every running conversation and its background helper agents. This program is
// started once on a cold start (run-server.bat, like the phone bridge; the restart loop does not touch it), starts and
// keeps the claude processes, and hands their output to whichever server is connected. A second runner finds the port
// taken and exits with code 73. A new version of this file is picked up only on the next cold start: the server logs
// when the running runner is older than its code (see runnerClient.js).
//
// Listens on 127.0.0.1 only (MC_RUNNER_PORT, default 1702). One authenticated TCP connection at a time, newline-delimited
// JSON. The secret lives in .data\runner\secret (locked to the current Windows user, same method as the bridge secret) and
// never crosses the socket. Each side proves it knows it with a challenge-response, the runner first sending a nonce:
//   runner -> {op:'challenge', proto, nonce: runnerNonce}                     at once, before reading anything
//   client -> {op:'hello', proto, nonce: clientNonce, proof}                  proof = HMAC(secret, "client"|runnerNonce|clientNonce)
//   runner -> {op:'hello', ok:true, proof, pid, startedAt, stamp, runs}       proof = HMAC(secret, "runner"|clientNonce|runnerNonce)
// A client that cannot prove itself is dropped without a word; a client sends nothing but its answer and accepts nothing
// until the runner has proven itself too (a stranger on the port learns nothing and can start nothing). A new authenticated
// connection replaces the old one. Sockets that have not answered within AUTH_MS are dropped, they are kept apart from the
// authenticated connection, and past MAX_PENDING the oldest of them is dropped to make room, so strangers can never keep
// the real server out.
//
// The runner starts nothing but the claude program: the executable is the claude binary the runner resolved on its own
// (never a path from the message), the arguments are the fixed list plus the known flags (shared.js), the folder is one of
// the project folders and the system prompt file one the server writes. It never uses a shell and accepts no environment
// from the network.
//
// What lives where. The server keeps all the logic about a conversation (turns, seq numbers, permission questions,
// remote control, idle and background-work tracking). The runner keeps, per run, only what the server cannot rebuild
// after a restart: a journal of everything that happened since the server last wrote a checkpoint, in order.
//   out   a stdout line of the process (numbered 1, 2, 3 ... per run)
//   exit  the process ended (code, tail of stderr)
//   in    something the server did to the conversation (a message, an answer to a permission question, a close, a kill),
//         with the number of the last out line the server had handled at that moment (after)
// plus the run's meta (what the server needs to build its record again) and the last checkpoint (the server's small
// state at a quiet moment, and the number of the last line it covers). A new server loads meta and checkpoint and
// replays the journal through the same code that handled it live, so it ends in the same state with the same numbers.
// While no server is connected the journal simply grows (bounded, the oldest entries go first and the run is marked).
//
// Wire (client to runner): hello, list, spawn, in (a stdin line), note (a journal entry), end (close stdin), kill, meta,
// annot, checkpoint, sub, forget, ping, shutdown.
// Runner to client: hello (with the runs), runs, spawned, refused, batch (journal entries), e (a live entry), pong, bye.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { DATA_DIR, RUNNER_HOST, RUNNER_PORT } from '../config.js';
import { handshakeProof, isNonce, loadOrCreateSecret, makeNonce, proofMatches } from '../lib/privateSecret.js';
import { isClaudeCommand, resolveClaude } from '../lib/claudeExe.js';
import { PROTO, checkSpawnArgs, codeStamp, cwdAllowed, isUuid } from './shared.js';

if (RUNNER_PORT === null) {
  console.log('The runner is turned off (MC_RUNNER_PORT=off).');
  process.exit(0);
}

const RUNNER_DIR = path.join(DATA_DIR, 'runner');
const LOG_FILE = path.join(RUNNER_DIR, 'runner.log');
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const JOURNAL_BYTES = num(process.env.MC_RUNNER_JOURNAL_BYTES, 96 * 1024 * 1024); // per run
const ORPHAN_MS = num(process.env.MC_RUNNER_ORPHAN_MS, 6 * 60 * 60 * 1000); // no server for this long: close the processes
const IDLE_EXIT_MS = num(process.env.MC_RUNNER_IDLE_EXIT_MS, 30 * 60 * 1000); // no server and no process for this long: exit
const AUTH_MS = num(process.env.MC_RUNNER_AUTH_MS, 2000); // a socket that has not answered the challenge by then is dropped
const MAX_PENDING = num(process.env.MC_RUNNER_MAX_PENDING, 64); // sockets that have not answered yet, apart from the authenticated one
const FORGET_AFTER_MS = 60 * 60 * 1000; // an ended run nobody collected
const MAX_RUNS = 32;
const MAX_LINE = 48 * 1024 * 1024; // one stdout line of a process; longer lines are dropped, not buffered
const MAX_FRAME = 96 * 1024 * 1024; // one message from an authenticated server
const MAX_PREAUTH = 4096;
const BATCH_BYTES = 4 * 1024 * 1024;

const startedAt = Date.now();
const stamp = Number(process.env.MC_RUNNER_STAMP) || codeStamp(); // MC_RUNNER_STAMP: a test pretends to be an old runner

// ---- Log ----

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // the console line is enough
  }
}

// ---- Secret ----

const loaded = loadOrCreateSecret({ dir: RUNNER_DIR, file: path.join(RUNNER_DIR, 'secret'), label: 'runner' });
if (!loaded.ok) {
  console.error(`[runner] ${loaded.reason}. The runner does not start.`);
  process.exit(1);
}
const secret = loaded.secret;

// ---- Runs ----

const runs = new Map(); // runId -> run
let conn = null; // the authenticated connection, or null
let lastServerAt = Date.now();

// What an entry weighs in the journal. A line of the process counts its text; something the server did ('in') counts its real
// JSON size (a message with attachments is up to 256 KB); the end of the process is small.
const sizeOf = (e) => (e.d === 'in' ? jsonSize(e) : (typeof e.line === 'string' ? e.line.length : 0) + 120);

function send(c, obj) {
  if (!c || !c.sock || c.sock.destroyed) return false;
  try {
    c.sock.write(JSON.stringify(obj) + '\n');
    return true;
  } catch {
    return false;
  }
}

function trim(r) {
  while (r.bytes > JOURNAL_BYTES && r.entries.length > 1) {
    const e = r.entries.shift();
    r.bytes -= sizeOf(e);
    if (e.d !== 'in') r.droppedOut = Math.max(r.droppedOut, e.n);
  }
}

// An entry that comes from the process (a line, or its end): numbered, and pushed to the subscribed server at once.
function addOut(r, d, fields) {
  const e = { d, n: r.nextN++, t: Date.now(), ...fields };
  r.entries.push(e);
  r.bytes += sizeOf(e);
  trim(r);
  if (conn && r.subConn === conn) send(conn, { op: 'e', runId: r.runId, e });
  return e;
}

// An entry that comes from the server (something it did to the conversation). It sits after the out entry the server had
// handled when it did it, so a replay applies things in the order the server applied them.
function addIn(r, after, entry) {
  let at = r.entries.length;
  while (at > 0 && r.entries[at - 1].d !== 'in' && r.entries[at - 1].n > after) at--;
  const e = { d: 'in', after, ...entry };
  r.entries.splice(at, 0, e);
  r.bytes += sizeOf(e);
  trim(r);
}

function summary(r) {
  return {
    runId: r.runId,
    pid: r.pid,
    alive: r.alive,
    startedAt: r.startedAt,
    meta: r.meta,
    checkpoint: r.cp,
    lastN: r.nextN - 1,
    droppedOut: r.droppedOut,
    exit: r.exit,
  };
}

function killTree(r) {
  if (!r.pid || !r.alive) return;
  execFile('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {});
}

function killAllNow() {
  for (const r of runs.values()) {
    if (!r.alive || !r.pid) continue;
    try {
      execFileSync('taskkill', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

const jsonSize = (v) => {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Infinity;
  }
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

async function doSpawn(c, msg) {
  const refuse = (error) => {
    log(`spawn refused for ${String(msg.runId).slice(0, 8)}: ${error}`);
    send(c, { op: 'refused', runId: msg.runId, error });
  };
  if (!isUuid(msg.runId)) return refuse('bad run id');
  if (runs.has(msg.runId)) return refuse('run id already in use');
  if (runs.size >= MAX_RUNS) return refuse('too many runs');
  if (typeof msg.cmd !== 'string' || !Array.isArray(msg.args)) return refuse('cmd must be a string and args a list of strings');
  if (!msg.args.every((a) => typeof a === 'string')) return refuse('args must be strings');
  if (!isObj(msg.meta) || jsonSize(msg.meta) > 64 * 1024) return refuse('meta must be a small object');
  if (typeof msg.cwd !== 'string' || !path.isAbsolute(msg.cwd) || msg.cwd.includes('\0')) return refuse('cwd must be an absolute folder');
  if (!cwdAllowed(msg.cwd)) return refuse('cwd is not one of the project folders');
  try {
    if (!fs.statSync(msg.cwd).isDirectory()) return refuse('cwd is not a folder');
  } catch {
    return refuse('cwd does not exist');
  }
  let entry;
  try {
    entry = await resolveClaude();
  } catch (err) {
    return refuse(`claude was not found: ${err.message}`);
  }
  if (!isClaudeCommand(entry, msg.cmd, msg.args)) return refuse('the program is not the claude binary');
  const bad = checkSpawnArgs(msg.args.slice(entry.pre.length));
  if (bad) return refuse(bad);
  if (runs.has(msg.runId)) return refuse('run id already in use'); // the resolve above awaited

  const r = {
    runId: msg.runId,
    pid: null,
    child: null,
    alive: true,
    meta: msg.meta,
    startedAt: Date.now(),
    entries: [],
    bytes: 0,
    nextN: 1,
    droppedOut: 0,
    cp: null,
    exit: null,
    subConn: c,
    errTail: '',
    closedStdinAt: 0,
  };
  runs.set(r.runId, r);
  let child;
  try {
    // The program is the one this runner resolved itself, with the leading arguments it belongs to; the request only decided
    // that it matches (isClaudeCommand above), it never supplies the path that runs.
    child = spawn(entry.cmd, [...entry.pre, ...msg.args.slice(entry.pre.length)], { cwd: msg.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  } catch (err) {
    send(c, { op: 'spawned', runId: r.runId, pid: null });
    endRun(r, -1, String(err.message).slice(0, 500));
    return;
  }
  r.child = child;
  r.pid = child.pid || null;
  log(`run ${r.runId.slice(0, 8)} started, pid ${r.pid}`);
  send(c, { op: 'spawned', runId: r.runId, pid: r.pid });

  child.stdin.on('error', () => {}); // a write after the process died; the close handler reports the end
  let buf = '';
  let skipping = false; // inside a line that grew past MAX_LINE; drop it up to its newline
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (skipping) skipping = false;
      else if (line.trim()) addOut(r, 'out', { line });
    }
    if (buf.length > MAX_LINE) {
      buf = '';
      skipping = true;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    r.errTail = (r.errTail + d).slice(-2000);
  });
  child.on('error', (err) => {
    r.errTail = String(err.message);
    if (buf.trim() && !skipping) addOut(r, 'out', { line: buf });
    buf = '';
    endRun(r, -1, r.errTail);
  });
  child.on('close', (code) => {
    if (buf.trim() && !skipping) addOut(r, 'out', { line: buf });
    buf = '';
    endRun(r, code === null ? -1 : code, r.errTail);
  });
}

function endRun(r, code, errTail) {
  if (!r.alive) return;
  r.alive = false;
  r.child = null;
  r.exit = { code, errTail: String(errTail || '').trim().slice(-500), t: Date.now() };
  log(`run ${r.runId.slice(0, 8)} ended, code ${code}`);
  addOut(r, 'exit', { code, errTail: r.exit.errTail });
}

// ---- Messages from the server ----

function handle(c, msg) {
  const r = typeof msg.runId === 'string' ? runs.get(msg.runId) : null;
  switch (msg.op) {
    case 'ping':
      return send(c, { op: 'pong' });
    case 'list':
      return send(c, { op: 'runs', runs: [...runs.values()].map(summary) });
    case 'spawn':
      return void doSpawn(c, msg).catch((err) => log(`spawn failed: ${err.message}`));
    case 'in': {
      // One line for the process's stdin (the text includes its newline).
      if (!r || !r.alive || !r.child || typeof msg.line !== 'string') return;
      try {
        r.child.stdin.write(msg.line);
      } catch {
        // the process is gone, the close handler reports it
      }
      return;
    }
    case 'note': {
      // Something the server did to the conversation, for the journal (a message, an answer, a close, a kill).
      const e = msg.e;
      if (r && isObj(e) && typeof e.k === 'string' && isCount(e.after) && jsonSize(e) <= 256 * 1024) addIn(r, e.after, e);
      return;
    }
    case 'end': {
      if (!r || !r.alive || !r.child) return;
      r.closedStdinAt = Date.now();
      try {
        r.child.stdin.end();
      } catch {
        // already closed
      }
      return;
    }
    case 'kill':
      return r ? killTree(r) : undefined;
    case 'meta': {
      if (!r || !isObj(msg.patch)) return;
      const next = { ...r.meta, ...msg.patch };
      if (jsonSize(next) <= 64 * 1024) r.meta = next;
      return;
    }
    case 'annot': {
      if (!r || !isCount(msg.n) || !isObj(msg.a) || jsonSize(msg.a) > 4096) return;
      for (let i = r.entries.length - 1; i >= 0; i--) {
        const e = r.entries[i];
        if (e.d !== 'in' && e.n === msg.n) {
          e.a = { ...(e.a || {}), ...msg.a };
          break;
        }
        if (e.d !== 'in' && e.n < msg.n) break;
      }
      return;
    }
    case 'checkpoint': {
      if (!r || !isCount(msg.n) || msg.n >= r.nextN || msg.n < (r.cp ? r.cp.n : 0) || !isObj(msg.state) || jsonSize(msg.state) > 1024 * 1024) return;
      r.cp = { n: msg.n, state: msg.state };
      // What the checkpoint covers goes: out entries up to n, and what the server did before it handled line n + 1.
      r.entries = r.entries.filter((e) => (e.d === 'in' ? e.after >= msg.n : e.n > msg.n));
      r.bytes = r.entries.reduce((s, e) => s + sizeOf(e), 0);
      return;
    }
    case 'sub': {
      if (!r) return send(c, { op: 'batch', runId: msg.runId, entries: [], upto: 0, droppedOut: 0, done: true, unknown: true });
      const after = isCount(msg.after) ? msg.after : 0;
      const ins = msg.ins === true;
      const list = r.entries.filter((e) => (e.d === 'in' ? ins && e.after >= after : e.n > after));
      r.subConn = c; // from here on every new entry is pushed, in the same tick as this batch is cut
      const upto = r.nextN - 1;
      let part = [];
      let bytes = 0;
      const flush = (done) => {
        send(c, { op: 'batch', runId: r.runId, entries: part, upto, droppedOut: r.droppedOut, done });
        part = [];
        bytes = 0;
      };
      for (const e of list) {
        part.push(e);
        bytes += sizeOf(e);
        if (bytes >= BATCH_BYTES) flush(false);
      }
      return flush(true);
    }
    case 'forget': {
      if (r && !r.alive) runs.delete(r.runId);
      return;
    }
    case 'shutdown': {
      log('shutdown requested' + (msg.kill === true ? ' (killing the processes)' : ''));
      if (msg.kill === true) killAllNow();
      send(c, { op: 'bye', reason: 'shutdown' });
      return void setTimeout(() => process.exit(0), 150);
    }
    default:
      return undefined;
  }
}

// ---- Connections ----

// Sockets that have not answered the challenge yet, oldest first. They are not the authenticated connection and never touch
// it. A new socket is always accepted: when there are too many waiting, the oldest of them is dropped. Each one is dropped
// by its own timer after AUTH_MS anyway, so a process that opens sockets and sits on them holds nothing for long.
const pending = new Set();

function onConnection(sock) {
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.values().next().value;
    pending.delete(oldest);
    oldest.sock.destroy();
  }
  sock.setNoDelay(true);
  sock.setEncoding('utf8');
  const c = { sock, authed: false, nonce: makeNonce() };
  pending.add(c);
  let buf = '';
  const authTimer = setTimeout(() => {
    if (!c.authed) sock.destroy();
  }, AUTH_MS);
  sock.on('error', () => {});
  sock.on('close', () => {
    clearTimeout(authTimer);
    pending.delete(c);
    if (conn === c) {
      conn = null;
      lastServerAt = Date.now();
      log('the server disconnected');
    }
  });
  // The challenge goes out before anything is read. It holds no secret, only a nonce that makes the answer good for this
  // connection alone.
  send(c, { op: 'challenge', proto: PROTO, nonce: c.nonce });
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > (c.authed ? MAX_FRAME : MAX_PREAUTH)) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return sock.destroy();
      }
      if (!isObj(msg) || typeof msg.op !== 'string') return sock.destroy();
      if (!c.authed) {
        // The first message must be the answer to the challenge. Nothing is answered to anything else, and the nonce is
        // good for one try: a wrong answer ends the connection.
        const expected = isNonce(msg.nonce) ? handshakeProof(secret, 'client', c.nonce, msg.nonce) : null;
        if (msg.op !== 'hello' || msg.proto !== PROTO || !expected || !proofMatches(msg.proof, expected)) return sock.destroy();
        c.authed = true;
        clearTimeout(authTimer);
        pending.delete(c);
        if (conn && conn !== c) {
          send(conn, { op: 'bye', reason: 'superseded' });
          conn.sock.destroy();
        }
        conn = c;
        lastServerAt = Date.now();
        for (const r of runs.values()) r.subConn = null; // the new server asks for each run with sub
        log('a server connected');
        send(c, {
          op: 'hello',
          ok: true,
          proto: PROTO,
          proof: handshakeProof(secret, 'runner', msg.nonce, c.nonce),
          pid: process.pid,
          startedAt,
          stamp,
          runs: [...runs.values()].map(summary),
        });
        continue;
      }
      if (conn !== c) return; // replaced meanwhile
      try {
        handle(c, msg);
      } catch (err) {
        log(`could not handle ${msg.op}: ${err.stack || err.message}`);
      }
    }
  });
}

// ---- Housekeeping ----

setInterval(() => {
  const now = Date.now();
  for (const r of [...runs.values()]) {
    if (!r.alive && r.exit && now - r.exit.t > FORGET_AFTER_MS) runs.delete(r.runId);
  }
  if (conn) return;
  const away = now - lastServerAt;
  if (away > ORPHAN_MS) {
    // Nobody has come for these processes for a long time: close them the clean way, kill what ignores it.
    for (const r of runs.values()) {
      if (!r.alive || !r.child) continue;
      if (!r.closedStdinAt) {
        log(`no server for a long time, closing run ${r.runId.slice(0, 8)}`);
        r.closedStdinAt = now;
        try {
          r.child.stdin.end();
        } catch {
          // already closed
        }
      } else if (now - r.closedStdinAt > 60000) killTree(r);
    }
  }
  const alive = [...runs.values()].some((r) => r.alive);
  if (!alive && away > IDLE_EXIT_MS) {
    log('no server and no process for a while, exiting');
    process.exit(0);
  }
}, 30000).unref();

// Ending the runner on purpose (the window is closed, Ctrl+C) ends its processes too. A crash does not: see below.
function bye(code) {
  log(`runner ending (${code})`);
  killAllNow();
  process.exit(code);
}
process.on('SIGINT', () => bye(130));
process.on('SIGTERM', () => bye(143));
process.on('SIGHUP', () => bye(129));
process.on('SIGBREAK', () => bye(131));
// A stray error must never take the processes of every conversation down with the runner.
process.on('uncaughtException', (err) => log(`[uncaughtException] ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => log(`[unhandledRejection] ${err && err.stack ? err.stack : err}`));

const server = net.createServer(onConnection);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Another runner already holds ${RUNNER_HOST}:${RUNNER_PORT}. This one exits.`);
    process.exit(73);
  }
  console.error('[runner] listener failed:', err.message);
  process.exit(1);
});
server.listen(RUNNER_PORT, RUNNER_HOST, () => {
  log(`Mission Control runner on ${RUNNER_HOST}:${RUNNER_PORT} (pid ${process.pid}, code ${new Date(stamp).toISOString()})`);
});
