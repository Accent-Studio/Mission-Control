// Reading and writing Mission Control's own files in .data safely.
// A file that exists but cannot be read right now (antivirus, a backup or a sync tool holds it for a moment) is not an
// empty file. readJson says so with ok: false, and a store must then neither keep that empty result nor save over the
// file: it reads again on the next call, and its save refuses with a 503 (busyError) until a read has worked.
// A file that is not valid JSON is set aside as <file>.bad-<time>, so it is kept for a look, and then counts as missing.
import fs from 'node:fs';
import path from 'node:path';

const busyNow = new Set(); // files whose last read failed: logged once until a read works again

// { ok: true, value } for a file read and parsed (value is undefined when there is no file, or a bad one was set aside),
// { ok: false } when the file is there but could not be read. label names the store in the log.
export function readJson(file, label) {
  const r = readText(file, label);
  if (!r.ok || r.text === undefined) return { ok: r.ok, value: undefined };
  try {
    return { ok: true, value: JSON.parse(r.text) };
  } catch {
    const name = path.basename(file);
    try {
      fs.renameSync(file, `${file}.bad-${Date.now()}`);
      console.error(`[${label}] ${name} is not valid JSON; it was set aside as ${name}.bad-*`);
      return { ok: true, value: undefined };
    } catch (err) {
      // It could not be moved out of the way: never write over it.
      console.error(`[${label}] ${name} is not valid JSON and could not be set aside (${err.code || err.message})`);
      return { ok: false, value: undefined };
    }
  }
}

// The same for a text file: { ok: true, text } (text undefined when there is no file), or { ok: false }. A BOM is dropped.
export function readText(file, label) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    busyNow.delete(file);
    return { ok: true, text };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      busyNow.delete(file);
      return { ok: true, text: undefined };
    }
    if (!busyNow.has(file)) {
      busyNow.add(file);
      console.error(`[${label}] could not read ${path.basename(file)} (${err.code || err.message}); nothing is saved over it until it can be read`);
    }
    return { ok: false, text: undefined };
  }
}

// Temp file next to it (named after this process, so the server and the runner never share one), then rename, so a crash
// never leaves half a file. The temp file is removed when the write fails. Throws the write error.
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

export function writeJson(file, value, { pretty = true } = {}) {
  writeAtomic(file, JSON.stringify(value, null, pretty ? 2 : undefined));
}

// What a save answers while its file has not been read yet.
export function busyError(file) {
  return Object.assign(new Error(`Mission Control could not read ${path.basename(file)} just now (another program has it open). Nothing was saved. Try again in a moment.`), { status: 503 });
}
