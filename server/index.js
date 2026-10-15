// Mission Control server entry point. It makes sure the port is free before the server itself (app.js) loads, because
// loading it already takes the runner over and starts timers (Send later, At 5 min left). A second Mission Control started
// while one runs must stop here, before it can take the runner from the real one or send anything twice.
import net from 'node:net';
import { HOST, PORT } from './config.js';

const TRIES = 10; // a restart (exit code 75) starts the next server at once: give the old one a moment to let go of the port
const WAIT_MS = 500;

function portFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err)));
    probe.listen(PORT, HOST, () => probe.close(() => resolve(true)));
  });
}

let free = false;
for (let i = 0; i < TRIES && !free; i++) {
  if (i) await new Promise((r) => setTimeout(r, WAIT_MS));
  free = await portFree();
}
if (!free) {
  console.error(`Port ${PORT} is taken: Mission Control is probably running already. This copy stops here.`);
  process.exit(73);
}
await import('./app.js');
