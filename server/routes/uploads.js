// Attachments: upload a file for a chat message, serve it back, serve cached transcript images.
import { sendJson, notFound, readJson } from '../lib/http.js';
import { saveUpload, uploadFileInfo, cachedImageInfo, serveFile, UPLOAD_BODY_LIMIT } from '../services/uploads.js';

export const routes = [
  {
    method: 'POST',
    path: '/api/uploads',
    handler: async (req, res) => {
      const body = await readJson(req, UPLOAD_BODY_LIMIT);
      sendJson(res, 200, saveUpload(body));
    },
  },
  {
    method: 'GET',
    path: '/api/uploads/:id/file',
    handler: async (req, res, params) => {
      const info = uploadFileInfo(params.id);
      if (!info) return notFound(res, 'Unknown upload');
      serveFile(req, res, info);
    },
  },
  {
    method: 'GET',
    path: '/api/imgcache/:name',
    handler: async (req, res, params) => {
      const info = cachedImageInfo(params.name);
      if (!info) return notFound(res, 'Unknown image');
      serveFile(req, res, info);
    },
  },
];
