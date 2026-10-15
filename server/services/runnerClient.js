// The server's side of the runner (server/runner/index.js, read its header first): one small client that starts claude
// processes and hands their output back. runs.js uses only this module to start a process.
//
// When the runner is reachable, the process is started by the runner, so it survives a restart of this server. When it is
// not (never started, wrong secret, another protocol version, refused request), the process is started directly as a child
// of this server and the log says so: Mission Control keeps working, but those conversations end with the server.
//
// Both kinds give runs.js the same thing: a "proc" with write/end/kill and a stream of journal entries pushed to a sink.
//   { d: 'out', n, t, line }          a stdout line of the process
//   { d: 'exit', n, t, code, errTail } the process ended
// (the journal also holds { d: 'in', after, ... } entries, which only come back in a replay batch after a restart).
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { DATA_DIR, RUNNER_HOST, RUNNER_PORT } from '../config.js';
import { handshakeProof, isNonce, loadOrCreateSecret, makeNonce, proofMatches } from '../lib/privateSecret.js';
import { PROTO, codeStamp } from '../runner/shared.js';

const MAX_LINE = 48 * 1024 * 1024; // one JSON line from the CLI (a replayed message with attachments is long); longer lines are dropped, not buffered
const CONNECT_MS = 1500;
const BOOT_WINDOW_MS = Number(process.env.MC_RUNNER_BOOT_MS) || 3000; // the runner may be starting at the same moment as the server
const GIVE_UP_MS = Number(process.env.MC_RUNNER_GIVE_UP_MS) || 30000; // a connection that was lost and does not come back
const RETRY_AFTER_MS = 5000; // between attempts to find a runner that was not there
const SPAWN_ACK_MS = 8000;
const QUEUE_MAX = 5000;

const tag = (id) => String(id).slice(0, 8);

// ---- State ----

let state = RUNNER_PORT === null ? 'disabled' : 'off'; // disabled, off, connecting, connected, reconnecting
let sock = null;
let secret = null;
let secretReason = null;
let info = null; // the runner's hello
let lastAttempt = 0;
let lastFailure = '';
let downSince = 0;
let reconnectTimer = null;
let started = false;
let firstSettled = null; // promise: the first connection attempt window (and the adoption that follows) is over
let resolveFirst = null;
let loggedUnavailable = '';

const sinks = new Map(); // runId -> sink { entry(e), batch(frame) }
const waiting = new Map(); // runId -> { resolve, reject, timer }
const queue = []; // messages for the runner written while the connection was down
const attachHandlers = [];
const downHandlers = [];
const lostHandlers = [];

const log = (msg) => console.log(`[runner] ${msg}`);

export function runnerStatus() {
  return { state, port: RUNNER_PORT, pid: info ? info.pid : null, startedAt: info ? info.startedAt : null, reason: state === 'connected' ? null : lastFailure || secretReason };
}

export function onAttach(fn) {
  attachHandlers.push(fn);
}
export function onDown(fn) {
  downHandlers.push(fn);
}
export function onLost(fn) {
  lostHandlers.push(fn);
}

// ---- The connection ----

function readSecret() {
  if (secret || secretReason) return !!secret;
  const r = loadOrCreateSecret({ dir: path.join(DATA_DIR, 'runner'), file: path.join(DATA_DIR, 'runner', 'secret'), label: 'runner' });
  if (r.ok) secret = r.secret;
  else {
    secretReason = r.reason;
    log(`${r.reason}. Claude processes start directly and end when the server ends.`);
  }
  return !!secret;
}

