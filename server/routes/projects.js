// Projects API.
import fs from 'node:fs';
import { DISCOVERY_ROOTS } from '../config.js';
import { sendJson, readJson, notFound } from '../lib/http.js';
import { publish } from '../lib/events.js';
import { getProject, saveSettings, setCheckRequired, validateSettings } from '../services/catalog.js';
import { clearScriptsCache, commitAll } from '../services/jobs.js';
import { changes as gitChanges, commitFiles, fileDiff, isRepo } from '../services/git.js';
import { clearCache, getProjectDetail, launchInstalled, listProjects, resolveProjectFile } from '../services/projects.js';
import { asPage, clearLibraryCache, isNoteText, isPage, libraryRoots, linkedLibrary, linkedRootsOf, PAGE_CSP, projectLibrary, remoteNoteFile, remoteNoteOp, rootFolder, rootRemote, saveRemoteNote, sharedNotes, TEXT_MAX } from '../services/library.js';
import { noteOp } from '../lib/noteOps.js';
import { checkSave, NOTE_MAX, noteHash, saveNote } from '../lib/noteText.js';
import { noteSaved } from '../services/notesSync.js';
import { pcName, pcProjectKnown } from '../services/pcLink.js';
import { addRoot, removeRoot } from '../services/roots.js';

const FILE_HEADERS = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
// A text file comes with the hash of its bytes (X-MC-Hash), which the editor sends back with its save (lib/noteText.js)
const hashHeader = (buf) => ({ 'X-MC-Hash': noteHash(buf) });
const baseName = (rel) => String(rel || '').split(/[\\/]/).pop();

