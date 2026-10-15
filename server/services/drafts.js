// The Talk page's unsent message box, shared by every device: what is typed and the files attached (their upload ids), per
// conversation (or "new" for a new one), until it is sent. A phone can attach screenshots and the PC go on typing.
// Kept in .data/drafts.json. The last write wins; each write gets a number (rev) and an event, so the other open pages take it
// when they have no unsaved typing of their own. Drafts unchanged for 7 days are dropped (their uploads are gone by then).
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { publish } from '../lib/events.js';
import { readJson, writeJson, busyError } from '../lib/jsonStore.js';

const FILE = path.join(DATA_DIR, 'drafts.json');
const KEEP_MS = 7 * 864e5;
const MAX_TEXT = 200000; // a longer text is refused, not cut, so the page and the server never disagree
const MAX_ATTS = 10;
const MAX_DRAFTS = 300;
// a conversation id, or a new conversation not sent yet: "n-<random id>" (one per new conversation), or the older single "new"
const KEY_RE = /^(new|(n-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const isNewKey = (k) => k === 'new' || /^n-/i.test(k);
const PROJECT_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const UPLOAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let drafts = null; // key -> { text, atts: [{ id, name, kind, size }], at, rev }
let rev = 0;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// A file that could not be read right now gives an empty answer that is not kept: the next call reads again, and save()
// refuses meanwhile, so unsent drafts are never written over (jsonStore.js).
function load() {
  if (drafts) return drafts;
  const r = readJson(FILE, 'drafts');
  const o = r.value;
  const fresh = o && typeof o.drafts === 'object' && o.drafts && !Array.isArray(o.drafts) ? o.drafts : {};
  if (!r.ok) return {};
  drafts = fresh;
  rev = Number(o && o.rev) || 0;
  const now = Date.now();
  for (const k of Object.keys(drafts)) {
    const d = drafts[k];
    if (!d || !(now - d.at < KEEP_MS)) delete drafts[k];
    // a sent or thrown away new conversation leaves an empty draft: kept a day, so every device clears, then gone
    else if (isNewKey(k) && !String(d.text || '').trim() && !(d.atts || []).length && now - d.at > 864e5) delete drafts[k];
  }
  return drafts;
}

function save() {
  if (!drafts) throw busyError(FILE);
  try {
    writeJson(FILE, { rev, drafts }, { pretty: false });
  } catch (err) {
    console.error('[drafts] could not save drafts.json:', err.message);
  }
}

// Uploads are kept 7 days from when they were sent (uploads.js), so a file stays in a draft a little less than that.
const FILE_KEEP_MS = 6.5 * 864e5;
const liveAtts = (atts) => (atts || []).filter((a) => a && Date.now() - (a.added || 0) < FILE_KEEP_MS);

export function getDraft(key) {
  if (!KEY_RE.test(String(key || ''))) throw fail(400, 'key must be a conversation id or a new conversation draft (n-<id>)');
  const d = load()[key];
  if (!d || !(Date.now() - d.at < KEEP_MS)) return { key, text: '', atts: [], at: 0, rev: d ? d.rev : 0 };
  return { key, text: d.text, atts: liveAtts(d.atts).map(({ added, ...a }) => a), at: d.at, rev: d.rev, ...(d.project !== undefined ? { project: d.project } : {}) };
}

// The new conversations that have words or files but were never sent, newest first, for the Talk page's list.
export function listNewDrafts() {
  const all = load();
  return Object.keys(all)
    .filter((k) => isNewKey(k) && all[k] && Date.now() - all[k].at < KEEP_MS && (String(all[k].text || '').trim() || liveAtts(all[k].atts).length))
    .map((k) => ({ key: k, preview: String(all[k].text || '').replace(/\s+/g, ' ').trim().slice(0, 140), files: liveAtts(all[k].atts).length, project: all[k].project || '', at: all[k].at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
}

// body: { key, text, atts, tab } (tab: the page that wrote it, so it can skip its own echo)
export function putDraft(body) {
  const b = body && typeof body === 'object' ? body : {};
  const key = String(b.key || '');
  if (!KEY_RE.test(key)) throw fail(400, 'key must be a conversation id or a new conversation draft (n-<id>)');
  if (b.text !== undefined && typeof b.text !== 'string') throw fail(400, 'text must be a string');
  const text = String(b.text || '');
  if (text.length > MAX_TEXT) throw fail(413, 'The message is too long to keep as a draft');
  if (b.atts !== undefined && !Array.isArray(b.atts)) throw fail(400, 'atts must be a list');
  const atts = (b.atts || []).slice(0, MAX_ATTS).filter((a) => a && UPLOAD_RE.test(String(a.id))).map((a) => ({
    id: String(a.id),
    name: String(a.name || 'file').slice(0, 200),
    kind: ['image', 'pdf', 'file'].includes(a.kind) ? a.kind : 'file',
    size: Number.isFinite(Number(a.size)) ? Math.max(0, Number(a.size)) : 0,
  }));
  const all = load();
  // a file keeps the time it first joined this draft (a later edit of the words does not make it younger)
  const before = new Map(((all[key] && all[key].atts) || []).map((a) => [a.id, a.added]));
  for (const a of atts) a.added = before.get(a.id) || Date.now();
  rev += 1;
  // the project picked for a new conversation travels with its draft ('' is No project); a save without it keeps the one before
  let project = all[key] ? all[key].project : undefined;
  if (b.project !== undefined && b.project !== null) {
    if (typeof b.project !== 'string' || (b.project !== '' && !PROJECT_RE.test(b.project))) throw fail(400, 'project must be a project id');
    project = b.project;
  }
  // an emptied draft (sent, or cleared) is kept empty with its number, so a device still showing the old words clears too
  all[key] = { text: text.trim() || atts.length ? text : '', atts, at: Date.now(), rev, ...(project !== undefined ? { project } : {}) };
  const keys = Object.keys(all);
  if (keys.length > MAX_DRAFTS) keys.sort((x, y) => all[x].at - all[y].at).slice(0, keys.length - MAX_DRAFTS).forEach((k) => delete all[k]);
  save();
  const tab = typeof b.tab === 'string' ? b.tab.slice(0, 60) : '';
  publish('draft', { key, rev, tab });
  return { key, rev };
}