function rawSend(obj) {
  if (!sock || sock.destroyed || state !== 'connected') return false;
  try {
    sock.write(JSON.stringify(obj) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Messages that matter to the runner's journal wait for the connection when it is down.
function sendOrQueue(obj) {
  if (rawSend(obj)) return;
  if (state === 'disabled' || state === 'off') return;
  queue.push(obj);
  if (queue.length > QUEUE_MAX) queue.shift();
}

// Connects and runs the handshake (see the header of runner/index.js). The secret never crosses the socket: whoever listens on
// the port first sees only a nonce of its own choosing answered with a keyed hash. This side sends nothing else and accepts
// nothing from the peer (no runs, no cwd, no journal) until the peer has proven that it holds the secret too.
// A flood of unauthenticated sockets can push this server's waiting handshake out of the runner's queue (the runner drops the
// oldest). So a connection the runner closed before answering is tried again right away a few times before it counts as failed.
async function attemptConnect(timeoutMs = CONNECT_MS) {
  let r;
  for (let i = 0; i < 4; i++) {
    r = await attemptConnectOnce(timeoutMs);
    if (r.ok || !/closed the connection/.test(String(r.error))) return r;
    await new Promise((res) => setTimeout(res, 50 * (i + 1)));
  }
  return r;
}

function attemptConnectOnce(timeoutMs = CONNECT_MS) {
  return new Promise((resolve) => {
    if (!readSecret()) return resolve({ ok: false, error: secretReason });
    let done = false;
    let buf = '';
    let phase = 'challenge'; // challenge: waiting for the runner's nonce; proof: answered, waiting for the runner's proof
    let ownNonce = null;
    let runnerNonce = null;
    const s = net.connect({ host: RUNNER_HOST, port: RUNNER_PORT });
    s.setNoDelay(true);
    s.setEncoding('utf8');
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!r.ok) s.destroy();
      resolve(r);
    };
    const refuse = (error) => finish({ ok: false, error });
    const timer = setTimeout(() => refuse('no answer from the runner'), timeoutMs);
    s.on('error', (err) => refuse(err.code === 'ECONNREFUSED' ? 'nothing is listening on the runner port' : err.message));
    s.on('close', () => {
      if (!done) refuse('the runner closed the connection (wrong secret, or an older runner?)');
      else if (sock === s) onSocketClosed();
    });
    s.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          if (!done) return refuse('the peer on the runner port did not speak the runner protocol');
          continue;
        }
        if (!done) {
          if (!msg || typeof msg !== 'object') return refuse('the peer on the runner port did not speak the runner protocol');
          if (phase === 'challenge') {
            if (msg.op !== 'challenge' || !isNonce(msg.nonce)) return refuse('the peer on the runner port did not speak the runner protocol');
            if (msg.proto !== PROTO) return refuse(`the runner speaks protocol ${msg.proto}, this server ${PROTO}`);
            runnerNonce = msg.nonce;
            ownNonce = makeNonce();
            phase = 'proof';
            s.write(JSON.stringify({ op: 'hello', proto: PROTO, nonce: ownNonce, proof: handshakeProof(secret, 'client', runnerNonce, ownNonce) }) + '\n');
            continue;
          }
          // The runner's proof comes first; nothing else in this message is believed before it checks out.
          if (msg.op !== 'hello' || msg.ok !== true || !proofMatches(msg.proof, handshakeProof(secret, 'runner', ownNonce, runnerNonce))) {
            return refuse('the peer on the runner port could not prove that it holds the secret, so it is not used');
          }
          if (msg.proto !== PROTO || !Array.isArray(msg.runs) || !Number.isInteger(msg.pid)) return refuse('the runner sent a hello this server cannot read');
          finish({ ok: true, sock: s, hello: msg });
          continue;
        }
        if (sock === s) onMessage(msg);
      }
      if (buf.length > MAX_LINE * 2) s.destroy();
    });
  });
}

async function establish(r) {
  sock = r.sock;
  info = r.hello;
  state = 'connected';
  downSince = 0;
  lastFailure = '';
  loggedUnavailable = '';
  log(`connected to the runner (pid ${info.pid}, ${info.runs.length} run${info.runs.length === 1 ? '' : 's'})`);
  const mine = codeStamp();
  if (mine > (info.stamp || 0)) {
    log(`the running runner (started ${new Date(info.startedAt).toISOString()}) is older than its code (${new Date(mine).toISOString()}). It is replaced on the next cold start, until then it keeps working as it is.`);
  }
  // What was written while the connection was down goes first (the runner places each by its "after").
  for (const m of queue.splice(0)) rawSend(m);
  for (const fn of attachHandlers) {
    try {
      await fn(info);
    } catch (err) {
      console.error('[runner] could not adopt the runner runs:', err);
    }
  }
}

