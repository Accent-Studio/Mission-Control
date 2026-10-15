// "Open in Claude Desktop": finds the conversations that the Claude desktop app has open, so Mission Control does not
// resume one of them (two claude processes writing one transcript split the conversation in two).
//
// Read only. It looks at the process list (the same list the System page uses, system.js) and at the first and last
// transcript entries that sessions.js already reads. It never stops, signals or touches a process.
//
// A conversation is open in Claude Desktop when
//   a. a live desktop child has --resume=<id>, --resume <id> or --session-id <id> for it, or
//   b. a live desktop child has no id on its command line, and the conversation's FIRST transcript entry came from
//      the desktop app 0 to 180 s after that process started (a fresh app conversation writes its file right away), or
//   c. the LAST transcript entry came from the desktop app less than 10 min ago.
//
// The process list is read at most once per 15 s (cached), only when a page asks, never on a timer. MC_FAKE_PROCESSES
// names a JSON file with an array of { pid, ppid, name, exe, commandLine, startedAt } that stands in for the real list
// (tests); MC_ELSEWHERE_TTL_MS shortens the 15 s (tests).
import fs from 'node:fs';

export const WHERE = 'Claude Desktop';
export const DESKTOP_ENTRYPOINT = 'claude-desktop';

const TTL_MS = Number(process.env.MC_ELSEWHERE_TTL_MS) > 0 ? Number(process.env.MC_ELSEWHERE_TTL_MS) : 15000;
const FRESH_START_MS = 180 * 1000;
const RECENT_MS = 10 * 60 * 1000;
const ID_RE = /--(?:resume|session-id)(?:=|\s+)["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const CLI_NAME_RE = /^claude(?:\.exe)?$/i;
const DESKTOP_DIR_RE = /\\roaming\\claude\\claude-code\\/i;

// The desktop app's claude children in a process list, as { ids: [session ids], startedMs }.
// Mission Control's own children (npm\node_modules\@anthropic-ai\claude-code, parented by the runner or the server) are not.
export function desktopChildren(list) {
  const byPid = new Map();
  for (const p of list) if (p && Number.isFinite(p.pid)) byPid.set(p.pid, p);
  const out = [];
  for (const p of list) {
    if (!p || !CLI_NAME_RE.test(String(p.name || ''))) continue;
    const cmd = String(p.commandLine || '');
    const inDesktopDir = DESKTOP_DIR_RE.test(String(p.exe || '')) || DESKTOP_DIR_RE.test(cmd);
    const parent = byPid.get(p.ppid);
    // The app's own processes (and its Electron helpers, which carry --type=) are not conversations.
    const underApp = !!parent && /^claude\.exe$/i.test(String(parent.name || '')) && cmd.includes('stream-json') && !cmd.includes('--type=');
    if (!inDesktopDir && !underApp) continue;
    if (cmd.includes('--type=')) continue;
    const ids = [];
    for (const m of cmd.matchAll(ID_RE)) ids.push(m[1].toLowerCase());
    const started = Date.parse(p.startedAt);
    out.push({ ids, startedMs: Number.isFinite(started) ? started : null });
  }
  return out;
}

// { claimed: Set of session ids named on a desktop command line, loose: start times of desktop children with no id }
export function summarize(list) {
  const claimed = new Set();
  const loose = [];
  for (const c of desktopChildren(list)) {
    if (c.ids.length) for (const id of c.ids) claimed.add(id);
    else if (c.startedMs !== null) loose.push(c.startedMs);
  }
  return { claimed, loose };
}

// WHERE when the conversation is open in Claude Desktop, else null.
// conv: { id, firstEp: { entrypoint, at } | null, lastEp: { entrypoint, at } | null }
export function elsewhereOf(conv, info, now = Date.now()) {
  if (!conv) return null;
  if (!info) info = { claimed: new Set(), loose: [] }; // no process list yet: only (c), which needs none, can say yes
  if (conv.id && info.claimed.has(String(conv.id).toLowerCase())) return WHERE; // a
  const f = conv.firstEp;
  if (f && f.entrypoint === DESKTOP_ENTRYPOINT && info.loose.length) {
    const t = Date.parse(f.at);
    if (Number.isFinite(t) && info.loose.some((s) => t - s >= 0 && t - s <= FRESH_START_MS)) return WHERE; // b
  }
  const l = conv.lastEp;
  if (l && l.entrypoint === DESKTOP_ENTRYPOINT) {
    const t = Date.parse(l.at);
    if (Number.isFinite(t) && now - t < RECENT_MS) return WHERE; // c
  }
  return null;
}

// ---- The process list, read at most once per TTL ----

let snap = null; // { at, info }
let inflight = null;

async function readList() {
  if (process.env.MC_FAKE_PROCESSES) {
    const delay = Number(process.env.MC_FAKE_PROCESSES_DELAY_MS) || 0; // tests: a slow read
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const j = JSON.parse(fs.readFileSync(process.env.MC_FAKE_PROCESSES, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(j) ? j : [];
  }
  const { getProcessSnapshot } = await import('./system.js'); // loaded only when a page asks
  return getProcessSnapshot(TTL_MS);
}

const fresh = () => !!snap && Date.now() - snap.at < TTL_MS;

// One read at a time, shared by everyone who asks while it runs.
function refresh() {
  if (inflight) return inflight;
  inflight = readList()
    .then((list) => summarize(list))
    .catch(() => ({ claimed: new Set(), loose: [] })) // no list: nothing is known to be open, and the answer is kept for the TTL too
    .then((info) => {
      snap = { at: Date.now(), info };
      return info;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// For the session list, which never waits for the process list (a read takes 1 to 3 s): the newest snapshot at once
// (null before the first one), and a refresh in the background when it is older than the TTL.
export function desktopInfoNow() {
  if (!fresh()) refresh();
  return snap ? snap.info : null;
}

// For the send guard: the snapshot when it is fresh, else a refresh, waited for at most waitMs. null (the caller lets the
// message through) when the read is slower than that; it carries on in the background.
export async function desktopInfo(waitMs = 5000) {
  if (fresh()) return snap.info;
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    timer.unref();
  });
  try {
    return await Promise.race([refresh(), slow]);
  } finally {
    clearTimeout(timer);
  }
}
