// The temp folder (tempRoot in .data/config.json): what is in it, how big each item is, and deleting an item.
//
// Layout: every folder directly inside the temp folder is a group (builds, scratch, ...), and every entry inside a
// group is one item. Files lying directly in the temp folder form the "loose" group. Only an item can be deleted,
// never a group or the temp folder itself, and never anything outside it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TEMP_ROOT } from '../config.js';

const LOOSE = '(loose files)';
const CACHE_MS = 60_000;
let cache = null; // { at, data }
let measuring = null;

// Size, file count and newest change of a file or folder. The newest change is the newest file inside (a folder's own
// date moves whenever something is added, so a folder of old leftovers moved today would look new). Links (junctions
// included) are counted as nothing and never followed, so a junction into a build folder is not counted twice and
// cannot lead outside.
async function measure(p) {
  let bytes = 0, files = 0, newest = 0, own = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = await fsp.lstat(cur); } catch { continue; }
    if (cur === p) own = st.mtimeMs;
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names;
      try { names = await fsp.readdir(cur); } catch { continue; }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      bytes += st.size;
      files++;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
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

// Measuring a large build folder takes seconds, so one scan is shared by every caller and kept for a minute.
export async function getTemp({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (!measuring) {
    measuring = scan()
      .then((data) => { data.measuredAt = new Date().toISOString(); cache = { at: Date.now(), data }; return data; })
      .finally(() => { measuring = null; });
  }
  return measuring;
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
    cache = null;
    const busy = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
    const left = fs.existsSync(c.target);
    return {
      status: 409, ok: false, partial: left,
      error: busy ? 'A program is still using a file in it. Close it (or wait for the build to finish) and try again.' : err.message,
    };
  }
  cache = null;
  return { status: 200, ok: true, path: c.target };
}
