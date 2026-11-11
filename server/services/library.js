// A project's library for the Docs and Screenshots tabs: its text files and its pictures, as folder trees.
// Two kinds of root: the project folder itself (id "p"), and its notes folders (ids "n0", "n1", ...): the ones listed in
// NOTES_FOLDERS, plus a folder named like the project in NOTES_PROJECT_DIR (see config.js). The lists are cached for a minute.
// In the project folder the Docs tab lists documents (DOC_EXT); in a notes folder it lists every text file (isNoteText).
//
// A project of the PC this one is linked to (services/pcLink.js) has a library too: that PC names the notes folders of
// each of its projects in its project list (sharedNotes), and this PC reads them from the hub's mirror of its vault
// (services/notesHub.js), so they show while that PC is off. Its project folder stays on that PC.
//
// The notes folders can be edited (the Documents panel's edit mode): this machine's own on disk (the notes sync takes the
// change up to the hub), another machine's on that machine over the link while it is on, else in the hub's copy.
import fs from 'node:fs';
import path from 'node:path';
import { NOTES_FOLDERS, NOTES_PROJECT_DIR, NOTES_REPOS, NOTES_ROOT } from '../config.js';
import { hubCall } from './hubSync.js';
import { pcCall, pcName, pcOnline } from './pcLink.js';
import { prefixBody, unprefixAnswer } from '../lib/noteOps.js';

const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
// In a notes folder every file is text but these (and dot files, and files over TEXT_MAX).
const NOT_TEXT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.avif', '.psd',
  '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.exr', '.hdr', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.ods', '.odp', '.key', '.pages', '.numbers', '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.mp3', '.wav',
  '.flac', '.ogg', '.m4a', '.aac', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.exe', '.dll',
  '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib', '.pdb', '.class', '.jar', '.pyc', '.wasm', '.apk', '.msi', '.dmg', '.iso',
  '.db', '.sqlite', '.sqlite3', '.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.onnx', '.npy', '.npz', '.pkl', '.parquet', '.blend',
  '.fbx', '.glb', '.uasset', '.umap', '.lnk']);
export const TEXT_MAX = 5 * 1024 * 1024;
export const isNoteText = (name) => !!name && !name.startsWith('.') && !NOT_TEXT_EXT.has(path.extname(name).toLowerCase());
// Folders never walked: build output, caches, dependencies, and the app's own data.
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.data', '.astro', '.venv', '__pycache__', 'venv',
  'python_embeded', 'models', 'temp', '.cache', 'custom_nodes', '.godot', '.import', '.obsidian', '.trash', 'vendor', 'third_party',
  'site-packages', 'bower_components', '.next', '.svelte-kit', 'coverage', 'out', 'bin', 'obj', 'gen', 'Binaries', 'Intermediate',
  'DerivedDataCache', 'Saved', 'Content', 'profile']);
// Picture folders that hold app parts or caches, not screenshots or references.
const SKIP_IMAGES = new Set(['imgcache', 'uploads', 'cache', 'thumbs', 'thumbnails', 'icons', 'icon', 'textures', 'fonts', 'res', 'assets',
  'sprites', 'favicon', 'favicons']);
const isSkippedImageDir = (name) => SKIP_IMAGES.has(name.toLowerCase()) || /^mipmap-|^drawable/i.test(name);
// Text files that are not notes.
const NOT_DOCS = /^(cmakelists|requirements[\w.-]*|license[\w.-]*|licence[\w.-]*|notice[\w.-]*|third[-_]party[\w.-]*|robots|llms|version)\.txt$/i;
const MAX = { docs: 600, images: 6000 };
const BUDGET = 80000;
const DEPTH = 10;
const TTL_MS = 60000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The notes folders of a project (absolute paths that exist), the listed ones first.
export function notesFolders(project) {
  if (!NOTES_ROOT || !project) return [];
  const rel = (NOTES_FOLDERS[project.id] || []).filter((s) => !REMOTE_RE.test(s)); // another machine's: remoteNotesFolders
  try {
    const want = new Set([norm(project.name), norm(project.id), norm(path.basename(project.folder || ''))].filter(Boolean));
    const dir = NOTES_PROJECT_DIR.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    for (const e of fs.readdirSync(path.join(NOTES_ROOT, ...(dir ? dir.split('/') : [])), { withFileTypes: true })) {
      if (e.isDirectory() && want.has(norm(e.name))) rel.push(dir ? dir + '/' + e.name : e.name);
    }
  } catch {
    // no notes folder on this machine
  }
  const out = [];
  const seen = new Set();
  for (const r of rel) {
    const abs = path.resolve(NOTES_ROOT, ...r.split('/'));
    const key = abs.toLowerCase();
    if (seen.has(key) || !abs.toLowerCase().startsWith(path.resolve(NOTES_ROOT).toLowerCase() + path.sep)) continue;
    // a listed folder inside another listed one would show twice
    if ([...seen].some((s) => key.startsWith(s + path.sep))) continue;
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(key);
    out.push({ abs, rel: r });
  }
  return out;
}

