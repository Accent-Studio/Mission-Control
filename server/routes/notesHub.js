// The notes vaults' mirrors on the hub (services/notesHub.js), served only by a hub: git's smart HTTP protocol, for the
// machine that owns each vault (services/notesSync.js is its side).
import fs from 'node:fs';
import { ROLE } from '../config.js';
import { notFound, readJson, sendJson } from '../lib/http.js';
import { checkSave, NOTE_MAX } from '../lib/noteText.js';
import { machineName, machineOf, postsHere, touch } from '../services/hub.js';
import { editNote, listNotes, mirrorOf, noteFile, ownsVault, serveGit } from '../services/notesHub.js';

const gitRoute = (method, rest) => ({
  method,
  path: '/api/hub/git/:repo/' + rest,
  handler: async (req, res, params, url) => {
    const m = machineOf(req);
    touch(m);
    try {
      await serveGit(req, res, m, String(params.repo), rest, url);
    } catch (err) {
      if (!err.status || res.headersSent) throw err;
      sendJson(res, err.status, { error: err.message });
    }
  },
});

// a PC posts its conversations here or keeps a vault here; a phone does neither
const opts = { isPc: (m) => postsHere(m) || ownsVault(m), nameOf: (m) => m.name };
function mirrorFor(params) {
  const m = mirrorOf(String(params.owner), String(params.repo), machineName);
  if (!m) throw Object.assign(new Error('The hub has no such vault'), { status: 404 });
  return m;
}

const hubRoutes = [
  gitRoute('GET', 'info/refs'),
  gitRoute('POST', 'git-upload-pack'),
  gitRoute('POST', 'git-receive-pack'),
  {
    // another machine's notes: every file under ?folder= of vault :repo of machine :owner (a name, "Home")
    method: 'GET',
    path: '/api/hub/notes/:owner/:repo/list',
    handler: async (req, res, params, url) => {
      const m = machineOf(req);
      touch(m);
      try {
        sendJson(res, 200, await listNotes(mirrorFor(params), m, url.searchParams.get('folder') || '', opts));
      } catch (err) {
        if (!err.status) throw err;
        sendJson(res, err.status, { error: err.message });
      }
    },
  },
  {
    method: 'GET',
    path: '/api/hub/notes/:owner/:repo/file',
    handler: async (req, res, params, url) => {
      const m = machineOf(req);
      touch(m);
      let hit;
      try {
        hit = noteFile(mirrorFor(params), m, url.searchParams.get('path'), opts);
      } catch (err) {
        if (!err.status) throw err;
        return sendJson(res, err.status, { error: err.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': hit.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
    },
  },
  {
    // an edit of one note while its machine is off: { text, base }, written and committed here (services/notesHub.js editNote)
    method: 'PUT',
    path: '/api/hub/notes/:owner/:repo/file',
    handler: async (req, res, params, url) => {
      const m = machineOf(req);
      touch(m);
      const edit = checkSave(await readJson(req, NOTE_MAX * 2));
      if (edit.error) return sendJson(res, 400, { error: edit.error });
      try {
        const r = await editNote(mirrorFor(params), m, url.searchParams.get('path'), edit, opts);
        if (r.conflict) return sendJson(res, 409, { error: 'The note changed since it was opened', ...r });
        sendJson(res, 200, r);
      } catch (err) {
        if (!err.status) throw err;
        sendJson(res, err.status, { error: err.message });
      }
    },
  },
];

export const routes = ROLE === 'hub' ? hubRoutes : hubRoutes.map((r) => ({ ...r, handler: async (req, res) => notFound(res) }));
