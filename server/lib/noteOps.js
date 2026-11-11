// The file actions of the Documents panel in a notes folder: a new note or folder, rename, move (drag and drop),
// duplicate, delete. One notes folder is one root (an absolute folder); every path is relative to it, with "/".
// The project folder never comes here: it stays read only.
//
// noteOp(root, body, opts) -> { status: 200, json } or { status, json: { error } }
//   { op: 'note',      dir, name }      a new empty note dir/name (".md" added when the name has no extension)
//   { op: 'folder',    dir, name }      a new folder
//   { op: 'rename',    path, name }     in the same folder; a note keeps its extension when the new name has none
//   { op: 'move',      paths, to }      into the folder `to` ('' is the top); opts.toRoot: into another root of this PC
//   { op: 'duplicate', path }           "name copy.md", "name copy 2.md" ... next to it
//   { op: 'delete',    paths }          to the Recycle Bin (lib/recycle.js)
// The answer names what changed: { path } or { paths }, and { changed: [absolute paths] } for the notes sync.
// opts.guard(parts) may refuse a path (a Home only folder for a linked computer): it returns an error text or null.
import fs from 'node:fs';
import path from 'node:path';
import { recycle } from './recycle.js';

const NAME_MAX = 120;
const BAD_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const BLOCKED = /^(\.git|\.obsidian|\.trash|node_modules)$/i;
const MAX_PATHS = 200;

const fail = (status, error) => ({ status, json: { error } });

// A file or folder name typed by the user: the clean name, or { error }
export function checkName(name) {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!n) return { error: 'Give it a name' };
  if (n.length > NAME_MAX) return { error: `A name has at most ${NAME_MAX} characters` };
  if (BAD_CHARS.test(n)) return { error: 'A name cannot hold / \\ : * ? " < > |' };
  if (n.startsWith('.')) return { error: 'A name cannot start with a dot' };
  if (/[. ]$/.test(n)) return { error: 'A name cannot end with a dot' };
  if (RESERVED.test(n)) return { error: 'Windows keeps that name for itself' };
  return { name: n };
}

// A path in the root as its parts, or null. '' (the top) is [] when allowTop.
function parts(rel, allowTop) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return allowTop ? [] : null;
  if (s.length > 1024) return null;
  const p = s.split('/');
  if (p.some((x) => !x || x === '.' || x === '..' || x.startsWith('.') || /[. ]$/.test(x) || BAD_CHARS.test(x) || BLOCKED.test(x))) return null;
  return p;
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const exists = (abs) => { try { fs.lstatSync(abs); return true; } catch { return false; } };
const kindOf = (abs) => { try { const st = fs.lstatSync(abs); return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null; } catch { return null; } };

// A free name in `dir` for `base` + `ext`: "base ext", then "base 2 ext", "base 3 ext" ...
function freeName(dir, base, ext, first) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 && first !== false ? base + ext : `${base} ${n === 1 ? 2 : n}${ext}`;
    if (!exists(path.join(dir, name))) return name;
  }
  return null;
}

// The extension of a name, only when it looks like one ("v1.2 plan" has none): ".md"
const extOf = (name) => { const e = path.extname(name); return /^\.[A-Za-z0-9]{1,8}$/.test(e) && e !== name ? e : ''; };
// "Notes.md" -> ["Notes", ".md"]; a folder or a name with no extension -> [name, '']
const split = (name, isDir) => { const ext = isDir ? '' : extOf(name); return [ext ? name.slice(0, -ext.length) : name, ext]; };

