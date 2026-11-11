// Root folders added and removed from the project tree (POST /api/roots, /api/roots/remove): the list in
// .data/config.json changes with every other setting kept, the projects in a new root folder show at once, and bad
// folders, doubles and the last root folder are refused.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { localReq, makeDataDir, startServer } from './harness.mjs';

const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
});
const post = (s, p, body) => localReq(s, { method: 'POST', path: p, body, headers: { 'X-MC': '1' } });

test('a root folder is added, listed with its projects, and removed', async () => {
  const dataDir = makeDataDir('mc-roots');
  const rootA = path.join(dataDir, 'RootA');
  const rootB = path.join(dataDir, 'RootB');
  fs.mkdirSync(path.join(rootA, 'alpha', '.git'), { recursive: true });
  fs.mkdirSync(path.join(rootB, 'bravo', '.git'), { recursive: true });
  const cfgFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ machineName: 'Test', discoveryRoots: [rootA] }));
  const s = await startServer({ dataDir, bridge: false, env: { MC_DISCOVERY_ROOTS: '' } });
  toStop.push(s);

  let r = await localReq(s, { path: '/api/projects' });
  assert.deepEqual(r.json.roots, [rootA]);
  assert.ok(!r.json.projects.some((p) => p.name === 'bravo'));

  r = await post(s, '/api/roots', { folder: `"${rootB}${path.sep}"` }); // quotes and a trailing separator, as pasted
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.roots, [rootA, rootB]);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual(cfg.discoveryRoots, [rootA, rootB]);
  assert.equal(cfg.machineName, 'Test');
  r = await localReq(s, { path: '/api/projects' });
  assert.deepEqual(r.json.roots, [rootA, rootB]);
  assert.ok(r.json.projects.some((p) => p.name === 'bravo'));

  assert.equal((await post(s, '/api/roots', { folder: rootB })).status, 409);
  assert.equal((await post(s, '/api/roots', { folder: path.join(dataDir, 'nothing-here') })).status, 404);
  assert.equal((await post(s, '/api/roots', { folder: 'relative' })).status, 400);
  assert.equal((await post(s, '/api/roots', { folder: cfgFile })).status, 400);

  r = await post(s, '/api/roots/remove', { folder: rootA });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.roots, [rootB]);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).discoveryRoots, [rootB]);
  assert.equal((await post(s, '/api/roots/remove', { folder: rootB })).status, 409);
  assert.equal((await post(s, '/api/roots/remove', { folder: rootA })).status, 404);
});

test('the root folders set by MC_DISCOVERY_ROOTS cannot be changed', async () => {
  const dataDir = makeDataDir('mc-roots-env');
  const s = await startServer({ dataDir, bridge: false });
  toStop.push(s);
  assert.equal((await post(s, '/api/roots', { folder: dataDir })).status, 409);
});