// Notes folders that live in another machine's vault, read from its mirror on the hub (services/notesHub.js): an entry
// "Home:01-Acme" in NOTES_FOLDERS is the folder 01-Acme of Home's vault. [{ owner, folder }]
const REMOTE_RE = /^([A-Za-z][\w -]{1,39}):(.*)$/; // a machine name, never a drive letter
export function remoteNotesFolders(project) {
  if (!project) return [];
  const out = [];
  for (const s of NOTES_FOLDERS[project.id] || []) {
    const m = REMOTE_RE.exec(s);
    if (m) out.push({ owner: m[1].trim(), folder: m[2].replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') });
  }
  return out;
}

// The roots of a project: [{ id, label, folder } or { id, label, remote: { owner, folder } }]. The project folder is "p".
export function libraryRoots(project) {
  const roots = [{ id: 'p', label: path.basename(project.folder) || project.name, folder: project.folder }];
  notesFolders(project).forEach((n, i) => roots.push({ id: 'n' + i, label: 'Notes: ' + n.rel, folder: n.abs }));
  remoteNotesFolders(project).forEach((r, i) => roots.push({ id: 'r' + i, label: `Notes on ${r.owner}: ${r.folder || 'all'}`, remote: r }));
  return roots;
}

// What this PC tells a linked PC about a project's notes (in GET /api/projects): each notes folder that is inside a vault
// the hub mirrors, as { repo, folder }, the folder relative to the vault. A folder in no such vault stays private.
export function sharedNotes(project) {
  const repos = NOTES_REPOS.slice().sort((a, b) => b.dir.length - a.dir.length); // a vault inside another one first
  const out = [];
  for (const n of notesFolders(project)) {
    const key = n.abs.toLowerCase();
    const r = repos.find((x) => key === x.dir.toLowerCase() || key.startsWith(x.dir.toLowerCase() + path.sep));
    if (r) out.push({ repo: r.id, folder: path.relative(r.dir, n.abs).split(path.sep).join('/') });
  }
  return out;
}

// The roots of a linked PC's project, from the notes it shared (sharedNotes there): read from the hub.
function linkedRoots(owner, notes) {
  return (notes || []).map((n, i) => ({ id: 'r' + i, label: `Notes on ${owner}: ${n.folder || 'all'}`, remote: { owner, repo: n.repo, folder: n.folder } }));
}

// That PC's list names no notes for the project (its Mission Control predates sharedNotes, or it names none): the hub's
// copy of its vault is read instead, for a top folder named like the project, a leading number left out ("01-Acme" for
// "Acme-Shop": the whole name, its id, or its first word). Kept a minute.
const GUESS_MS = 60e3;
const guesses = new Map(); // owner + project id -> { at, notes }
async function guessNotes(owner, project) {
  const key = owner + '\n' + project.id;
  const g = guesses.get(key);
  if (g && Date.now() - g.at < GUESS_MS) return g.notes;
  let r;
  try {
    r = await hubCall('GET', hubPath({ owner, repo: 'notes' }, 'list'), { query: { folder: '' } });
  } catch {
    return [];
  }
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.files)) return [];
  const first = String(project.name || '').split(/[^A-Za-z0-9]+/).filter(Boolean)[0];
  const want = new Set([norm(project.name), norm(project.id), norm(first)].filter((s) => s.length >= 3));
  const tops = new Set(r.json.files.map((f) => String(f.path).split('/')).filter((p) => p.length > 1).map((p) => p[0]));
  const notes = [...tops].filter((d) => want.has(norm(d.replace(/^\d+[-_ .]*/, '')))).sort().map((d) => ({ repo: 'notes', folder: d }));
  guesses.set(key, { at: Date.now(), notes });
  return notes;
}