function onSocketClosed() {
  sock = null;
  const was = state;
  if (was !== 'connected') return;
  state = 'reconnecting';
  downSince = Date.now();
  log('the connection to the runner was lost, trying to get it back');
  for (const fn of downHandlers) {
    try {
      fn();
    } catch (err) {
      console.error('[runner] down handler failed:', err);
    }
  }
  scheduleReconnect(500);
}

function scheduleReconnect(wait) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (state !== 'reconnecting') return;
    const r = await attemptConnect();
    if (r.ok) return establish(r);
    lastFailure = r.error;
    if (Date.now() - downSince > GIVE_UP_MS) {
      state = 'off';
      lastAttempt = Date.now();
      log(`the runner did not come back (${r.error}). Its conversations are lost; new ones start directly.`);
      queue.length = 0;
      for (const fn of lostHandlers) {
        try {
          fn();
        } catch (err) {
          console.error('[runner] lost handler failed:', err);
        }
      }
      return;
    }
    scheduleReconnect(Math.min(2000, wait * 2));
  }, wait);
  reconnectTimer.unref();
}

function onMessage(msg) {
  if (!msg || typeof msg.op !== 'string') return;
  switch (msg.op) {
    case 'e': {
      const s = sinks.get(msg.runId);
      if (s) s.entry(msg.e);
      return;
    }
    case 'batch': {
      const s = sinks.get(msg.runId);
      if (s) s.batch(msg);
      return;
    }
    case 'spawned': {
      // Handled in this very step: the lines that follow in the same chunk already find the sink attached to the process.
      const w = waiting.get(msg.runId);
      if (w) {
        waiting.delete(msg.runId);
        clearTimeout(w.timer);
        w.resolve(msg.pid);
      }
      return;
    }
    case 'refused': {
      const w = waiting.get(msg.runId);
      if (w) {
        waiting.delete(msg.runId);
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error(String(msg.error || 'refused')), { refused: true }));
      }
      return;
    }
    case 'bye':
      log(`the runner said goodbye (${msg.reason})`);
      return;
    default:
  }
}

// Starts the first connection attempt; keeps trying for a few seconds because the runner may be starting at this moment.
export function startRunnerClient() {
  if (started) return;
  started = true;
  firstSettled = new Promise((r) => (resolveFirst = r));
  if (state === 'disabled') return resolveFirst();
  (async () => {
    const t0 = Date.now();
    for (;;) {
      state = 'connecting';
      const r = await attemptConnect();
      if (r.ok) {
        await establish(r);
        break;
      }
      lastFailure = r.error;
      state = 'off';
      lastAttempt = Date.now();
      if (secretReason || Date.now() - t0 > BOOT_WINDOW_MS) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    if (state !== 'connected') log(`not available (${lastFailure}). Claude processes start directly and end when the server ends.`);
    resolveFirst();
  })().catch((err) => {
    console.error('[runner] could not connect:', err);
    resolveFirst();
  });
}

// Resolves when the first connection attempt window is over and the runs found there are taken over.
export function runnerReady() {
  startRunnerClient();
  return Promise.race([firstSettled, new Promise((res) => setTimeout(res, BOOT_WINDOW_MS + 8000).unref())]);
}

async function ensureConnected() {
  startRunnerClient();
  await firstSettled;
  if (state === 'connected') return true;
  if (state === 'off' && Date.now() - lastAttempt >= RETRY_AFTER_MS) {
    state = 'connecting';
    const r = await attemptConnect();
    if (r.ok) {
      await establish(r);
      return true;
    }
    lastFailure = r.error;
    state = 'off';
    lastAttempt = Date.now();
  }
  return state === 'connected';
}

export function runnerConnected() {
  return state === 'connected';
}

// ---- Procs ----

function runnerProc(runId, pid) {
  return {
    kind: 'runner',
    runId,
    pid,
    // line is the full stdin text including its newline.
    write(line) {
      sendOrQueue({ op: 'in', runId, line });
    },
    // e: something this server did to the conversation, for the journal the replay after a restart is built from.
    note(e) {
      sendOrQueue({ op: 'note', runId, e });
    },
    end() {
      sendOrQueue({ op: 'end', runId });
    },
    kill() {
      sendOrQueue({ op: 'kill', runId });
    },
    meta(patch) {
      sendOrQueue({ op: 'meta', runId, patch });
    },
    annot(n, a) {
      sendOrQueue({ op: 'annot', runId, n, a });
    },
    checkpoint(n, cpState) {
      sendOrQueue({ op: 'checkpoint', runId, n, state: cpState });
    },
    forget() {
      sendOrQueue({ op: 'forget', runId });
      sinks.delete(runId);
    },
    // Asks for the journal after line `after` (and what the server did after it, when `ins`), then every new entry.
    sub(after, ins) {
      return rawSend({ op: 'sub', runId, after, ins: !!ins });
    },
    detach() {
      sinks.delete(runId);
    },
  };
}

// A handle for a run the runner already has (found in its hello). The sink gets the replay batches and later entries.
export function adoptRunnerProc(runId, pid, sink) {
  sinks.set(runId, sink);
  return runnerProc(runId, pid);
}

const directChildren = new Set();

function killTreeOf(pid) {
  if (!pid) return;
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {});
}

