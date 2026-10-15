// Mission Control server: static front end plus JSON API. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, BRIDGE_HOST, BRIDGE_PORT, HOST, PORT, ROOT } from './config.js';
import { sendJson, notFound, wrap } from './lib/http.js';
import { handleStream } from './lib/events.js';
import { loadCatalog } from './services/catalog.js';
import { registerServer } from './lib/restart.js';
import { getDevice, loadBridgeSecret, touchDevice, verifyBridgeSecret } from './lib/bridgeAuth.js';
import { remoteAllowed, unclassifiedRoutes } from './lib/remote-policy.js';
import { startProjectsBackground } from './services/projects.js';
import { onRevoke } from './services/devices.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- Routes ----

const routes = [];
// Routes for the bridge program itself (pairing, control stream). Route files export them as `bridgeRoutes`;
// they are served only on the bridge listener, only to a caller that carries no device (see handleRequest).
const bridgeRoutes = [];

function addRoute(r, table = routes) {
  const names = [];
  const pattern = r.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  table.push({
    method: r.method.toUpperCase(),
    path: r.path,
    regex: new RegExp(`^${pattern}/?$`),
    names,
    handler: wrap(r.handler),
  });
}

addRoute({ method: 'GET', path: '/api/events', handler: async (req, res) => handleStream(req, res) });
// Who is asking: a phone (through the bridge) or the PC itself. Pages use it to hide PC-only buttons.
addRoute({
  method: 'GET',
  path: '/api/whoami',
  handler: async (req, res) =>
    sendJson(res, 200, { remote: !!req.mcDevice, device: req.mcDevice ? { id: req.mcDevice.id, name: req.mcDevice.name } : null }),
});

const routesDir = path.join(ROOT, 'server', 'routes');
for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort()) {
  // One broken route file must not stop the others from loading.
  try {
    const mod = await import(pathToFileURL(path.join(routesDir, file)).href);
    for (const r of mod.routes || []) addRoute(r);
    for (const r of mod.bridgeRoutes || []) addRoute(r, bridgeRoutes);
  } catch (err) {
    console.error(`[routes] could not load ${file}:`, err);
  }
}

// A state-changing route that nobody classified for phones is refused for them. Say so loudly at start.
{
  const missing = unclassifiedRoutes(routes);
  if (missing.length) console.error(`[policy] routes with no entry in server/lib/remote-policy.js (phones get 403 pc_only): ${missing.join(', ')}`);
}

function matchRoute(method, pathname, table = routes) {
  for (const r of table) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]);
      } catch {
        params[n] = m[i + 1];
      }
    });
    return { route: r, params };
  }
  return null;
}

// ---- Host check: applies to every request ----

// A DNS rebinding page can make the browser reach this server under its own domain name, so only the names
// this server is meant to be reached by are served. MC_ALLOWED_HOSTS adds more (for example a Tailscale name).
// The bridge listener accepts exactly one name: the bridge program rewrites the phone's Host to it.
function hostsFor(kind) {
  if (kind === 'bridge') return new Set([`127.0.0.1:${BRIDGE_PORT}`]);
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  for (const h of (process.env.MC_ALLOWED_HOSTS || '').split(',')) {
    const name = h.trim().toLowerCase();
    if (name) hosts.add(name);
  }
  return hosts;
}
const ALLOWED_HOSTS = { local: hostsFor('local'), bridge: hostsFor('bridge') };

// ---- Safety check for anything that is not a plain GET ----

// On the bridge listener the only Origin is the bridge's own address (the bridge rewrote the phone's loopback origin).
const ALLOWED_ORIGINS = {
  local: new Set([...ALLOWED_HOSTS.local].map((h) => `http://${h}`)),
  bridge: new Set([...ALLOWED_HOSTS.bridge].map((h) => `http://${h}`)),
};

function passesSafetyCheck(req, kind) {
  if (req.headers['x-mc'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS[kind].has(origin)) return false;
  return true;
}

// ---- Static files ----

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  // No NUL bytes, and no colons (drive letters and NTFS alternate streams like index.html::$DATA).
  if (rel.includes('\0') || rel.includes(':')) return notFound(res);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/favicon.ico') rel = '/favicon.svg';
  const full = path.resolve(APP_DIR, '.' + rel);
  if (full !== APP_DIR && !full.startsWith(APP_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });
}

// ---- Server ----

// Open responses on the bridge listener per phone, so a revoked phone loses even a stream that is still running.
const openByDevice = new Map(); // device id -> Set of responses
function trackResponse(id, res) {
  let set = openByDevice.get(id);
  if (!set) openByDevice.set(id, (set = new Set()));
  set.add(res);
  res.on('close', () => {
    set.delete(res);
    if (!set.size && openByDevice.get(id) === set) openByDevice.delete(id);
  });
}
onRevoke((id) => {
  for (const res of [...(openByDevice.get(id) || [])]) res.destroy();
});

