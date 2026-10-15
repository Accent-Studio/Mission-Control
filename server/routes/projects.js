// Projects API.
import fs from 'node:fs';
import { sendJson, readJson, notFound } from '../lib/http.js';
import { publish } from '../lib/events.js';
import { getProject, saveSettings, setCheckRequired, validateSettings } from '../services/catalog.js';
import { clearScriptsCache, commitAll } from '../services/jobs.js';
import { changes as gitChanges, commitFiles, fileDiff, isRepo } from '../services/git.js';
import { clearCache, getProjectDetail, launchInstalled, listProjects, resolveProjectFile } from '../services/projects.js';
import { clearLibraryCache, projectLibrary, rootFolder } from '../services/library.js';

export const routes = [
  {
    method: 'GET',
    path: '/api/projects',
    handler: async (req, res, params, url) => {
      // Hidden projects are left out unless ?all=1.
      sendJson(res, 200, { projects: await listProjects({ all: url.searchParams.get('all') === '1' }) });
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
      const folder = rootFolder(project, root);
      if (!folder) return notFound(res, 'File not found');
      const hit = resolveProjectFile(project, url.searchParams.get('path'), folder);
      if (hit.error === 'forbidden') return sendJson(res, 403, { error: 'Forbidden' });
      if (hit.error) return notFound(res, 'File not found');
      res.writeHead(200, {
        'Content-Type': hit.type,
        'Content-Length': hit.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
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
    method: 'GET',
    path: '/api/projects/:id',
    handler: async (req, res, params) => {
      const detail = await getProjectDetail(params.id);
      if (!detail) return notFound(res, 'Unknown project');
      sendJson(res, 200, detail);
    },
  },
];
