// Attachments: upload a file for a chat message, serve it back, serve cached transcript images.
import { sendJson, notFound, readJson } from '../lib/http.js';
import { cacheImage, saveUpload, uploadFileInfo, cachedImageInfo, serveFile, UPLOAD_BODY_LIMIT } from '../services/uploads.js';
import { pcCall, pcOnline } from '../services/pcLink.js';

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
      let info = cachedImageInfo(params.name);
      // a picture of the other PC's conversation, read through the link: fetched from that PC once, then kept here
      if (!info && /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(params.name) && pcOnline()) {
        try {
          const r = await pcCall('GET', '/api/imgcache/' + params.name, { buffer: true, timeout: 60e3 });
          if (r.status === 200 && /^image\//.test(r.type) && cacheImage(r.type.split(';')[0], r.buf.toString('base64')) === '/api/imgcache/' + params.name) info = cachedImageInfo(params.name);
        } catch {
          // the link went down: no picture
        }
      }
      if (!info) return notFound(res, 'Unknown image');
      serveFile(req, res, info);
    },
  },
];
