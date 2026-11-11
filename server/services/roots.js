// The root folders: the folders whose subfolders are projects (discoveryRoots in .data/config.json). The project tree adds
// and removes them. The list changes in place, so every part of the server that reads DISCOVERY_ROOTS sees the change at
// once, and the runner reads the file again before it starts a process (runner/shared.js).
import fs from 'node:fs';
import path from 'node:path';
import { DISCOVERY_ROOTS, LOCAL_CONFIG_FILE, ROLE } from '../config.js';
import { writeJson } from '../lib/jsonStore.js';
import { publish } from '../lib/events.js';
import { forgetDiscovered } from './catalog.js';
import { clearCache } from './projects.js';
import { clearLibraryCache } from './library.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// A full path to an existing folder, as typed or pasted (Windows "Copy as path" adds quotes), or an error.
function folderOf(text) {
  const raw = typeof text === 'string' ? text.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  if (!raw || raw.length > 1024 || /[\0<>"|?*]/.test(raw)) throw fail(400, 'Give the full path of a folder');
  if (process.platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(raw) : !path.isAbsolute(raw)) throw fail(400, 'Give the full path of a folder');
  const folder = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(folder);
  } catch {
    throw fail(404, `${folder} does not exist`);
  }
  if (!st.isDirectory()) throw fail(400, `${folder} is not a folder`);
  return folder;
}

// Writes the list into .data/config.json, keeping every other setting. A file that cannot be read is left alone.
function save(list) {
  if (process.env.MC_DISCOVERY_ROOTS) throw fail(409, 'The root folders come from MC_DISCOVERY_ROOTS here');
  if (ROLE === 'hub') throw fail(409, 'The hub has no projects');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') throw fail(409, `.data/config.json could not be read, so nothing was changed: ${err.message}`);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw fail(409, '.data/config.json is not a settings object, so nothing was changed');
  cfg.discoveryRoots = list;
  writeJson(LOCAL_CONFIG_FILE, cfg);
  DISCOVERY_ROOTS.splice(0, DISCOVERY_ROOTS.length, ...list);
  forgetDiscovered();
  clearCache();
  clearLibraryCache();
  publish('projects.changed', {});
  return { roots: DISCOVERY_ROOTS.slice() };
}

export function addRoot(text) {
  const folder = folderOf(text);
  if (DISCOVERY_ROOTS.some((r) => key(path.resolve(r)) === key(folder))) throw fail(409, `${folder} is already in the list`);
  return save([...DISCOVERY_ROOTS, folder]);
}

export function removeRoot(text) {
  const want = typeof text === 'string' ? key(path.resolve(text.trim())) : '';
  const list = DISCOVERY_ROOTS.filter((r) => key(path.resolve(r)) !== want);
  if (list.length === DISCOVERY_ROOTS.length) throw fail(404, 'That folder is not in the list');
  if (!list.length) throw fail(409, 'Keep at least one root folder');
  return save(list);
}
