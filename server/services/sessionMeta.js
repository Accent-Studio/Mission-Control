// Mission Control's own notes about sessions: a rename, a pin, a sort order, an archive flag.
// Stored in .data/sessions-meta.json as { [sessionId]: { title?, autoTitle?, pastTitles?, pinned?, order?, tags?, archived?, oneOff?, comlink?, locked?, expiryAction?, syncHidden? } }.
// `syncHidden` keeps a Sync button's commit conversation out of every list (sync.js): 'working' while it runs, 'done' after.
// One left at 'working' by a server that stopped mid-sync is shown again at the next start (showUnfinishedSyncs).
// `archived` hides the conversation from the Talk page list and the project Sessions tab until the user asks to see it.
// `locked` keeps it in the list but read only: nothing is sent to it (a message, Compact, Send later, an expiry action) until it is unlocked.
// `expiryAction` is what is sent a little before the prompt cache runs out (expiryAction.js): 'compact', 'handoff' (once, then
// it clears itself) or 'none'. Absent means the default, Compact, except for the conversations expiryFor() leaves out.
// `comlink` marks a Com Link conversation: it gets no default action.
// `mode` is the permission mode picked for the conversation, or the one it last ran with (absent: Auto): a message that names none,
// such as one from another PC or the phone, runs with it, so the mode picked for a conversation outlives a restart.
// `tags` is the manual project list ([] is a valid list: no tags); when it is absent the tags are automatic.
// The transcript files are never touched for these.
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';
import { getProject } from './catalog.js';

export const TITLE_MAX = 120;
const PAST_MAX = 6; // earlier names Claude gave a conversation, kept so the list can show them
export const EXPIRY_ACTIONS = ['handoff', 'compact'];
export const EXPIRY_CHOICES = ['none', ...EXPIRY_ACTIONS];
export const DEFAULT_EXPIRY = 'compact';
const MAX_ORDER_IDS = 1000;
const MAX_TAGS = 8;
const FILE = path.join(DATA_DIR, 'sessions-meta.json');
const MODE_RE = /^[A-Za-z]{1,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

let data = null; // { [lowercase id]: { title?, pinned?, order?, tags? } }

// A file that could not be read right now gives an empty answer that is not kept, so the next call reads again and
// save() refuses meanwhile (jsonStore.js): a moment of antivirus lock must never wipe every rename, pin and lock.
function load() {
  if (data) return data;
  const r = readJson(FILE, 'sessionMeta');
  const fresh = {};
  const parsed = r.value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [id, m] of Object.entries(parsed)) {
      const clean = sanitize(m);
      if (UUID_RE.test(id) && clean) fresh[id.toLowerCase()] = clean;
    }
  }
  if (r.ok) data = fresh;
  return fresh;
}

function sanitize(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  if (typeof m.title === 'string' && m.title.trim()) out.title = m.title.trim().slice(0, TITLE_MAX);
  if (m.pinned === true) out.pinned = true;
  if (m.archived === true) out.archived = true;
  if (m.oneOff === true) out.oneOff = true;
  if (m.comlink === true) out.comlink = true;
  if (typeof m.mode === 'string' && MODE_RE.test(m.mode)) out.mode = m.mode;
  if (m.syncHidden === 'working' || m.syncHidden === 'done') out.syncHidden = m.syncHidden;
  if (m.locked === true) out.locked = true;
  if (EXPIRY_CHOICES.includes(m.expiryAction)) out.expiryAction = m.expiryAction;
  if (typeof m.autoTitle === 'string' && m.autoTitle.trim()) out.autoTitle = m.autoTitle.trim().slice(0, TITLE_MAX);
  if (Array.isArray(m.pastTitles)) {
    const past = m.pastTitles.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, TITLE_MAX)).slice(-PAST_MAX);
    if (past.length) out.pastTitles = past;
  }
  if (Number.isFinite(m.order)) out.order = m.order;
  if (Array.isArray(m.tags)) out.tags = [...new Set(m.tags.filter((t) => typeof t === 'string' && t))].slice(0, MAX_TAGS);
  return Object.keys(out).length ? out : null;
}

function save() {
  if (!data) throw busyError(FILE);
  writeJson(FILE, data);
}

export function getAllMeta() {
  return load();
}

export function getMeta(id) {
  return load()[String(id).toLowerCase()] || null;
}

export function isArchived(id) {
  const m = getMeta(id);
  return !!(m && m.archived);
}

export function isLocked(id) {
  const m = getMeta(id);
  return !!(m && m.locked);
}

