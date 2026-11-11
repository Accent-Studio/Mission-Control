// A fake mc-link (tests only, linkback.test.mjs), run by services/pcLink.js in place of the real one.
//   pair <missioncontrol-pair:ID:CODE> --name NAME   asks the other PC's server for the pairing as its bridge would
//                                                    (MC_FAKE_LINK: { url, headers, endpointId }), then writes server.json
//   serve ...                                        prints nothing and waits until stdin closes
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const state = val('--state');
const cmd = args.find((a) => a === 'pair' || a === 'serve');

if (cmd === 'serve') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (cmd === 'pair') {
  const uri = args[args.indexOf('pair') + 1];
  const [, id, code] = uri.split(':');
  const to = JSON.parse(process.env.MC_FAKE_LINK);
  const body = JSON.stringify({ endpointId: to.endpointId, code, deviceName: val('--name') });
  const u = new URL(to.url + '/api/bridge/pair');
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...to.headers, 'X-MC': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
    let s = '';
    res.on('data', (d) => (s += d));
    res.on('end', () => {
      const j = JSON.parse(s || '{}');
      if (res.statusCode !== 200 || !j.ok) { console.error(`pairing refused: ${s}`); process.exit(1); }
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, 'server.json'), JSON.stringify({ id, name: j.serverName }));
      console.log(`paired with ${j.serverName}`);
      process.exit(0);
    });
  });
  req.on('error', (err) => { console.error(err.message); process.exit(1); });
  req.end(body);
} else {
  process.exit(2);
}