// The root as it really is (links followed), and a path inside it, or null when it would leave the root
function inside(root, p) {
  const abs = path.resolve(root, ...p);
  const rel = path.relative(path.resolve(root), abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}
const relOf = (root, abs) => path.relative(path.resolve(root), abs).split(path.sep).join('/');

export async function noteOp(root, body, { guard = null, toRoot = null } = {}) {
  if (!root || kindOf(root) !== 'dir') return fail(404, 'This notes folder is not on this computer');
  const b = body && typeof body === 'object' ? body : {};
  const check = (p) => (guard ? guard(p) : null);
  // an existing file or folder of the root: { p, abs, kind } or an answer
  const source = (rel) => {
    const p = parts(rel, false);
    if (!p) return fail(400, 'That path cannot be used');
    const why = check(p); if (why) return fail(403, why);
    const abs = inside(root, p); const kind = abs && kindOf(abs);
    if (!kind) return fail(404, 'It is not there any more');
    return { p, abs, kind };
  };
  const folder = (base, rel) => {
    const p = parts(rel, true);
    if (!p) return fail(400, 'That folder cannot be used');
    if (p.length) { const why = check(p); if (why) return fail(403, why); }
    const abs = inside(base, p);
    if (!abs || kindOf(abs) !== 'dir') return fail(404, 'That folder is not there any more');
    return { p, abs };
  };

  switch (b.op) {
    case 'note':
    case 'folder': {
      const d = folder(root, b.dir); if (d.status) return d;
      const c = checkName(b.name); if (c.error) return fail(400, c.error);
      const isDir = b.op === 'folder';
      const name = isDir || extOf(c.name) ? c.name : c.name + '.md';
      if (exists(path.join(d.abs, name))) return fail(409, `There is already a ${isDir ? 'folder' : 'note'} called "${name}" here`);
      const abs = path.join(d.abs, name);
      try {
        if (isDir) fs.mkdirSync(abs);
        else fs.writeFileSync(abs, '', { flag: 'wx' });
      } catch (e) {
        return fail(500, `Could not make it: ${e.code || e.message}`);
      }
      return { status: 200, json: { path: relOf(root, abs), changed: [abs] } };
    }
    case 'rename': {
      const s = source(b.path); if (s.status) return s;
      const c = checkName(b.name); if (c.error) return fail(400, c.error);
      const old = s.p[s.p.length - 1];
      let name = c.name;
      if (s.kind === 'file' && !extOf(name) && extOf(old)) name += extOf(old); // "Plan" for "Plan.md"
      if (name === old) return { status: 200, json: { path: s.p.join('/'), changed: [] } };
      const to = path.join(path.dirname(s.abs), name);
      if (exists(to) && !sameName(name, old)) return fail(409, `There is already something called "${name}" in that folder`);
      try {
        fs.renameSync(s.abs, to);
      } catch (e) {
        return fail(500, `Could not rename it: ${e.code || e.message}`);
      }
      return { status: 200, json: { path: relOf(root, to), changed: [s.abs, to] } };
    }
    case 'move': {
      const list = Array.isArray(b.paths) ? b.paths.slice(0, MAX_PATHS) : [];
      if (!list.length) return fail(400, 'Nothing to move');
      const destRoot = toRoot || root;
      const d = folder(destRoot, b.to); if (d.status) return d;
      const srcs = [];
      for (const rel of list) {
        const s = source(rel); if (s.status) return s;
        const name = s.p[s.p.length - 1];
        if (s.kind === 'dir' && (d.abs === s.abs || d.abs.toLowerCase().startsWith(s.abs.toLowerCase() + path.sep))) return fail(400, `"${name}" cannot go inside itself`);
        const to = path.join(d.abs, name);
        if (to === s.abs) continue; // already there
        if (exists(to)) return fail(409, `There is already something called "${name}" in that folder`);
        srcs.push({ s, to });
      }
      const moved = [];
      const changed = [];
      for (const { s, to } of srcs) {
        try {
          moveOne(s.abs, to);
        } catch (e) {
          return { status: moved.length ? 207 : 500, json: { error: `Could not move "${s.p[s.p.length - 1]}": ${e.code || e.message}`, paths: moved, changed } };
        }
        moved.push(relOf(destRoot, to));
        changed.push(s.abs, to);
      }
      return { status: 200, json: { paths: moved, changed } };
    }
    case 'duplicate': {
      const s = source(b.path); if (s.status) return s;
      const old = s.p[s.p.length - 1];
      const [base, ext] = split(old, s.kind === 'dir');
      const name = freeName(path.dirname(s.abs), base + ' copy', ext);
      if (!name) return fail(409, 'Too many copies already');
      const to = path.join(path.dirname(s.abs), name);
      try {
        fs.cpSync(s.abs, to, { recursive: true, errorOnExist: true, force: false });
      } catch (e) {
        return fail(500, `Could not copy it: ${e.code || e.message}`);
      }
      return { status: 200, json: { path: relOf(root, to), changed: [to] } };
    }
    case 'delete': {
      const list = Array.isArray(b.paths) ? b.paths.slice(0, MAX_PATHS) : [];
      if (!list.length) return fail(400, 'Nothing to delete');
      const abs = [];
      for (const rel of list) {
        const s = source(rel); if (s.status) return s;
        abs.push(s.abs);
      }
      const r = await recycle(abs);
      const json = { paths: r.done.map((x) => relOf(root, x)), changed: r.done, bin: process.platform === 'win32' && process.env.MC_RECYCLE !== 'move' ? 'Recycle Bin' : 'trash' };
      if (r.failed.length) return { status: r.done.length ? 207 : 500, json: { ...json, error: r.failed[0].error } };
      return { status: 200, json };
    }
    default:
      return fail(400, 'Unknown action');
  }
}

// A rename, or a copy and delete when the two folders are on different drives
function moveOne(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// What a caller outside sends: the same body with its paths moved under `prefix` (a notes folder inside a vault), and
// back again for the answer
export function prefixBody(body, prefix) {
  if (!prefix) return body;
  const dir = (p) => (p ? `${prefix}/${p}` : prefix); // a folder: '' is the notes folder's top
  const item = (p) => (p ? `${prefix}/${p}` : ''); // a file or folder in it: '' stays refused
  const out = { ...body };
  if (out.op === 'note' || out.op === 'folder') out.dir = dir(out.dir || '');
  if (out.op === 'move') out.to = dir(out.to || '');
  if (typeof out.path === 'string') out.path = item(out.path);
  if (Array.isArray(out.paths)) out.paths = out.paths.map((p) => item(String(p || '')));
  return out;
}
export function unprefixAnswer(json, prefix) {
  if (!prefix || !json) return json;
  const down = (p) => (String(p).startsWith(prefix + '/') ? String(p).slice(prefix.length + 1) : String(p));
  const out = { ...json };
  delete out.changed;
  if (typeof out.path === 'string') out.path = down(out.path);
  if (Array.isArray(out.paths)) out.paths = out.paths.map(down);
  return out;
}