function spawnDirect({ cmd, args, cwd }, sink) {
  const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  directChildren.add(child);
  child.stdin.on('error', () => {}); // a write after the process died; the close handler reports the end
  let n = 0;
  let buf = '';
  let skipping = false; // inside a line that grew past MAX_LINE; drop it up to its newline
  const push = (line) => {
    if (line.trim()) sink.entry({ d: 'out', n: ++n, t: Date.now(), line });
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      if (skipping) skipping = false;
      else push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    if (buf.length > MAX_LINE) {
      buf = '';
      skipping = true;
    }
  });
  let errTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    errTail = (errTail + c).slice(-2000);
  });
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    directChildren.delete(child);
    if (buf.trim() && !skipping) push(buf);
    buf = '';
    sink.entry({ d: 'exit', n: ++n, t: Date.now(), code, errTail: errTail.trim().slice(-500) });
  };
  child.on('error', (err) => {
    errTail = String(err.message);
    finish(-1);
  });
  child.on('close', (code) => finish(code === null ? -1 : code));
  const proc = {
    kind: 'direct',
    runId: null,
    pid: child.pid || null,
    write(line) {
      try {
        child.stdin.write(line);
      } catch {
        // the process is gone, the close handler ends the run
      }
    },
    end() {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
    },
    kill() {
      killTreeOf(child.pid);
    },
    note() {},
    meta() {},
    annot() {},
    checkpoint() {},
    forget() {},
    sub() {},
    detach() {},
  };
  sink.attach(proc); // before any output can arrive: the events of the process are delivered on later turns of the event loop
  return proc;
}

// Do not leave orphaned claude processes behind when the dashboard server ends: the ones it started itself. The ones the
// runner owns are the point of the runner and stay.
function killDirect() {
  for (const child of directChildren) {
    if (!child.pid) continue;
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}
process.on('exit', killDirect);

// Starts one claude process: through the runner when it is there, directly otherwise. req = { runId, cmd, args, cwd, meta }.
// sink = { entry(e), batch(frame) }. Throws when the process could not even be started directly (the caller marks the run failed).
export async function spawnProc(req, sink) {
  if (await ensureConnected()) {
    try {
      sinks.set(req.runId, sink);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(req.runId);
          reject(new Error('the runner did not answer the start request'));
        }, SPAWN_ACK_MS);
        const proc = runnerProc(req.runId, null);
        waiting.set(req.runId, {
          resolve: (pid) => {
            proc.pid = pid;
            sink.attach(proc);
            resolve(proc);
          },
          reject,
          timer,
        });
        if (!rawSend({ op: 'spawn', runId: req.runId, cmd: req.cmd, args: req.args, cwd: req.cwd, meta: req.meta })) {
          waiting.delete(req.runId);
          clearTimeout(timer);
          reject(Object.assign(new Error('the runner connection is down'), { refused: true }));
        }
      });
    } catch (err) {
      sinks.delete(req.runId);
      if (!err.refused) throw err;
      log(`the runner refused run ${tag(req.runId)} (${err.message}); starting it directly, it ends when the server ends`);
    }
  } else if (state !== 'disabled') {
    const why = lastFailure || secretReason || 'not connected';
    if (loggedUnavailable !== why) log(`not available (${why}); run ${tag(req.runId)} starts directly and ends when the server ends`);
    loggedUnavailable = why;
  }
  return spawnDirect(req, sink);
}