// A one-off task (Commit, Review and push, a skill chip) is never shown on claude.ai. The flag belongs to the conversation,
// so it is kept here and survives a restart of the server: any later process for the conversation honors it.
export function isOneOff(id) {
  const m = getMeta(id);
  return !!(m && m.oneOff);
}

// What is sent before this conversation's cache runs out: 'compact', 'handoff' or null (nothing). m is its entry here,
// lastEp its last transcript entry's { entrypoint } when known. With no choice of its own it gets the default, Compact,
// unless it is locked, a one-off task, a Com Link chat, or was last used in a terminal (entrypoint "cli"): a terminal may
// still hold it open, and a second process would split the conversation in two.
export function expiryFor(m, lastEp) {
  if (!m) m = {};
  if (m.locked || m.expiryAction === 'none') return null;
  if (EXPIRY_ACTIONS.includes(m.expiryAction)) return m.expiryAction;
  if (m.oneOff || m.comlink || (lastEp && lastEp.entrypoint === 'cli')) return null;
  return DEFAULT_EXPIRY;
}

// A Com Link conversation, kept on disk like the one-off flag so it survives a restart.
export function setComlink(id) {
  const all = load();
  const key = String(id).toLowerCase();
  if (!UUID_RE.test(key) || (all[key] && all[key].comlink)) return;
  all[key] = { ...(all[key] || {}), comlink: true };
  save();
}

export function modeOf(id) {
  const m = load()[String(id).toLowerCase()];
  return (m && m.mode) || null;
}
// Auto is what a conversation with no mode gets (DEFAULT_MODE in runs.js), so it is not written down: only the others are.
const UNSAVED_MODE = 'auto';
export function setMode(id, mode) {
  const all = load();
  const key = String(id).toLowerCase();
  if (!UUID_RE.test(key) || !MODE_RE.test(String(mode || ''))) return;
  const want = mode === UNSAVED_MODE ? undefined : mode;
  if ((all[key] && all[key].mode) === want) return;
  const cur = { ...(all[key] || {}) };
  if (want) cur.mode = want;
  else delete cur.mode;
  if (Object.keys(cur).length) all[key] = cur;
  else delete all[key];
  save();
}

export function setOneOff(id, on) {
  const all = load();
  const key = String(id).toLowerCase();
  if (!UUID_RE.test(key) || isOneOff(key) === !!on) return;
  const cur = { ...(all[key] || {}) };
  if (on) cur.oneOff = true;
  else delete cur.oneOff;
  if (Object.keys(cur).length) all[key] = cur;
  else delete all[key];
  save();
}

// 'working', 'done' or null (shown in the lists again).
export function setSyncHidden(id, value) {
  const all = load();
  const key = String(id).toLowerCase();
  if (!UUID_RE.test(key)) return;
  const cur = { ...(all[key] || {}) };
  if (value === 'working' || value === 'done') cur.syncHidden = value;
  else delete cur.syncHidden;
  if ((all[key] || {}).syncHidden === cur.syncHidden) return;
  if (Object.keys(cur).length) all[key] = cur;
  else delete all[key];
  save();
}

// A commit step that was still running when the server stopped: nobody knows how it ended, so it is shown again.
export function showUnfinishedSyncs() {
  const all = load();
  const ids = Object.keys(all).filter((k) => all[k].syncHidden === 'working');
  for (const k of ids) setSyncHidden(k, null);
  return ids;
}

// The short name Mission Control gave a conversation it started (autoTitle.js). A rename of my own (title) always wins
// over it, and it is set only once: a conversation that already has one keeps it. Returns true when it was stored.
// replace: true is Claude renaming its own conversation (the conversation_title tool, services/mcp.js) because the
// subject moved: the name it had is kept in pastTitles, the newest last, so the list can still show what it was called.
export function setAutoTitle(id, t, { replace = false } = {}) {
  const all = load();
  const key = String(id).toLowerCase();
  // eslint-disable-next-line no-control-regex
  const clean = typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '';
  const cur = all[key] || {};
  if (!UUID_RE.test(key) || !clean || (cur.autoTitle && !replace) || cur.autoTitle === clean) return false;
  const next = { ...cur, autoTitle: clean };
  if (cur.autoTitle) next.pastTitles = [...(cur.pastTitles || []).filter((x) => x !== cur.autoTitle && x !== clean), cur.autoTitle].slice(-PAST_MAX);
  all[key] = next;
  save();
  return true;
}

