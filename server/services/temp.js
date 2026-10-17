// The temp folder (tempRoot in .data/config.json): what is in it, how big each item is, and deleting an item.
//
// Layout: every folder directly inside the temp folder is a group (builds, scratch, ...), and every entry inside a
// group is one item. Files lying directly in the temp folder form the "loose" group. Only an item can be deleted,
// never a group or the temp folder itself, and never anything outside it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, TEMP_ROOT } from '../config.js';

const LOOSE = '(loose files)';
const CACHE_MS = 60_000;
let cache = null; // { at, data }
let measuring = null;

// Size, file count and newest change of a file or folder. The newest change is the newest file inside (a folder's own
// date moves whenever something is added, so a folder of old leftovers moved today would look new). Links (junctions
// included) are counted as nothing and never followed, so a junction into a build folder is not counted twice and
// cannot lead outside.
// Up to this many file system calls at once. One at a time took over 100s for 27,000 files on a busy drive.
const PARALLEL = 48;

async function measure(p) {
  let bytes = 0, files = 0, newest = 0, own = 0;
  let root;
  try { root = await fsp.lstat(p); } catch { return { bytes, files, newest: null }; }
  own = root.mtimeMs;
  if (root.isSymbolicLink()) return { bytes, files, newest: new Date(own).toISOString() };
  const fileStat = (st) => { bytes += st.size; files++; if (st.mtimeMs > newest) newest = st.mtimeMs; };
  if (!root.isDirectory()) fileStat(root);
  else {
    // A pool of workers sharing one queue of jobs: a folder to list, or a file to stat. The type comes from the folder
    // listing, so folders and links need no stat call of their own.
    const queue = [{ dir: p }];
    let active = 0;
    await new Promise((resolve) => {
      const pump = () => {
        while (active < PARALLEL && queue.length) {
          const job = queue.pop();
          active++;
          const done = () => { active--; if (!queue.length && !active) resolve(); else pump(); };
          if (job.dir) {
            fsp.readdir(job.dir, { withFileTypes: true }).then((list) => {
              for (const d of list) {
                const full = path.join(job.dir, d.name);
                if (d.isSymbolicLink()) continue;
                queue.push(d.isDirectory() ? { dir: full } : { file: full });
              }
            }, () => {}).finally(done);
          } else {
            fsp.lstat(job.file).then(fileStat, () => {}).finally(done);
          }
        }
      };
      pump();
    });
  }
  if (!newest) newest = own;
  return { bytes, files, newest: newest ? new Date(newest).toISOString() : null };
}

async function entries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function item(dir, d) {
  const p = path.join(dir, d.name);
  return { name: d.name, path: p, isDir: d.isDirectory(), isLink: d.isSymbolicLink(), ...(await measure(p)) };
}

async function scan() {
  if (!TEMP_ROOT) return { configured: false, root: null, groups: [], bytes: 0 };
  if (!fs.existsSync(TEMP_ROOT)) return { configured: true, exists: false, root: TEMP_ROOT, groups: [], bytes: 0 };
  const top = await entries(TEMP_ROOT);
  const groups = [];
  for (const d of top.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(TEMP_ROOT, d.name);
    const items = [];
    for (const e of await entries(dir)) items.push(await item(dir, e));
    groups.push({ name: d.name, path: dir, items });
  }
  const loose = [];
  for (const e of top.filter((e) => !e.isDirectory())) loose.push(await item(TEMP_ROOT, e));
  if (loose.length) groups.push({ name: LOOSE, path: TEMP_ROOT, items: loose });
  for (const g of groups) {
    g.items.sort((a, b) => b.bytes - a.bytes);
    g.bytes = g.items.reduce((s, i) => s + i.bytes, 0);
  }
  return { configured: true, exists: true, root: TEMP_ROOT, groups, bytes: groups.reduce((s, g) => s + g.bytes, 0) };
}

// The last result is kept on disk, so the page shows it at once, even right after a restart of the server.
const CACHE_FILE = path.join(DATA_DIR, 'temp-sizes.json');
function loadCache() {
  if (cache) return;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data && data.root === TEMP_ROOT) cache = { at: Date.parse(data.measuredAt) || 0, data };
  } catch { /* no saved result yet */ }
}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache.data)); } catch { /* the next scan tries again */ }
}
function startScan() {
  if (!measuring) {
    measuring = scan()
      .then((data) => { data.measuredAt = new Date().toISOString(); cache = { at: Date.now(), data }; saveCache(); return data; })
      .finally(() => { measuring = null; });
  }
  return measuring;
}

// Measuring takes a while on a large folder, so one scan is shared by every caller. Without `fresh`, the last result
// comes back at once (with refreshing: true while a new scan runs in the background, if it is over a minute old).
export async function getTemp({ fresh = false } = {}) {
  loadCache();
  if (fresh || !cache) return startScan();
  if (Date.now() - cache.at >= CACHE_MS) startScan().catch(() => {});
  return { ...cache.data, refreshing: !!measuring };
}

// After a delete, the saved result loses that item at once, instead of waiting for a whole new scan.
function forget(target) {
  if (!cache) return;
  for (const g of cache.data.groups) {
    g.items = g.items.filter((i) => !same(i.path, target));
    g.bytes = g.items.reduce((s, i) => s + i.bytes, 0);
  }
  cache.data.bytes = cache.data.groups.reduce((s, g) => s + g.bytes, 0);
  saveCache();
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Which item a path names, or why it may not be deleted.
export function checkItem(p) {
  if (!TEMP_ROOT) return { error: 'No temp folder is set (tempRoot in .data/config.json)' };
  if (typeof p !== 'string' || !p.trim()) return { error: 'path is required' };
  const target = path.resolve(p);
  const parent = path.dirname(target);
  const isLoose = same(parent, TEMP_ROOT);
  const isItem = same(path.dirname(parent), TEMP_ROOT);
  if (!isLoose && !isItem) return { error: 'Only an item inside a group of the temp folder can be deleted' };
  let st;
  try { st = fs.lstatSync(target); } catch { return { error: 'It is not there any more', gone: true }; }
  if (isLoose && st.isDirectory()) return { error: 'A group cannot be deleted, only the items inside it' };
  // The group must really sit inside the temp folder, not be a link to somewhere else.
  try {
    const realRoot = fs.realpathSync.native(TEMP_ROOT);
    const realParent = fs.realpathSync.native(parent);
    if (!same(isLoose ? realParent : path.dirname(realParent), realRoot)) {
      return { error: 'This group is a link to another folder, so nothing in it is deleted from here' };
    }
  } catch { return { error: 'Could not check where this item really is' }; }
  return { target };
}

export async function deleteItem(p) {
  const c = checkItem(p);
  if (c.error) return { status: c.gone ? 404 : 400, ok: false, error: c.error };
  try {
    // fs.rm removes a link or junction itself and never follows it.
    await fsp.rm(c.target, { recursive: true, force: false, maxRetries: 2, retryDelay: 200 });
  } catch (err) {
    // Part of it may be gone: the next look at the list measures again.
    if (cache) cache.at = 0;
    const busy = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
    const left = fs.existsSync(c.target);
    return {
      status: 409, ok: false, partial: left,
      error: busy ? 'A program is still using a file in it. Close it (or wait for the build to finish) and try again.' : err.message,
    };
  }
  forget(c.target);
  return { status: 200, ok: true, path: c.target };
}
