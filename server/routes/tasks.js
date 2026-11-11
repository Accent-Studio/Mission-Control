// Tasks for the pages (the user's side). Claude's side is the MCP endpoint (routes/mcp.js).
import { sendJson, readJson } from '../lib/http.js';
import { tasksState, createTasks, updateTask, deleteTask, stepTask, noteTask, orderLane, getTask, addTarget, updateTarget, deleteTarget } from '../services/tasks.js';
import '../services/taskSync.js'; // the other PCs get the changes through the hub

const ME = { who: 'me', session: null };

export const routes = [
  {
    method: 'GET',
    path: '/api/tasks',
    handler: async (req, res, params, url) => {
      const q = url.searchParams;
      const filter = {};
      for (const k of ['project', 'status', 'for', 'from', 'tag', 'text']) if (q.has(k)) filter[k] = q.get(k);
      if (filter.project === '') filter.project = null; // personal tasks
      sendJson(res, 200, tasksState(filter));
    },
  },
  {
    method: 'GET',
    path: '/api/tasks/:id',
    handler: async (req, res, params) => sendJson(res, 200, getTask(params.id)),
  },
  {
    method: 'POST',
    path: '/api/tasks',
    handler: async (req, res) => {
      const b = await readJson(req);
      const list = Array.isArray(b.tasks) ? b.tasks : [b];
      sendJson(res, 200, { tasks: createTasks(list.slice(0, 100), ME) });
    },
  },
  {
    method: 'PUT',
    path: '/api/tasks/:id',
    handler: async (req, res, params) => sendJson(res, 200, updateTask(params.id, await readJson(req), ME)),
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/step',
    handler: async (req, res, params) => sendJson(res, 200, stepTask(params.id, await readJson(req), ME)),
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/note',
    handler: async (req, res, params) => sendJson(res, 200, noteTask(params.id, (await readJson(req)).text, ME)),
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/delete',
    handler: async (req, res, params) => sendJson(res, 200, deleteTask(params.id)),
  },
  {
    method: 'POST',
    path: '/api/targets',
    handler: async (req, res) => sendJson(res, 200, addTarget(await readJson(req), ME)),
  },
  {
    method: 'PUT',
    path: '/api/targets/:id',
    handler: async (req, res, params) => sendJson(res, 200, updateTarget(params.id, await readJson(req))),
  },
  {
    method: 'POST',
    path: '/api/targets/:id/delete',
    handler: async (req, res, params) => sendJson(res, 200, deleteTarget(params.id)),
  },
  {
    method: 'POST',
    path: '/api/task-lanes/:status',
    handler: async (req, res, params) => sendJson(res, 200, orderLane(params.status, (await readJson(req)).ids, ME)),
  },
];