// Applies { title?: string|null, pinned?: boolean, tags?: string[]|null, archived?: boolean, locked?: boolean, expiryAction?: string|null }.
// Locking also drops the expiry action: a locked conversation is never sent anything. Returns the stored entry (or null when empty).
export function setMeta(id, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail(400, 'Body must be a JSON object');
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const hasTitle = has('title');
  const hasPinned = has('pinned');
  const hasTags = has('tags');
  const hasArchived = has('archived');
  const hasLocked = has('locked');
  const hasAction = has('expiryAction');
  if (!hasTitle && !hasPinned && !hasTags && !hasArchived && !hasLocked && !hasAction) throw fail(400, 'Give title, pinned, tags, archived, locked and/or expiryAction');
  if (hasArchived && typeof patch.archived !== 'boolean') throw fail(400, 'archived must be true or false');
  if (hasLocked && typeof patch.locked !== 'boolean') throw fail(400, 'locked must be true or false');
  if (hasAction && patch.expiryAction !== null && !EXPIRY_CHOICES.includes(patch.expiryAction)) throw fail(400, `expiryAction must be ${EXPIRY_CHOICES.join(', ')} or null`);

  let title;
  if (hasTitle) {
    if (patch.title === null) title = null;
    else if (typeof patch.title === 'string') {
      // eslint-disable-next-line no-control-regex
      const t = patch.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) throw fail(400, 'title must not be empty (send null to clear it)');
      if (t.length > TITLE_MAX) throw fail(400, `title is longer than ${TITLE_MAX} characters`);
      title = t;
    } else throw fail(400, 'title must be a string or null');
  }
  if (hasPinned && typeof patch.pinned !== 'boolean') throw fail(400, 'pinned must be true or false');

  // null returns to the automatic tags; a list (also an empty one) replaces them.
  let tags;
  if (hasTags) {
    if (patch.tags === null) tags = null;
    else if (Array.isArray(patch.tags)) {
      if (patch.tags.length > MAX_TAGS) throw fail(400, `at most ${MAX_TAGS} tags`);
      tags = [];
      for (const t of patch.tags) {
        if (typeof t !== 'string' || !getProject(t)) throw fail(400, 'tags must be project ids from the catalog');
        if (!tags.includes(t)) tags.push(t);
      }
    } else throw fail(400, 'tags must be an array of project ids or null');
  }

  const all = load();
  const key = String(id).toLowerCase();
  const cur = { ...(all[key] || {}) };
  if (hasTitle) {
    if (title === null) delete cur.title;
    else cur.title = title;
  }
  if (hasPinned) {
    if (patch.pinned) cur.pinned = true;
    else delete cur.pinned;
  }
  if (hasArchived) {
    if (patch.archived) cur.archived = true;
    else delete cur.archived;
  }
  if (hasTags) {
    if (tags === null) delete cur.tags;
    else cur.tags = tags;
  }
  if (hasLocked) {
    if (patch.locked) cur.locked = true;
    else delete cur.locked;
  }
  if (hasAction) {
    if (EXPIRY_ACTIONS.includes(patch.expiryAction) && cur.locked) throw fail(409, 'This conversation is locked. Unlock it first.');
    if (patch.expiryAction) cur.expiryAction = patch.expiryAction;
    else delete cur.expiryAction;
  }
  if (cur.locked) delete cur.expiryAction;
  if (Object.keys(cur).length) all[key] = cur;
  else delete all[key];
  save();
  return all[key] || null;
}

// Sets the order of the given sessions to their position in the list. Sessions that already had an
// order and are not in the list keep their relative order and follow after the listed ones.
export function setOrder(ids) {
  if (!Array.isArray(ids)) throw fail(400, 'ids must be an array');
  if (ids.length > MAX_ORDER_IDS) throw fail(400, `at most ${MAX_ORDER_IDS} ids`);
  const wanted = [];
  const seen = new Set();
  for (const raw of ids) {
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw fail(400, 'ids must be session uuids');
    const id = raw.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      wanted.push(id);
    }
  }
  const all = load();
  const rest = Object.keys(all)
    .filter((id) => !seen.has(id) && Number.isFinite(all[id].order))
    .sort((a, b) => all[a].order - all[b].order);
  [...wanted, ...rest].forEach((id, i) => {
    all[id] = { ...(all[id] || {}), order: i };
  });
  save();
}

export function removeMeta(id) {
  const all = load();
  const key = String(id).toLowerCase();
  if (!all[key]) return;
  delete all[key];
  save();
}
