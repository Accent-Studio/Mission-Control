// The PC's link to the hub (design/hub-spec.md): pairing with it once, then mc-link (bridge/run/mc-link.exe) running as
// a child of this server, a local proxy over the same encrypted peer-to-peer link as the phone. While it runs, this file
// writes .data/hub.json for services/hubSync.js: the proxy's address, and the link secret it wants in X-MC-Link.
//
//   .data/hub-link/          mc-link's state: the PC's key (its id on the hub) and server.json (the hub it is paired with)
//   .data/hub-link/secret    the link secret, private to the current user (lib/privateSecret.js)
//
// Without a pairing nothing runs, and a hub.json written by hand (tests) is left alone. MC_HUB_LINK_PORT moves the proxy
// (default 1703), MC_HUB_LINK_EXE points at another mc-link, and MC_HUB_LINK_ARGS adds options to it (tests: no relay, the
// hub's address).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, HUB_LINK_FILE, MACHINE_NAME, ROLE, ROOT } from '../config.js';
import { loadOrCreateSecret } from '../lib/privateSecret.js';
import { writeJson } from '../lib/jsonStore.js';
import { publish } from '../lib/events.js';

const LINK_DIR = path.join(DATA_DIR, 'hub-link');
const SECRET_FILE = path.join(LINK_DIR, 'secret');
const SERVER_FILE = path.join(LINK_DIR, 'server.json');
const PORT = Number(process.env.MC_HUB_LINK_PORT) || 1703; // 1700 to 1702 are Mission Control's, 1710 to 1719 BlitzVoice's
const EXE = process.env.MC_HUB_LINK_EXE || path.join(ROOT, 'bridge', 'run', process.platform === 'win32' ? 'mc-link.exe' : 'mc-link');
const PAIR_TIMEOUT_MS = 60e3;
const EXTRA = (process.env.MC_HUB_LINK_ARGS || '').split(' ').filter(Boolean);

const newExe = () => (EXE.endsWith('.exe') ? EXE.slice(0, -4) + '.new.exe' : EXE + '.new');
const exeThere = () => fs.existsSync(EXE) || fs.existsSync(newExe());
const fail = (status, message) => Object.assign(new Error(message), { status });

let child = null;
let state = 'off'; // off, starting, connecting, online, offline: <why>, no longer paired
let stopped = false;
let backoff = 2000;

function setState(s) {
  if (s === state) return;
  state = s;
  publish('hub-link', linkStatus());
}

function paired() {
  try {
    const v = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    return v && typeof v.id === 'string' ? { name: String(v.name || 'Hub'), revoked: !!v.revoked } : null;
  } catch {
    return null;
  }
}

// What the Connections page shows: { available, paired: { name } | null, state }.
export function linkStatus() {
  const p = paired();
  return { available: exeThere(), paired: p ? { name: p.name } : null, state: p ? state : 'off' };
}

function run(args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const p = spawn(EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = timeoutMs ? setTimeout(() => p.kill(), timeoutMs) : null;
    p.on('error', (err) => resolve({ code: -1, out: err.message }));
    p.on('exit', (code) => {
      if (t) clearTimeout(t);
      resolve({ code, out });
    });
  });
}

// Pairs this PC with the hub named in a missioncontrol-pair: text (made on the hub's Connections page), then starts the link.
export async function pairWithHub(text) {
  if (ROLE !== 'pc') throw fail(409, 'The hub does not link to itself');
  if (typeof text !== 'string' || !/^missioncontrol-pair:[A-Za-z0-9]+:[A-Za-z0-9-]+$/.test(text.trim())) throw fail(400, 'Paste the pairing text from the hub (it starts with missioncontrol-pair:)');
  if (!exeThere()) throw fail(409, 'mc-link is not built. Run bridge\\build-bridge.bat.');
  fs.mkdirSync(LINK_DIR, { recursive: true });
  const r = await run([...EXTRA, '--state', LINK_DIR, 'pair', text.trim(), '--name', MACHINE_NAME], { timeoutMs: PAIR_TIMEOUT_MS });
  if (r.code !== 0) throw fail(502, (r.out.trim().split('\n').pop() || 'Pairing failed').slice(0, 300));
  stopLink();
  stopped = false;
  startLink();
  return linkStatus();
}

// Forgets the hub: the link stops and hub.json goes (the hub keeps this PC listed until it is removed there).
export function forgetHub() {
  stopLink();
  try { fs.rmSync(SERVER_FILE, { force: true }); } catch { /* gone */ }
  try { fs.rmSync(HUB_LINK_FILE, { force: true }); } catch { /* gone */ }
  setState('off');
  return linkStatus();
}

function stopLink() {
  stopped = true;
  if (child) {
    try { child.kill(); } catch { /* gone */ }
    child = null;
  }
}

function startLink() {
  if (stopped || child || ROLE !== 'pc' || !paired() || !exeThere()) return;
  const sec = loadOrCreateSecret({ dir: LINK_DIR, file: SECRET_FILE, label: 'hub link' });
  if (!sec.ok) {
    console.error('[hub-link]', sec.reason);
    return;
  }
  // a new build waits as mc-link.new.exe (bridge/build-bridge.bat): swap it in while no mc-link runs
  const fresh = newExe();
  if (fs.existsSync(fresh)) try { fs.renameSync(fresh, EXE); } catch (err) { console.error('[hub-link] could not swap in the new mc-link:', err.message); }
  setState('starting');
  const p = spawn(EXE, [...EXTRA, '--state', LINK_DIR, 'serve', '--port', String(PORT), '--secret-file', SECRET_FILE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('listening ')) {
        writeJson(HUB_LINK_FILE, { url: line.slice(10).trim(), headers: { 'X-MC-Link': sec.secret } });
        backoff = 2000;
        setState('connecting');
      } else if (line.startsWith('link ')) setState(line.slice(5));
    }
  });
  p.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.log(l.trim()); });
  p.on('error', (err) => console.error('[hub-link] could not start mc-link:', err.message));
  p.on('exit', (code) => {
    if (child === p) child = null;
    if (stopped) return;
    setState('off');
    console.error(`[hub-link] mc-link stopped (${code}); starting it again in ${backoff / 1000} s`);
    setTimeout(startLink, backoff).unref();
    backoff = Math.min(backoff * 2, 60e3);
  });
}

if (ROLE === 'pc') setTimeout(startLink, 1000).unref();