// One file of a library, held in memory: as it is, or with ?view=page an .html file as a page (library.js asPage).
function sendBuf(req, res, url, rel, buf, type) {
  const page = url.searchParams.get('view') === 'page' && isPage(rel);
  const body = page ? asPage(buf) : buf;
  res.writeHead(200, {
    ...FILE_HEADERS,
    'Content-Type': page ? 'text/html; charset=utf-8' : type,
    'Content-Length': body.length,
    'Content-Security-Policy': page ? PAGE_CSP : "default-src 'none'; sandbox",
    ...(page || buf.length > NOTE_MAX ? {} : hashHeader(buf)),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// A notes folder of another machine's vault, read from the hub
async function sendRemote(req, res, url, remote) {
  const rel = url.searchParams.get('path');
  const got = await remoteNoteFile(remote, rel);
  if (got.error) return sendJson(res, got.status === 403 ? 403 : got.status === 503 ? 503 : 404, { error: got.error });
  sendBuf(req, res, url, rel, got.buf, got.type);
}

// The answer to a save from the Documents panel's editor
async function saveRemote(req, res, url, remote) {
  const edit = checkSave(await readJson(req, NOTE_MAX * 2));
  if (edit.error) return sendJson(res, 400, { error: edit.error });
  const r = await saveRemoteNote(remote, url.searchParams.get('path'), edit);
  if (r.status === 200) clearLibraryCache();
  sendJson(res, r.status, r.json);
}

// A file action of the Documents panel (lib/noteOps.js) in a notes folder: { root, op, ... }. A notes folder of this PC
// is changed on disk (the notes sync takes it to the hub); another PC's on that PC over the link (library.js remoteNoteOp).
// A move may go to another notes folder of this PC (toRoot). The project folder stays read only.
async function notesOp(res, body, roots) {
  const b = body && typeof body === 'object' ? body : {};
  const r = roots.find((x) => x.id === b.root);
  if (!r || r.id === 'p') return sendJson(res, 403, { error: 'Only the notes folders can be changed here' });
  const dest = b.toRoot && b.toRoot !== b.root ? roots.find((x) => x.id === b.toRoot) : null;
  if (b.toRoot && b.toRoot !== b.root && (!dest || dest.id === 'p' || dest.remote || r.remote)) return sendJson(res, 400, { error: 'Drag it within one notes folder of the other PC, or between notes folders of this one' });
  const op = { ...b };
  delete op.root;
  delete op.toRoot;
  if (r.remote) {
    const out = await remoteNoteOp(r.remote, op);
    if (out.status < 300 || out.status === 207) clearLibraryCache();
    return sendJson(res, out.status, out.json);
  }
  const out = await noteOp(r.folder, op, { toRoot: dest ? dest.folder : null });
  for (const f of (out.json && out.json.changed) || []) noteSaved(f);
  if (out.status < 300 || out.status === 207) clearLibraryCache();
  if (out.json) delete out.json.changed;
  sendJson(res, out.status, out.json);
}

// A project of the PC this one is linked to, by its id there (services/pcLink.js keeps its list while it is off)
function linkedProject(id) {
  const p = pcProjectKnown(id);
  return p && pcName() ? { owner: pcName(), project: p } : null;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/projects',
    handler: async (req, res, params, url) => {
      // Hidden projects are left out unless ?all=1.
      // roots: the folders scanned for projects; a new conversation can also start right in one of them
      // notes: the notes folders the linked PC can read from the hub (library.js sharedNotes)
      const projects = (await listProjects({ all: url.searchParams.get('all') === '1' })).map((p) => ({ ...p, notes: sharedNotes(p) }));
      sendJson(res, 200, { projects, roots: DISCOVERY_ROOTS });
    },
  },
  {
    // a root folder for the project list: { folder }, a full path. Answers { roots }.
    method: 'POST',
    path: '/api/roots',
    handler: async (req, res) => {
      const body = await readJson(req, 8192);
      sendJson(res, 200, addRoot(body && body.folder));
    },
  },
  {
    method: 'POST',
    path: '/api/roots/remove',
    handler: async (req, res) => {
      const body = await readJson(req, 8192);
      sendJson(res, 200, removeRoot(body && body.folder));
    },
  },
  {
    method: 'POST',
    path: '/api/projects/refresh',
    handler: async (req, res) => {
      clearCache();
      clearLibraryCache();
      publish('projects.changed', {});
      sendJson(res, 200, { ok: true });
    },
  },
  {
    // Local commit of every change with the user's message. Never pushes.
    method: 'POST',
    path: '/api/projects/:id/git/commit',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      try {
        sendJson(res, 200, await commitAll(params.id, body && body.message));
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
      }
    },
  },
  {
    // Uncommitted files, newest edit first. Read only.
    method: 'GET',
    path: '/api/projects/:id/git/changes',
    handler: async (req, res, params) => {
      const project = getProject(params.id);
      if (!project || !isRepo(project.folder)) return notFound(res, 'Unknown project or not a git repo');
      const r = await gitChanges(project.folder);
      if (!r) return sendJson(res, 502, { error: 'git did not answer' });
      sendJson(res, 200, r);
    },
  },
  {
    // The files one commit touched. Read only.
    method: 'GET',
    path: '/api/projects/:id/git/commits/:hash',
    handler: async (req, res, params) => {
      const project = getProject(params.id);
      if (!project || !isRepo(project.folder)) return notFound(res, 'Unknown project or not a git repo');
      if (!/^[0-9a-f]{7,40}$/i.test(params.hash)) return sendJson(res, 400, { error: 'Bad commit hash' });
      const r = await commitFiles(project.folder, params.hash);
      if (!r) return notFound(res, 'Unknown commit');
      sendJson(res, 200, r);
    },
  },
  {
    // The changes of one file for the reader: ?path=<repo path>, and &commit=<hash> for what a commit changed in it
    // (without: what is not committed yet). Read only.
    method: 'GET',
    path: '/api/projects/:id/git/diff',
    handler: async (req, res, params, url) => {
      const project = getProject(params.id);
      if (!project || !isRepo(project.folder)) return notFound(res, 'Unknown project or not a git repo');
      const hash = url.searchParams.get('commit');
      const r = await fileDiff(project.folder, url.searchParams.get('path'), hash || null);
      if (!r) return sendJson(res, 400, { error: 'This file cannot be shown' });
      sendJson(res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/checks/:key/launch',
    handler: async (req, res, params) => {
      const r = launchInstalled(params.id, params.key);
      sendJson(res, r.status, r.body);
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/checks/:key',
    handler: async (req, res, params) => {
      const body = await readJson(req);
      if (!body || typeof body.required !== 'boolean') return sendJson(res, 400, { error: 'Body must be {required: boolean}' });
      if (!setCheckRequired(params.id, params.key, body.required)) return notFound(res, 'Unknown project or check');
      clearCache();
      publish('projects.changed', {});
      sendJson(res, 200, { ok: true, required: body.required });
    },
  },
  {
    // One save for the Settings tab: hidden flag, the tracked jobs (full list) and which checks count for status.
    method: 'PUT',
    path: '/api/projects/:id/settings',
    handler: async (req, res, params) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      const body = await readJson(req);
      const checked = validateSettings(project, body);
      if (checked.error) return sendJson(res, 400, { error: checked.error });
      if (!saveSettings(project.id, checked.value)) return notFound(res, 'Unknown project');
      clearCache();
      clearScriptsCache(project.id);
      publish('projects.changed', {});
      const saved = getProject(project.id);
      sendJson(res, 200, { ok: true, hidden: saved.hidden, jobs: saved.jobs });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/file',
    handler: async (req, res, params, url) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      const root = url.searchParams.get('root') || 'p';
      const remote = rootRemote(project, root);
      if (remote) return sendRemote(req, res, url, remote);
      const folder = rootFolder(project, root);
      if (!folder) return notFound(res, 'File not found');
      const rel = url.searchParams.get('path');
      const hit = resolveProjectFile(project, rel, folder, { anyText: root !== 'p' });
      if (hit.error === 'forbidden') return sendJson(res, 403, { error: 'Forbidden' });
      if (hit.error) return notFound(res, 'File not found');
      if (url.searchParams.get('view') === 'page' && isPage(rel)) {
        if (hit.size > TEXT_MAX) return sendJson(res, 413, { error: 'The page is too big to show' });
        return sendBuf(req, res, url, rel, fs.readFileSync(hit.file), hit.type);
      }
      if (root !== 'p' && hit.size <= NOTE_MAX && isNoteText(baseName(rel))) return sendBuf(req, res, url, rel, fs.readFileSync(hit.file), hit.type);
      res.writeHead(200, {
        ...FILE_HEADERS,
        'Content-Type': hit.type,
        'Content-Length': hit.size,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
    },
  },
  {
    // The Documents panel's editor saves a note of one of the project's notes folders: { text, base } (base: X-MC-Hash of
    // the file as it opened). A folder of this machine is written on disk (the notes sync takes it to the hub), another
    // machine's goes to it over the link, or to the hub's copy (library.js saveRemoteNote). The project folder is read only.
    method: 'PUT',
    path: '/api/projects/:id/file',
    handler: async (req, res, params, url) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      const root = url.searchParams.get('root') || 'p';
      if (root === 'p') return sendJson(res, 403, { error: 'Only notes can be edited here' });
      const remote = rootRemote(project, root);
      if (remote) return saveRemote(req, res, url, remote);
      const folder = rootFolder(project, root);
      if (!folder) return notFound(res, 'File not found');
      const rel = url.searchParams.get('path');
      const hit = resolveProjectFile(project, rel, folder, { anyText: true });
      if (hit.error === 'forbidden' || (!hit.error && !isNoteText(baseName(rel)))) return sendJson(res, 403, { error: 'This file cannot be edited here' });
      if (hit.error) return notFound(res, 'File not found');
      const edit = checkSave(await readJson(req, NOTE_MAX * 2));
      if (edit.error) return sendJson(res, 400, { error: edit.error });
      const r = saveNote(hit.file, edit.text, edit.base);
      if (r.conflict) return sendJson(res, 409, { error: 'The note changed since it was opened', ...r });
      noteSaved(hit.file);
      clearLibraryCache();
      sendJson(res, 200, { ...r, saved: 'disk' });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/notes-op',
    handler: async (req, res, params) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      return notesOp(res, await readJson(req), libraryRoots(project));
    },
  },
  {
    // the same in a project of the linked PC: its notes folders live on that PC
    method: 'POST',
    path: '/api/pc/projects/:id/notes-op',
    handler: async (req, res, params) => {
      const hit = linkedProject(params.id);
      if (!hit) return notFound(res, 'Unknown project');
      return notesOp(res, await readJson(req), await linkedRootsOf(hit.owner, hit.project));
    },
  },
  {
    // The Docs or Screenshots tab: every text file or picture of the project and of its notes folders, as roots and paths.
    method: 'GET',
    path: '/api/projects/:id/library',
    handler: async (req, res, params, url) => {
      const project = getProject(params.id);
      if (!project) return notFound(res, 'Unknown project');
      const kind = url.searchParams.get('kind') === 'images' ? 'images' : 'docs';
      sendJson(res, 200, await projectLibrary(project, kind, { fresh: url.searchParams.get('fresh') === '1' }));
    },
  },
  {
    // A project of the linked PC: its notes, read from the hub, so they show while that PC is off (library.js linkedRootsOf)
    method: 'GET',
    path: '/api/pc/projects/:id/library',
    handler: async (req, res, params, url) => {
      const hit = linkedProject(params.id);
      if (!hit) return notFound(res, 'Unknown project');
      const kind = url.searchParams.get('kind') === 'images' ? 'images' : 'docs';
      sendJson(res, 200, await linkedLibrary(hit.owner, hit.project, kind, { fresh: url.searchParams.get('fresh') === '1' }));
    },
  },
  {
    method: 'GET',
    path: '/api/pc/projects/:id/file',
    handler: async (req, res, params, url) => {
      const hit = linkedProject(params.id);
      if (!hit) return notFound(res, 'Unknown project');
      const r = (await linkedRootsOf(hit.owner, hit.project)).find((x) => x.id === url.searchParams.get('root'));
      if (!r) return notFound(res, 'File not found');
      return sendRemote(req, res, url, r.remote);
    },
  },
  {
    // A save of the editor in a note of a project of the linked PC: on that PC while it is on, else in the hub's copy
    method: 'PUT',
    path: '/api/pc/projects/:id/file',
    handler: async (req, res, params, url) => {
      const hit = linkedProject(params.id);
      if (!hit) return notFound(res, 'Unknown project');
      const r = (await linkedRootsOf(hit.owner, hit.project)).find((x) => x.id === url.searchParams.get('root'));
      if (!r) return notFound(res, 'File not found');
      return saveRemote(req, res, url, r.remote);
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    handler: async (req, res, params) => {
      const detail = await getProjectDetail(params.id);
      if (!detail) return notFound(res, 'Unknown project');
      sendJson(res, 200, detail);
    },
  },
];
