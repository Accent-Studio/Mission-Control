// The notes vaults this machine owns and their sync with the hub (services/notesSync.js).
// The PC linked to this one (services/pcLink.js) reads and edits a note here while this PC is on, by its path in the vault:
// GET and PUT /api/notes/:repo/file?path=<path in the vault>. It goes to the hub's copy only while this PC is off.
// POST /api/notes/:repo/op: a file action of its Documents panel (lib/noteOps.js), paths in the vault; only while this PC is on.
import fs from 'node:fs';
import { readJson, sendJson } from '../lib/http.js';
import { checkSave, NOTE_MAX, noteHash, saveNote } from '../lib/noteText.js';
import { clearLibraryCache, isNoteText, vaultForOps, vaultNote } from '../services/library.js';
import { noteOp } from '../lib/noteOps.js';
import { notesSyncStatus, noteSaved, syncNow } from '../services/notesSync.js';

const asComputer = (req) => ({ computer: !!(req.mcDevice && req.mcDevice.computer) });

export const routes = [
  {
    method: 'GET',
    path: '/api/notes/sync',
    handler: async (req, res) => sendJson(res, 200, notesSyncStatus()),
  },
  {
    // sync now: { id } for one vault, nothing for all of them
    method: 'POST',
    path: '/api/notes/sync',
    handler: async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await syncNow(typeof body.id === 'string' ? body.id : null));
    },
  },
  {
    method: 'GET',
    path: '/api/notes/:repo/file',
    handler: async (req, res, params, url) => {
      const hit = vaultNote(String(params.repo), url.searchParams.get('path'), asComputer(req));
      if (hit.error) return sendJson(res, hit.status, { error: hit.error });
      if (hit.size > NOTE_MAX * 4) return sendJson(res, 413, { error: 'The file is too big' });
      const buf = fs.readFileSync(hit.abs);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-MC-Hash': noteHash(buf) });
      res.end(req.method === 'HEAD' ? undefined : buf);
    },
  },
  {
    // { text, base }: { hash }, or 409 { conflict, text, hash } when the note changed since base
    method: 'PUT',
    path: '/api/notes/:repo/file',
    handler: async (req, res, params, url) => {
      const rel = url.searchParams.get('path');
      const hit = vaultNote(String(params.repo), rel, asComputer(req));
      if (hit.error) return sendJson(res, hit.status, { error: hit.error });
      if (!isNoteText(String(rel).split('/').pop())) return sendJson(res, 403, { error: 'This file cannot be edited here' });
      const edit = checkSave(await readJson(req, NOTE_MAX * 2));
      if (edit.error) return sendJson(res, 400, { error: edit.error });
      const r = saveNote(hit.abs, edit.text, edit.base);
      if (r.conflict) return sendJson(res, 409, { error: 'The note changed since it was opened', ...r });
      noteSaved(hit.abs);
      clearLibraryCache();
      sendJson(res, 200, r);
    },
  },
  {
    // a file action of the linked PC's Documents panel in this PC's vault: a new note or folder, rename, move, duplicate, delete
    method: 'POST',
    path: '/api/notes/:repo/op',
    handler: async (req, res, params) => {
      const v = vaultForOps(String(params.repo), asComputer(req));
      if (!v) return sendJson(res, 404, { error: 'No such notes folder' });
      const r = await noteOp(v.dir, await readJson(req), { guard: v.guard });
      for (const f of (r.json && r.json.changed) || []) noteSaved(f);
      if (r.status < 300 || r.status === 207) clearLibraryCache();
      if (r.json) delete r.json.changed;
      sendJson(res, r.status, r.json);
    },
  },
];
