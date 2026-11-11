// The linked PC's graphics card in this PC's status bar (services/pcLink.js): while a page is open, its memory use is
// read through the link and reaches the pages as pc.gpu; a PC that stops answering clears it. A fake PC stands in for it.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import { freePort, makeDataDir, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});

async function waitFor(fn, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(40);
  }
}

describe('the linked PC\'s graphics card', () => {
  test('reaches the pages as pc.gpu, and is cleared when that PC stops answering', async () => {
    const home = { used: 14.2, up: true, reads: 0 };
    const port = await freePort();
    const fake = http.createServer((req, res) => {
      if (req.url === '/api/system' && home.up) {
        home.reads++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ cpu: {}, gpu: { name: 'RTX Test', vramTotalGB: 15.99, vramUsedGB: home.used, utilPct: 37, tempC: 50 }, gpuProcs: [{ pid: 1, name: 'llama-server.exe' }] }));
      }
      res.writeHead(home.up ? 404 : 503);
      res.end('{}');
    });
    await new Promise((r) => fake.listen(port, '127.0.0.1', r));
    toStop.push({ stop: async () => fake.close() });

    const W = await startServer({ dataDir: makeDataDir('mc-pcgpu'), bridge: false, env: { MC_PC_LINK_TEST: JSON.stringify({ name: 'Home', url: `http://127.0.0.1:${port}`, headers: {} }), MC_PC_GPU_POLL_MS: '300' } });
    toStop.push(W);
    await sleep(500);
    assert.equal(home.reads, 0, 'nothing is read while no page is open');

    const seen = [];
    const req = http.get({ host: '127.0.0.1', port: W.port, path: '/api/events', headers: { Host: `127.0.0.1:${W.port}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.startsWith('data: ')) continue;
          try { const m = JSON.parse(block.slice(6)); if (m.type === 'pc.gpu') seen.push(m.data); } catch { /* not JSON */ }
        }
      });
    });
    req.on('error', () => {});
    toStop.push({ stop: async () => req.destroy() });

    const first = await waitFor(() => seen.find((g) => g), 'the first reading');
    assert.deepEqual(first, { machine: 'Home', name: 'RTX Test', vramUsedGB: 14.2, vramTotalGB: 15.99, utilPct: 37 }, 'only the card, with that PC\'s name');

    home.used = 3.5;
    await waitFor(() => seen.find((g) => g && g.vramUsedGB === 3.5), 'a new reading after the use changed');
    const n = seen.length;
    await sleep(900);
    assert.equal(seen.length, n, 'an unchanged reading is not sent again');

    home.up = false;
    await waitFor(() => seen.length > n && seen[seen.length - 1] === null, 'the reading cleared');
  });
});
