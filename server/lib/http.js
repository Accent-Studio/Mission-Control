// Small HTTP helpers.
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function notFound(res, message = 'Not found') {
  sendJson(res, 404, { error: message });
}

export function badRequest(res, message = 'Bad request') {
  sendJson(res, 400, { error: message });
}

// Reads a JSON body (max 1 MB unless the route passes a bigger limit). An empty body gives {}.
export function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.pause();
      return reject(Object.assign(new Error('Body too large'), { status: 413 }));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Stop reading but keep the socket, so the 413 reply can still be sent (wrap() closes it after).
        chunks.length = 0;
        req.pause();
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Reads a raw body up to `limit` bytes (a longer one is refused with 413 before it is kept).
export function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    const tooBig = () => Object.assign(new Error('Body too large'), { status: 413 });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.pause();
      return reject(tooBig());
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        req.pause();
        reject(tooBig());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wraps a handler so thrown errors become a short JSON error.
export function wrap(handler) {
  return async (req, res, params, url) => {
    try {
      await handler(req, res, params, url);
    } catch (err) {
      console.error(`[error] ${req.method} ${req.url}:`, err);
      if (res.headersSent) return res.end();
      const status = err && err.status ? err.status : 500;
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
    }
  };
}
