// Mission Control's MCP endpoint (Streamable HTTP). Claude Code posts JSON-RPC here; the answers are plain JSON, never a
// stream, so a GET (the optional server-to-client stream) is refused with 405 as the protocol allows.
import { sendJson, readJson } from '../lib/http.js';
import { handleRpc } from '../services/mcp.js';

export const routes = [
  {
    method: 'POST',
    path: '/api/mcp',
    handler: async (req, res) => {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return sendJson(res, e.status === 413 ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => handleRpc(m, req)))).filter(Boolean);
        if (!out.length) return res.writeHead(202).end();
        return sendJson(res, 200, out);
      }
      const out = await handleRpc(body, req); // a web search answers later
      if (!out) return res.writeHead(202).end();
      sendJson(res, 200, out);
    },
  },
  {
    method: 'GET',
    path: '/api/mcp',
    handler: async (req, res) => {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
    },
  },
];