// The roots of a project of the linked PC (its entry in that PC's project list)
export async function linkedRootsOf(owner, project) {
  const shared = Array.isArray(project.notes) ? project.notes : [];
  return linkedRoots(owner, shared.length ? shared : await guessNotes(owner, project));
}

export function rootFolder(project, id) {
  if (!id || id === 'p') return project.folder;
  const r = libraryRoots(project).find((x) => x.id === id);
  return r && r.folder ? r.folder : null;
}

export function rootRemote(project, id) {
  const r = id && libraryRoots(project).find((x) => x.id === id);
  return r && r.remote ? r.remote : null;
}

const hubPath = (remote, what) => `/api/hub/notes/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo || 'notes')}/${what}`;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const cleanRel = (rel) => {
  const clean = String(rel || '').replace(/\\/g, '/');
  return !clean || clean.split('/').some((p) => p === '..' || !p) ? null : clean;
};
const inVault = (remote, clean) => (remote.folder ? remote.folder + '/' + clean : clean);
// The owner of a remote notes folder is the PC this one is linked to, and the link is up: its own copy is read and edited
// there (routes/notes.js), the hub's only while it is off or does not answer.
const ownerOnline = (remote) => pcOnline() && String(pcName() || '').toLowerCase() === String(remote.owner || '').toLowerCase();
const vaultPath = (remote, what) => `/api/notes/${encodeURIComponent(remote.repo || 'notes')}/${what}`;
// what the owner says, unless it says nothing useful (a Mission Control too old for these routes answers 404 too)
const ownerAnswered = (r) => r && r.status !== 404 && r.status < 500;

// One file of a remote notes folder: { buf, type, from } or { error, status }. from: "pc" or "hub".
export async function remoteNoteFile(remote, rel) {
  const clean = cleanRel(rel);
  if (!clean) return { status: 404, error: 'File not found' };
  const ext = path.extname(clean).toLowerCase();
  const type = IMAGE_TYPES[ext] || (isNoteText(path.basename(clean)) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  if (ownerOnline(remote)) {
    try {
      const r = await pcCall('GET', vaultPath(remote, 'file') + '?path=' + encodeURIComponent(inVault(remote, clean)), { buffer: true, timeout: 8000 });
      if (r.status === 200) return { buf: r.buf, type, from: 'pc' };
      if (ownerAnswered(r)) return { status: r.status, error: 'File not found' };
    } catch {
      // the hub's copy, below
    }
  }
  let r;
  try {
    r = await hubCall('GET', hubPath(remote, 'file'), { query: { path: inVault(remote, clean) } });
  } catch {
    return { status: 503, error: 'The hub cannot be reached' };
  }
  if (r.status !== 200) return { status: r.status, error: (r.json && r.json.error) || 'File not found' };
  return { buf: r.buf, type, from: 'hub' };
}

// Saves an edit of a note of a remote notes folder: on its owner while the link is up, else in the hub's copy (the hub
// commits it, the owner takes it at its next sync). { status, json }: json { hash, saved: "pc" | "hub" }, or on a 409
// { conflict, text, hash } (the note changed since the editor opened it).
export async function saveRemoteNote(remote, rel, edit) {
  const clean = cleanRel(rel);
  if (!clean || !isNoteText(path.basename(clean))) return { status: 403, json: { error: 'This file cannot be edited here' } };
  const body = { text: edit.text, base: edit.base };
  if (ownerOnline(remote)) {
    try {
      const r = await pcCall('PUT', vaultPath(remote, 'file') + '?path=' + encodeURIComponent(inVault(remote, clean)), { json: body, timeout: 20e3 });
      if (r.status === 200 && r.json) return { status: 200, json: { ...r.json, saved: 'pc', owner: remote.owner } };
      if (ownerAnswered(r)) return { status: r.status, json: r.json || { error: 'The other PC did not save it' } };
    } catch {
      // the hub's copy, below
    }
  }
  let r;
  try {
    r = await hubCall('PUT', hubPath(remote, 'file'), { query: { path: inVault(remote, clean) }, json: body });
  } catch {
    return { status: 503, json: { error: 'Neither the other PC nor the hub can be reached' } };
  }
  return { status: r.status, json: r.status === 200 ? { ...(r.json || {}), saved: 'hub', owner: remote.owner } : r.json || { error: 'The hub did not save it' } };
}

// A file action of the Documents panel (lib/noteOps.js) in a remote notes folder: on its owner over the link. The hub's
// copy takes edits of a note, but making, moving and deleting files waits for the owner to be on.
export async function remoteNoteOp(remote, body) {
  const off = { status: 409, json: { error: `${remote.owner || 'The other PC'} is off. Its notes can be edited now, but new, moved, renamed or deleted files need it on.` } };
  if (!ownerOnline(remote)) return off;
  let r;
  try {
    r = await pcCall('POST', vaultPath(remote, 'op'), { json: prefixBody(body, remote.folder), timeout: 30e3 });
  } catch {
    return off; // the link has not noticed yet
  }
  if (r.status === 404 && !(r.json && r.json.error)) return { status: 409, json: { error: `${remote.owner || 'The other PC'} needs a newer Mission Control for this` } };
  return { status: r.status, json: unprefixAnswer(r.json || { error: 'No answer' }, remote.folder) };
}

// ---- This machine's own vaults, for a linked PC (routes/notes.js) ----

// A note of vault `repo` (an id of NOTES_REPOS): its absolute path, or { error, status }. A linked computer never reaches
// the vault's Home only folders (.mc-notes.json, as on the hub); a phone does.
export function vaultNote(repo, rel, { computer = false } = {}) {
  const v = NOTES_REPOS.find((x) => x.id === repo);
  const clean = cleanRel(rel);
  if (!v || !clean) return { status: 404, error: 'No such note' };
  const parts = clean.split('/');
  if (parts.some((p) => p.startsWith('.') && p !== '.mc-notes.json') || parts.some((p) => /[. ]$/.test(p))) return { status: 403, error: 'That file is not shared' };
  if (computer && parts.length > 1 && homeOnly(v.dir).has(parts[0].toLowerCase())) return { status: 403, error: 'That folder is not shared with this computer' };
  const abs = path.resolve(v.dir, ...parts);
  if (!abs.toLowerCase().startsWith(path.resolve(v.dir).toLowerCase() + path.sep)) return { status: 403, error: 'That file is not shared' };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { status: 404, error: 'No such note' };
  }
  if (!st.isFile()) return { status: 404, error: 'No such note' };
  return { abs, size: st.size };
}

