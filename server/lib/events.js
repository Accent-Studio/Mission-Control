// Server-Sent Events hub.
const clients = new Set();

const connectHooks = [];

// fn(res) is called for every new stream client, right after it joined; it may send that client something of its own (sendTo).
export function onClientConnect(fn) {
  connectHooks.push(fn);
}

// One event to one client only (the others do not get it).
export function sendTo(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`);
}

export function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  res.mcComputer = !!((req.mcDevice && req.mcDevice.computer) || (req.mcFull && req.mcFull.computer)); // services/pcLock.js
  clients.add(res);
  req.on('close', () => clients.delete(res));
  for (const fn of connectHooks) {
    try {
      fn(res);
    } catch (err) {
      console.error('[events] connect hook failed:', err.message);
    }
  }
}

const listeners = [];

// fn(type, data) hears every published event inside the server too (expiryAction.js follows the conversations it watches).
export function onPublish(fn) {
  listeners.push(fn);
}

export function publish(type, data) {
  const msg = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
  for (const fn of listeners) {
    try {
      fn(type, data);
    } catch (err) {
      console.error('[events] listener failed:', err.message);
    }
  }
}

// To the pages only: the server's own listeners (onPublish) do not hear it. For what another PC's server published,
// relayed here (services/pcLink.js): this server must not act on it as if it had happened here.
export function broadcast(type, data) {
  const msg = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}

// Ends the streams of the other computers (this PC was locked for them, services/pcLock.js): each one comes back to the lock.
export function dropComputers() {
  for (const res of clients) if (res.mcComputer) { clients.delete(res); res.end(); }
}

export function clientCount() {
  return clients.size;
}

// The clients connected right now (runs.js gives the pages that joined while it was still starting what they missed).
export function connectedClients() {
  return [...clients];
}

// Keeps idle connections open and lets dead ones close.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();