// `kind` is 'local' (the PC's own browser, port 1700) or 'bridge' (mc-bridge.exe on behalf of a phone, port 1701).
async function handleRequest(kind, req, res) {
  // No page of Mission Control is ever shown inside a frame: another site cannot put one under a decoy and steal a click.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (!ALLOWED_HOSTS[kind].has((req.headers.host || '').toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden host');
  }

  if (kind === 'bridge') {
    if (!verifyBridgeSecret(req.headers['x-mc-bridge'])) {
      res.writeHead(401, { Connection: 'close' });
      return res.end();
    }
    delete req.headers['x-mc-bridge']; // route code never sees the secret
    const devId = req.headers['x-mc-device'];
    delete req.headers['x-mc-device'];
    if (devId !== undefined) {
      const dev = getDevice(devId);
      if (!dev) return sendJson(res, 403, { error: 'device_revoked' });
      req.mcDevice = { id: dev.id, name: dev.name };
      trackResponse(dev.id, res);
      touchDevice(dev.id);
    }
  } else {
    // A client of the local listener cannot claim to be the bridge or a phone.
    delete req.headers['x-mc-bridge'];
    delete req.headers['x-mc-device'];
  }

  // Prefixing a fixed origin means absolute-form or protocol-relative targets cannot change the host.
  // A malformed target such as "http://[" makes this throw, which the caller turns into a 400.
  const url = new URL('http://mc.invalid' + (req.url.startsWith('/') ? req.url : '/' + req.url));
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // /api/bridge/* is the bridge program's private surface: not there on the local listener, and a request that
  // carries a device (a phone, forwarded) never reaches it even if the bridge failed to block the path.
  const bridgeNamespace = pathname === '/api/bridge' || pathname.startsWith('/api/bridge/');
  if (bridgeNamespace && (kind !== 'bridge' || req.mcDevice)) {
    return req.mcDevice ? sendJson(res, 403, { error: 'Forbidden' }) : notFound(res);
  }

  // On the bridge listener a request without a device is the bridge program itself: its own control routes and
  // nothing else. Judged on the parsed path, so dot segments or an absolute-form target cannot slip past.
  if (kind === 'bridge' && !req.mcDevice && !bridgeNamespace) return sendJson(res, 403, { error: 'device_required' });

  if (method !== 'GET' && method !== 'HEAD' && !passesSafetyCheck(req, kind)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  if (bridgeNamespace) {
    const hit = matchRoute(method === 'HEAD' ? 'GET' : method, pathname, bridgeRoutes);
    if (!hit) return notFound(res);
    return hit.route.handler(req, res, hit.params, url);
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const hit = matchRoute(method === 'HEAD' ? 'GET' : method, pathname);
    if (!hit) return notFound(res);
    // A phone gets the default-deny policy for everything that changes state.
    if (req.mcDevice && !remoteAllowed(method, hit.route)) return sendJson(res, 403, { error: 'pc_only' });
    return hit.route.handler(req, res, hit.params, url);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  serveStatic(req, res, pathname);
}

function makeServer(kind) {
  const srv = http.createServer(async (req, res) => {
    try {
      await handleRequest(kind, req, res);
    } catch (err) {
      console.error(`[error] ${req.method} ${req.url}:`, err);
      if (!res.headersSent) sendJson(res, 400, { error: 'Bad request' });
      else res.end();
    }
  });
  srv.on('clientError', (err, socket) => socket.destroy());
  registerServer(srv);
  return srv;
}

const server = makeServer('local');

// A stray rejection from a route must never take the dashboard down.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// Seed the catalog on first run.
loadCatalog();

// index.js found the port free a moment ago; if it was taken since, this copy must not live on half started (the handler for
// uncaught exceptions above would otherwise keep it running without a listener).
server.on('error', (err) => {
  console.error(`Mission Control could not listen on ${HOST}:${PORT}: ${err.message}. This copy stops here.`);
  process.exit(73);
});
server.listen(PORT, HOST, () => {
  console.log(`Mission Control on http://${HOST}:${PORT}/ (${routes.length} routes)`);
  startProjectsBackground();
});

// The phone bridge listener. A problem here (no secret, port taken) never stops the dashboard itself.
if (BRIDGE_PORT && loadBridgeSecret()) {
  const bridgeServer = makeServer('bridge');
  bridgeServer.on('error', (err) => console.error(`[bridge] listener on ${BRIDGE_HOST}:${BRIDGE_PORT} failed:`, err.message));
  bridgeServer.listen(BRIDGE_PORT, BRIDGE_HOST, () => console.log(`Bridge listener on http://${BRIDGE_HOST}:${BRIDGE_PORT}/`));
}