// A vault of this machine for a file action from a linked PC: { dir, guard } (the Home only folders refused for a
// computer, as in vaultNote), or null
export function vaultForOps(repo, { computer = false } = {}) {
  const v = NOTES_REPOS.find((x) => x.id === repo);
  if (!v) return null;
  const home = computer ? homeOnly(v.dir) : new Set();
  return { dir: v.dir, guard: (parts) => (parts.length && home.has(parts[0].toLowerCase()) ? 'That folder is not shared with this computer' : null) };
}

function homeOnly(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, '.mc-notes.json'), 'utf8'));
    return new Set((Array.isArray(v.homeOnly) ? v.homeOnly : []).filter((s) => typeof s === 'string').map((s) => s.toLowerCase()));
  } catch {
    return new Set();
  }
}

// The files of a remote notes folder of the right kind, as walk() gives them.
async function walkRemote(remote, kind, out) {
  let r;
  try {
    r = await hubCall('GET', hubPath(remote, 'list'), { query: { folder: remote.folder } });
  } catch {
    return false;
  }
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.files)) return false;
  for (const f of r.json.files) {
    if (out.length >= MAX[kind]) break;
    const parts = String(f.path).split('/');
    const name = parts[parts.length - 1];
    if (!(kind === 'docs' ? isNoteText(name) && f.size <= TEXT_MAX : IMAGE_EXT.has(path.extname(name).toLowerCase()))) continue;
    if (kind === 'docs' && NOT_DOCS.test(name)) continue;
    if (parts.slice(0, -1).some((d) => SKIP.has(d) || (kind === 'images' && isSkippedImageDir(d)))) continue;
    out.push({ path: f.path, size: f.size, mtime: f.mtime });
  }
  return true;
}

