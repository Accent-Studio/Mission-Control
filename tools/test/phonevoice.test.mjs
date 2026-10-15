// Tests for a phone's voice: POST /api/voice/transcribe (a WAV in, text out) and POST /api/voice/tts (text in, a WAV out),
// against the FAKE BlitzVoice in tools/fakevoice. Nothing here uses a microphone, a speaker or a real Claude.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ROOT, bridgeHeaders, bridgeReq, freePort, localReq, makeDataDir, removeTempDirs, seedFixture, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const toStop = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
  for (const p of procs) if (p.exitCode === null) p.kill();
  removeTempDirs();
});

async function waitUntil(pred, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// A PCM WAV: 16-bit mono at `rate`, `ms` long, a quiet tone.
function wav({ rate = 16000, channels = 1, bits = 16, ms = 300, tag = 1 } = {}) {
  const n = Math.round((rate * ms) / 1000) * channels;
  const bytes = n * (bits / 8);
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(tag, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE((rate * channels * bits) / 8, 28);
  b.writeUInt16LE((channels * bits) / 8, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(bytes, 40);
  if (bits === 16) for (let i = 0; i < n; i += channels) b.writeInt16LE(Math.round(Math.sin(i / 20) * 3000), 44 + i * 2);
  return b;
}

const WAV_HEADERS = { 'Content-Type': 'audio/wav' };

// POST bytes as a phone (through the bridge listener) or as the PC.
const phonePost = (s, p, body, headers = WAV_HEADERS) =>
  bridgeReq(s, { method: 'POST', path: p, body, hdr: { post: true }, headers });
const pcPost = (s, p, body, headers = WAV_HEADERS) => localReq(s, { method: 'POST', path: p, body, headers: { 'X-MC': '1', ...headers } });

// A binary answer (the shared helper turns every body into text).
function rawPost(port, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const phoneTts = (s, body) =>
  rawPost(s.bridgePort, '/api/voice/tts', JSON.stringify(body), {
    ...bridgeHeaders(s, { post: true }),
    Host: `127.0.0.1:${s.bridgePort}`,
    'Content-Type': 'application/json',
  });

async function boot({ withFake = true, fakeArgs = [] } = {}) {
  const dir = makeDataDir('phonevoice');
  seedFixture(dir);
  const control = path.join(dir, 'voice', 'control.json');
  const logFile = path.join(dir, 'voice', 'fakevoice.log');
  let ctl = null;
  if (withFake) {
    const fake = spawn(process.execPath, [path.join(ROOT, 'tools', 'fakevoice', 'fake-voice.js'), control, '--port', String(await freePort()), '--log', logFile, ...fakeArgs], { windowsHide: true, stdio: 'ignore' });
    procs.push(fake);
    await waitUntil(() => fs.existsSync(control), 8000, 'fake voice control file');
    ctl = JSON.parse(fs.readFileSync(control, 'utf8'));
  }
  const s = await startServer({ dataDir: dir, env: { MC_VOICE_CONTROL_FILE: control } });
  toStop.push(s);
  if (withFake) await waitUntil(async () => (await localReq(s, { path: '/api/voice' })).json?.available === true, 10000, 'voice link');
  const reqs = (p) => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.ev === 'request' && e.method === 'POST' && e.path === p);
  const fakeCall = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${ctl.port}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${ctl.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { s, reqs, fakeCall };
}

describe('POST /api/voice/transcribe', () => {
  let f;
  before(async () => {
    f = await boot();
  });

  test('a good WAV from the PC comes back as text, and the fake got the bytes as audio/wav', async () => {
    const audio = wav();
    const r = await pcPost(f.s, '/api/voice/transcribe', audio);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { text: "what's the status of BlitzRaw" });
    const sent = f.reqs('/transcribe').at(-1);
    assert.equal(sent.body.bytes, audio.length);
    assert.equal(sent.body.type, 'audio/wav');
  });

  test('a phone on the bridge listener is allowed (not pc_only)', async () => {
    const r = await phonePost(f.s, '/api/voice/transcribe', wav());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.text, "what's the status of BlitzRaw");
  });

  test('the text the fake is set to say comes back, and an empty text stays empty', async () => {
    await f.fakeCall('/test/transcribe-text', { text: '  how is the weather ' });
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).json.text, 'how is the weather');
    await f.fakeCall('/test/transcribe-text', { text: '' });
    const r = await phonePost(f.s, '/api/voice/transcribe', wav());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { text: '' });
    await f.fakeCall('/test/transcribe-text', { text: "what's the status of BlitzRaw" });
  });

  test('a body that is not a WAV, or the wrong format, is a 400 and never reaches BlitzVoice', async () => {
    const before = f.reqs('/transcribe').length;
    const notRiff = Buffer.from('this is not audio at all, it is just a long enough line of plain text...');
    const wrongRate = wav({ rate: 48000 });
    const stereo = wav({ channels: 2 });
    const eightBit = wav({ bits: 8 });
    const floaty = wav({ tag: 3 });
    const noData = wav().subarray(0, 36);
    for (const [name, body] of [['text', notRiff], ['48 kHz', wrongRate], ['stereo', stereo], ['8-bit', eightBit], ['float', floaty], ['no data', noData], ['empty', Buffer.alloc(0)]]) {
      const r = await phonePost(f.s, '/api/voice/transcribe', body);
      assert.equal(r.status, 400, name);
      assert.ok(r.json.error, name);
    }
    assert.equal(f.reqs('/transcribe').length, before);
  });

  test('another content type is a 415', async () => {
    assert.equal((await pcPost(f.s, '/api/voice/transcribe', wav(), { 'Content-Type': 'application/json' })).status, 415);
    assert.equal((await pcPost(f.s, '/api/voice/transcribe', wav(), { 'Content-Type': 'audio/wav; codecs=1' })).status, 200);
  });

  test('over 4 MB is a 413: by Content-Length at once, and while streaming without one', async () => {
    const before = f.reqs('/transcribe').length;
    const big = Buffer.concat([wav(), Buffer.alloc(4 * 1024 * 1024 + 10)]);
    const r = await phonePost(f.s, '/api/voice/transcribe', big).catch(() => ({ status: 0 }));
    assert.ok(r.status === 413 || r.status === 0, `status ${r.status}`); // a reset connection is also a refusal
    // Chunked: no length is declared, so only the streaming cap can stop it.
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: f.s.bridgePort, path: '/api/voice/transcribe', method: 'POST', agent: false,
        headers: { ...bridgeHeaders(f.s, { post: true }), Host: `127.0.0.1:${f.s.bridgePort}`, 'Content-Type': 'audio/wav', 'Transfer-Encoding': 'chunked' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      const chunk = Buffer.alloc(256 * 1024);
      let n = 0;
      const pump = () => {
        while (n++ < 20) if (!req.write(chunk)) return req.once('drain', pump);
        req.end();
      };
      pump();
    });
    assert.ok(status === 413 || status === 0, `streamed status ${status}`);
    assert.equal(f.reqs('/transcribe').length, before);
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200, 'the server keeps answering');
  });

  test('BlitzVoice busy (a dictation on the PC is running) is a 409 busy', async () => {
    const st = await pcPost(f.s, '/api/voice/start', {}, { 'Content-Type': 'application/json' });
    assert.equal(st.status, 200);
    try {
      const r = await phonePost(f.s, '/api/voice/transcribe', wav());
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'busy');
    } finally {
      await pcPost(f.s, '/api/voice/cancel', {}, { 'Content-Type': 'application/json' });
    }
    await waitUntil(async () => (await phonePost(f.s, '/api/voice/transcribe', wav())).status === 200, 4000, 'idle again');
  });

  test('no "Model for Mission Control" chosen in BlitzVoice is its own 409, not busy', async () => {
    await f.fakeCall('/test/fail', { transcribe: 'no_link_model' });
    try {
      const r = await phonePost(f.s, '/api/voice/transcribe', wav());
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'no_link_model');
      assert.match(r.json.reason, /Model for Mission Control/);
    } finally {
      await f.fakeCall('/test/fail', { transcribe: null });
    }
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('without X-MC a phone is refused, like any other change', async () => {
    const r = await bridgeReq(f.s, { method: 'POST', path: '/api/voice/transcribe', body: wav(), headers: WAV_HEADERS });
    assert.equal(r.status, 403);
  });
});

