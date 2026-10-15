// A project's library for the Docs and Screenshots tabs: its text files and its pictures, as folder trees.
// Two kinds of root: the project folder itself (id "p"), and its notes folders (ids "n0", "n1", ...): the ones listed in
// NOTES_FOLDERS, plus a folder named like the project in NOTES_PROJECT_DIR (see config.js). Read only, cached for a minute.
import fs from 'node:fs';
import path from 'node:path';
import { NOTES_FOLDERS, NOTES_PROJECT_DIR, NOTES_ROOT } from '../config.js';

const DOC_EXT = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
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
  const rel = [...(NOTES_FOLDERS[project.id] || [])];
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

// The roots of a project: [{ id, label, folder }]. The project folder is "p".
export function libraryRoots(project) {
  const roots = [{ id: 'p', label: path.basename(project.folder) || project.name, folder: project.folder }];
  notesFolders(project).forEach((n, i) => roots.push({ id: 'n' + i, label: 'Notes: ' + n.rel, folder: n.abs }));
  return roots;
}

export function rootFolder(project, id) {
  if (!id || id === 'p') return project.folder;
  const r = libraryRoots(project).find((x) => x.id === id);
  return r ? r.folder : null;
}

async function walk(root, kind, out, budget) {
  const want = kind === 'docs' ? DOC_EXT : IMAGE_EXT;
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
      } else if (e.isFile() && want.has(path.extname(e.name).toLowerCase())) {
        if (kind === 'docs' && NOT_DOCS.test(e.name)) continue;
        files.push(e.name);
      }
    }
    const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(dir, f)).catch(() => null)));
    files.forEach((f, i) => {
      const st = stats[i];
      if (st && out.length < MAX[kind]) out.push({ path: rel ? rel + '/' + f : f, size: st.size, mtime: st.mtime.toISOString() });
    });
    for (const d of dirs) await go(path.join(dir, d), rel ? rel + '/' + d : d, depth + 1);
  }
  await go(root, '', 0);
}

const cache = new Map(); // project id + kind -> { at, value, pending }

// { roots: [{id, label}], files: [{root, path, size, mtime}], cut } for kind "docs" or "images".
export function projectLibrary(project, kind, { fresh = false } = {}) {
  const key = project.id + ':' + kind;
  const e = cache.get(key);
  if (e && !fresh && e.value && Date.now() - e.at < TTL_MS) return Promise.resolve(e.value);
  if (e && e.pending) return e.pending;
  const entry = e || {};
  cache.set(key, entry);
  entry.pending = (async () => {
    const roots = libraryRoots(project);
    const files = [];
    let cut = false;
    for (const r of roots) {
      const out = [];
      const budget = { n: BUDGET };
      await walk(r.folder, kind, out, budget);
      if (budget.n <= 0 || out.length >= MAX[kind]) cut = true;
      for (const f of out) files.push({ root: r.id, ...f });
    }
    const value = { roots: roots.map(({ id, label }) => ({ id, label })), files, cut };
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