// anyText: a notes folder, where the Docs tab lists every text file. dirsOut: every folder walked there is listed too
// (an empty one shows in the tree, and a new folder can be dropped on)
const DIRS_MAX = 2000;
async function walk(root, kind, out, budget, anyText, dirsOut) {
  const want = kind === 'docs' ? DOC_EXT : IMAGE_EXT;
  const wanted = (name) => (kind === 'docs' && anyText ? isNoteText(name) : want.has(path.extname(name).toLowerCase()));
  async function go(dir, rel, depth) {
    if (depth > DEPTH || budget.n <= 0 || out.length >= MAX[kind]) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (--budget.n <= 0) break;
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || (kind === 'images' && isSkippedImageDir(e.name))) continue;
        dirs.push(e.name);
      } else if (e.isFile() && wanted(e.name)) {
        if (kind === 'docs' && NOT_DOCS.test(e.name)) continue;
        files.push(e.name);
      }
    }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(dir, f)).catch(() => null)));
    files.forEach((f, i) => {
      const st = stats[i];
      if (st && out.length < MAX[kind] && !(anyText && kind === 'docs' && st.size > TEXT_MAX)) out.push({ path: rel ? rel + '/' + f : f, size: st.size, mtime: st.mtime.toISOString() });
    });
    for (const d of dirs) {
      const sub = rel ? rel + '/' + d : d;
      if (dirsOut && dirsOut.length < DIRS_MAX && depth < DEPTH) dirsOut.push(sub);
      await go(path.join(dir, d), sub, depth + 1);
    }
  }
  await go(root, '', 0);
}

const cache = new Map(); // project id + kind -> { at, value, pending }

// { roots: [{id, label}], files: [{root, path, size, mtime}], cut } for kind "docs" or "images".
export function projectLibrary(project, kind, opts) {
  return library(project.id, libraryRoots(project), kind, opts);
}

// The same for a project of the linked PC (its entry in that PC's project list), from the hub (linkedRootsOf).
export async function linkedLibrary(owner, project, kind, opts) {
  return library('pc:' + project.id, await linkedRootsOf(owner, project), kind, opts);
}

function library(id, roots, kind, { fresh = false } = {}) {
  const key = id + ':' + kind;
  const e = cache.get(key);
  if (e && !fresh && e.value && Date.now() - e.at < TTL_MS) return Promise.resolve(e.value);
  if (e && e.pending) return e.pending;
  const entry = e || {};
  cache.set(key, entry);
  entry.pending = (async () => {
    const files = [];
    const dirs = [];
    let cut = false;
    for (const r of roots) {
      const out = [];
      if (r.remote) {
        await walkRemote(r.remote, kind, out);
        for (const f of out) files.push({ root: r.id, ...f });
        continue;
      }
      const budget = { n: BUDGET };
      const ds = kind === 'docs' && r.id !== 'p' ? [] : null;
      await walk(r.folder, kind, out, budget, r.id !== 'p', ds);
      if (ds) for (const d of ds) dirs.push({ root: r.id, path: d });
      if (budget.n <= 0 || out.length >= MAX[kind]) cut = true;
      for (const f of out) files.push({ root: r.id, ...f });
    }
    // a root's place: here (its files can be made, moved and deleted here) or on another PC (over the link)
    const value = { roots: roots.map(({ id, label, remote }) => ({ id, label, ...(id === 'p' ? { readOnly: true } : remote ? { remote: true } : {}) })), files, dirs, cut };
    entry.value = value;
    entry.at = Date.now();
    return value;
  })().finally(() => {
    entry.pending = null;
  });
  return entry.pending;
}

export function clearLibraryCache() {
  cache.clear();
}

// An .html note shown as a page (GET .../file?view=page) runs in a sandbox of its own: it reaches neither Mission Control
// nor the network. Storage throws there, so a page that keeps its choices in localStorage gets one in memory instead.
export const PAGE_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox; default-src 'none'; "
  + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
const STORAGE_SHIM = '<script>(function(){function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},'
  + 'setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},'
  + "get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){"
  + 'try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}})})()</script>';
export const isPage = (rel) => /\.html?$/i.test(String(rel || ''));
export function asPage(buf) {
  const html = buf.toString('utf8');
  const m = /<head(\s[^>]*)?>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  const at = m ? m.index + m[0].length : 0;
  return Buffer.from(html.slice(0, at) + STORAGE_SHIM + html.slice(at), 'utf8');
}
