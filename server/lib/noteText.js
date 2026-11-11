// Saving a note edited in the Documents panel, the same way on a PC and on the hub (design/notes-spec.md).
// A note keeps what the editor cannot see: its byte order mark and its line ends (a textarea gives "\n" only, and the
// vaults keep files byte for byte, "* -text"). `base` is the hash of the file as the editor opened it: a file that
// changed since then is not overwritten, the caller gets it back to choose.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const NOTE_MAX = 5 * 1024 * 1024;
export const noteHash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// The bytes to write for `text`, in the style of the file as it is now (`old`, a Buffer)
export function noteBytes(text, old) {
  let s = String(text).replace(/\r\n?/g, '\n');
  const bom = old && old.subarray(0, 3).equals(BOM);
  const head = old ? old.subarray(0, 64 * 1024).toString('utf8') : '';
  if (/\r\n/.test(head) && !/(^|[^\r])\n/.test(head)) s = s.replace(/\n/g, '\r\n');
  const out = Buffer.from(s.replace(/^﻿/, ''), 'utf8');
  return bom ? Buffer.concat([BOM, out]) : out;
}

// Writes `text` over the existing file `abs`: { hash } or { conflict: true, text, hash } (what the file holds now)
export function saveNote(abs, text, base) {
  const old = fs.readFileSync(abs);
  if (base && noteHash(old) !== base) return { conflict: true, text: old.toString('utf8').replace(/^﻿/, ''), hash: noteHash(old) };
  const buf = noteBytes(text, old);
  if (!buf.equals(old)) fs.writeFileSync(abs, buf);
  return { hash: noteHash(buf) };
}

// The body of a save: { text, base } checked, or an error message
export function checkSave(body) {
  if (!body || typeof body.text !== 'string') return { error: 'Send {"text": "..."} to save' };
  if (Buffer.byteLength(body.text) > NOTE_MAX) return { error: 'The note is too big to save here' };
  if (body.text.includes('\u0000')) return { error: 'This file is not text' };
  if (body.base != null && !/^[0-9a-f]{40}$/.test(String(body.base))) return { error: 'Bad base' };
  return { text: body.text, base: body.base || null };
}