describe('POST /api/voice/tts', () => {
  let f;
  before(async () => {
    f = await boot();
    // The phone always transcribes before it speaks, and that is how the server learns this BlitzVoice takes to:"wav".
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('a phone gets audio/wav bytes, no-store, nosniff, and BlitzVoice was asked for a WAV', async () => {
    const r = await phoneTts(f.s, { text: 'Hello there.' });
    assert.equal(r.status, 200, r.bytes.toString().slice(0, 200));
    assert.equal(r.headers['content-type'], 'audio/wav');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.bytes.toString('latin1', 0, 4), 'RIFF');
    assert.equal(r.bytes.toString('latin1', 8, 12), 'WAVE');
    assert.equal(r.bytes.readUInt32LE(24), 24000);
    assert.equal(Number(r.headers['content-length']), r.bytes.length);
    const sent = f.reqs('/speak').at(-1).body;
    assert.deepEqual(sent, { text: 'Hello there.', to: 'wav' });
  });

  test('nothing plays on the PC: the fake never went to speaking', async () => {
    const ev = fs.readFileSync(path.join(f.s.dataDir, 'voice', 'fakevoice.log'), 'utf8');
    assert.ok(!ev.includes('"state":"speaking"'));
  });

  test('markdown, links and Com Link memory tags are cleaned like the PC voice does', async () => {
    const text = 'Done **now**. See [the log](https://example.com/x) and C:\\Users\\me\\a.txt.\n\n```js\nconsole.log(1)\n```\n- first\n- second<remember>He likes cigars.</remember>';
    const r = await phoneTts(f.s, { text });
    assert.equal(r.status, 200);
    const said = f.reqs('/speak').at(-1).body.text;
    assert.ok(!/[*`\\]|https?:|<remember>|cigars|console/.test(said), said);
    assert.match(said, /^Done now\. See the log/);
    assert.match(said, /first\. second\.?$/);
  });

  test('a long reply is cut near 4000 characters, at a sentence end when there is one', async () => {
    const text = 'This is one more sentence of the long reply. '.repeat(200);
    const r = await phoneTts(f.s, { text });
    assert.equal(r.status, 200);
    const said = f.reqs('/speak').at(-1).body.text;
    assert.ok(said.length <= 4000 && said.length > 3000, `length ${said.length}`);
    assert.ok(said.endsWith('reply.'), said.slice(-30));
  });

  test('a missing text is a 400, and text with nothing to say is a 204 that asks BlitzVoice for nothing', async () => {
    assert.equal((await phoneTts(f.s, {})).status, 400);
    assert.equal((await phoneTts(f.s, { text: '   ' })).status, 400);
    assert.equal((await phoneTts(f.s, { text: 5 })).status, 400);
    const before = f.reqs('/speak').length;
    const quiet = await phoneTts(f.s, { text: '<remember>only a note</remember>' });
    assert.equal(quiet.status, 204);
    assert.equal(quiet.bytes.length, 0);
    assert.equal(f.reqs('/speak').length, before);
  });

  test('BlitzVoice busy with another WAV job is a 409 busy', async () => {
    await f.fakeCall('/test/fail', { speak: 'busy' });
    try {
      const r = await phoneTts(f.s, { text: 'Hello again.' });
      assert.equal(r.status, 409);
      assert.equal(JSON.parse(r.bytes.toString()).error, 'busy');
    } finally {
      await f.fakeCall('/test/fail', { speak: null });
    }
  });

  test('the PC may call it too, and /api/voice/speak stays PC-only for a phone', async () => {
    const pc = await pcPost(f.s, '/api/voice/tts', JSON.stringify({ text: 'Hi.' }), { 'Content-Type': 'application/json' });
    assert.equal(pc.status, 200);
    const speak = await phonePost(f.s, '/api/voice/speak', JSON.stringify({ text: 'Hi.' }), { 'Content-Type': 'application/json' });
    assert.equal(speak.status, 403);
    assert.deepEqual(speak.json, { error: 'pc_only' });
  });
});

describe('the voice is always the configured one', () => {
  let f;
  before(async () => {
    f = await boot();
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('a "voice" field from the phone is ignored, even a wrong type, and never reaches BlitzVoice', async () => {
    for (const voice of ['af_bella', 5, { x: 1 }]) {
      const r = await phoneTts(f.s, { text: 'Hello.', voice });
      assert.equal(r.status, 200, JSON.stringify(voice));
      assert.deepEqual(f.reqs('/speak').at(-1).body, { text: 'Hello.', to: 'wav' });
    }
  });
});

describe('an old BlitzVoice must never speak on the PC', () => {
  let f;
  before(async () => {
    f = await boot({ fakeArgs: ['--old'] });
  });

  test('tts before any transcribe is a 503 "needs an update" and BlitzVoice is not asked to speak', async () => {
    const r = await phoneTts(f.s, { text: 'Hello.' });
    assert.equal(r.status, 503);
    const j = JSON.parse(r.bytes.toString());
    assert.equal(j.error, 'unavailable');
    assert.match(j.reason, /needs an update/);
    assert.equal(f.reqs('/speak').length, 0);
  });

  test('an old one answers /transcribe with a 413 (over 4 KB) or a 400, which prove nothing: it stays unsupported and gets no /speak', async () => {
    const big = await phonePost(f.s, '/api/voice/transcribe', wav());
    assert.equal(f.reqs('/transcribe').at(-1).reply.error, 'too large');
    assert.ok(big.status >= 400 && big.status !== 200, `status ${big.status}`);
    const small = await phonePost(f.s, '/api/voice/transcribe', wav({ ms: 50 }));
    assert.equal(f.reqs('/transcribe').at(-1).status, 400);
    assert.ok(small.status >= 400 && small.status !== 200, `status ${small.status}`);
    for (let i = 0; i < 2; i++) {
      const r = await phoneTts(f.s, { text: 'Hello.' });
      assert.equal(r.status, 503);
      assert.match(JSON.parse(r.bytes.toString()).reason, /needs an update/);
    }
    assert.equal(f.reqs('/speak').length, 0);
    const ev = fs.readFileSync(path.join(f.s.dataDir, 'voice', 'fakevoice.log'), 'utf8');
    assert.ok(!ev.includes('"state":"speaking"'));
  });
});

describe('an old BlitzVoice that answers /transcribe with a 404', () => {
  let f;
  before(async () => {
    f = await boot({ fakeArgs: ['--old404'] });
  });

  test('it stays unsupported, says it is too old, and still gets no /speak', async () => {
    const t = await phonePost(f.s, '/api/voice/transcribe', wav());
    assert.equal(t.status, 503);
    assert.match(t.json.reason, /too old/);
    const r = await phoneTts(f.s, { text: 'Hello.' });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.bytes.toString()).reason, /needs an update/);
    assert.equal(f.reqs('/speak').length, 0);
    const ev = fs.readFileSync(path.join(f.s.dataDir, 'voice', 'fakevoice.log'), 'utf8');
    assert.ok(!ev.includes('"state":"speaking"'));
  });
});

describe('BlitzVoice closes the connection in the middle of an answer', () => {
  let f;
  before(async () => {
    f = await boot();
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('transcribe and tts answer 503 at once (not a hang), and the phone slots come back', async () => {
    for (const kind of ['transcribe', 'speak']) {
      await f.fakeCall('/test/fail', { [kind]: 'cut' });
      try {
        // More cuts than there are slots (2): a leaked slot would turn the later ones into a 429, or hang.
        for (let i = 0; i < 4; i++) {
          const r = kind === 'transcribe' ? await phonePost(f.s, '/api/voice/transcribe', wav()) : await phoneTts(f.s, { text: 'Hello.' });
          assert.equal(r.status, 503, `${kind} ${i}`);
          const j = kind === 'transcribe' ? r.json : JSON.parse(r.bytes.toString());
          assert.equal(j.error, 'unavailable');
        }
      } finally {
        await f.fakeCall('/test/fail', { [kind]: null });
      }
    }
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
    assert.equal((await phoneTts(f.s, { text: 'Back again.' })).status, 200);
  });
});

describe('a new BlitzVoice that has not been asked yet', () => {
  let f;
  before(async () => {
    f = await boot();
  });

  test('tts is a 503 until a /transcribe has been answered, then it works', async () => {
    const first = await phoneTts(f.s, { text: 'Hello.' });
    assert.equal(first.status, 503);
    assert.match(JSON.parse(first.bytes.toString()).reason, /needs an update/);
    assert.equal(f.reqs('/speak').length, 0);
    // A 409 (busy, or no model chosen) is still an answer from a BlitzVoice that knows /transcribe.
    await f.fakeCall('/test/fail', { transcribe: 'no_link_model' });
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 409);
    await f.fakeCall('/test/fail', { transcribe: null });
    assert.equal((await phoneTts(f.s, { text: 'Hello.' })).status, 200);
  });
});

describe('phone voice limits', () => {
  let f;
  before(async () => {
    f = await boot();
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('at most 2 jobs run at once (transcribe and tts together): the third is a 429 busy that BlitzVoice never sees', async () => {
    await f.fakeCall('/test/hold', { transcribe: 1500, speak: 1500 });
    try {
      const t0 = f.reqs('/transcribe').length;
      const s0 = f.reqs('/speak').length;
      const a = phonePost(f.s, '/api/voice/transcribe', wav());
      const b = phoneTts(f.s, { text: 'One moment.' });
      await sleep(400); // both are now held for 1.5 s by the fake
      const c = await phonePost(f.s, '/api/voice/transcribe', wav());
      assert.equal(c.status, 429);
      assert.deepEqual(c.json, { error: 'busy' });
      const d = await phoneTts(f.s, { text: 'Too many.' });
      assert.equal(d.status, 429);
      assert.deepEqual(JSON.parse(d.bytes.toString()), { error: 'busy' });
      // Answered before the body is read: even a body that is not a WAV gets the 429, not a 400.
      assert.equal((await phonePost(f.s, '/api/voice/transcribe', Buffer.from('nope'))).status, 429);
      assert.equal((await a).status, 200);
      assert.equal((await b).status, 200);
      assert.equal(f.reqs('/transcribe').length, t0 + 1, 'only the first transcribe reached BlitzVoice');
      assert.equal(f.reqs('/speak').length, s0 + 1, 'only the first tts reached BlitzVoice');
    } finally {
      await f.fakeCall('/test/hold', { transcribe: 0, speak: 0 });
    }
    // The slots came back.
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
    assert.equal((await phoneTts(f.s, { text: 'Free again.' })).status, 200);
  });

  test('a slot is freed after an error too (a bad body, a refused type)', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await phonePost(f.s, '/api/voice/transcribe', Buffer.from('nope'))).status, 400);
      assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav(), { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await phoneTts(f.s, {})).status, 400);
    }
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', wav())).status, 200);
  });

  test('an oversized BlitzVoice reply is dropped (a 503), and the server keeps working', async () => {
    await f.fakeCall('/test/fail', { speak: 'big' });
    try {
      const r = await phoneTts(f.s, { text: 'Big one.' });
      assert.equal(r.status, 503); // handled like an answer that never came
      assert.equal(JSON.parse(r.bytes.toString()).error, 'unavailable');
    } finally {
      await f.fakeCall('/test/fail', { speak: null });
    }
    assert.equal((await phoneTts(f.s, { text: 'Normal.' })).status, 200);
  });
});

describe('BlitzVoice not reachable', () => {
  let f;
  before(async () => {
    f = await boot({ withFake: false });
  });

  test('transcribe and tts answer 503 with a short reason', async () => {
    const t = await phonePost(f.s, '/api/voice/transcribe', wav());
    assert.equal(t.status, 503);
    assert.equal(t.json.error, 'unavailable');
    assert.equal(t.json.reason, 'BlitzVoice is not running.');
    const s = await phoneTts(f.s, { text: 'Hello.' });
    assert.equal(s.status, 503);
    assert.equal(JSON.parse(s.bytes.toString()).reason, 'BlitzVoice is not running.');
  });

  test('a bad body is still judged first: a 400, not a 503', async () => {
    assert.equal((await phonePost(f.s, '/api/voice/transcribe', Buffer.from('nope'))).status, 400);
  });
});
