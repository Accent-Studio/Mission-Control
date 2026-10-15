// Fake BlitzVoice control server (tests only). Serves the Mission Control link contract on a 47xxx port,
// writes a control.json for Mission Control to find, and logs every request. No microphone, no speech, no model.
//
//   node fake-voice.js <path to control.json> [--port 47321] [--speak-ms 4000] [--cleanup-unavailable] [--log <file>] [--transcribe-text "..."] [--old]
// --old acts like a BlitzVoice from before phone voice: it does not know /transcribe, so (as the real old one does, before it
// routes) a body over 4 KB is a 413 and a smaller one that is not JSON is a 400; /speak ignores to:"wav" (it speaks, state "speaking").
// --old404 is the same but /transcribe is a plain 404.
//
// Contract: GET /events (SSE), POST /start {deliver, cleanup?, model?, partials?, autostop?}, /stop, /cancel, /discard,
// /speak {text, voice?, to?} (to: "wav" answers with a WAV and plays nothing), /speak/stop, POST /transcribe (a WAV body, for a phone's
// recording), GET /wake and POST /wake {enabled?, model?, threshold?, autostop?} (the wake word),
// and the test helpers POST /test/wake {text?, delay?} (acts out a wake dictation), POST /test/say {text, delay?, replace?}
// (words arrive as growing "partial" events of the dictation in progress) and POST /test/wake-status {state?, paused_reason?,
// error?} (forces a status).
// Every call needs "Authorization: Bearer <token>" (the token is in control.json).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n) => {
  const k = args.indexOf(n);
  return k >= 0 ? args[k + 1] : null;
};
const controlFile = args.find((a, i) => !a.startsWith('--') && (i === 0 || !['--port', '--speak-ms', '--log', '--wake-model', '--cap-ms', '--transcribe-text', '--tone-ms'].includes(args[i - 1])));
if (!controlFile) {
  console.error('Usage: node fake-voice.js <path to control.json> [--port N] [--speak-ms N] [--cleanup-unavailable] [--log file]');
  process.exit(2);
}
const WAKE_MODELS = [{ id: 'hey_jarvis_v0.1', bundled: true }, { id: 'alexa_v0.1', bundled: true }];
const SPEAK_MS = Number(flag('--speak-ms')) || 4000;
const CAP_MS = Number(flag('--cap-ms')) || 120000; // a dictation with no automatic stop ends this long after it began
const CLEANUP_UNAVAILABLE = args.includes('--cleanup-unavailable');
const logFile = flag('--log') || path.join(path.dirname(path.resolve(controlFile)), 'fakevoice.log');
const token = crypto.randomBytes(16).toString('hex');
const port = Number(flag('--port')) || 47200 + Math.floor(Math.random() * 700);

const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
};

let state = 'idle';
let nextId = 1;
let recId = null;
let rec = null; // the dictation in progress: { id, partials, autostop, wake, text, timers }
let capTimer = null;
let speakTimer = null;
let transcribeTimer = null;
let levelTimer = null;
const clients = new Set();

// ---- wake word ----
const wk = { enabled: false, model: flag('--wake-model') || WAKE_MODELS[0].id, threshold: 0.5, autostop: 'silence', force: null };
let lastWakeJson = '';
function wakeStatus() {
  const f = wk.force || {};
  let st = 'off';
  let why = null;
  if (wk.enabled) {
    st = 'listening';
    if (clients.size === 0) { st = 'paused'; why = 'no_link'; }
    else if (state === 'speaking') { st = 'paused'; why = 'speaking'; }
    else if (state === 'recording' || state === 'transcribing') { st = 'paused'; why = 'dictating'; }
  }
  if (f.state) { st = f.state; why = f.paused_reason || null; }
  return {
    enabled: wk.enabled, state: st, paused_reason: why, model: wk.model, threshold: wk.threshold,
    models: WAKE_MODELS, autostop: wk.autostop, error: f.error || (st === 'error' ? 'The wake word model could not load' : null),
  };
}
// Sends wake_state when the status differs from the last one sent.
function pushWake() {
  const status = wakeStatus();
  const j = JSON.stringify(status);
  if (j === lastWakeJson) return;
  lastWakeJson = j;
  log({ ev: 'wake_state', state: status.state, paused_reason: status.paused_reason, enabled: status.enabled });
  send('wake_state', { type: 'wake_state', status });
}

function send(name, data) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function setState(s) {
  if (state === s) return;
  state = s;
  log({ ev: 'state', state });
  send('state', { type: 'state', state });
  pushWake();
  clearInterval(levelTimer);
  if (s === 'recording') levelTimer = setInterval(() => send('level', { type: 'level', value: Math.random() * 0.6 }), 100);
}
// ---- live dictation ----
function beginRec(id, o) {
  clearTimeout(capTimer);
  if (rec) rec.timers.forEach(clearTimeout);
  rec = { id, partials: o.partials === true, autostop: o.autostop === 'none' || o.autostop === 'silence' ? o.autostop : 'silence', wake: !!o.wake, model: o.model || null, text: '', timers: [] };
  recId = id;
  setState('recording');
  // No automatic stop: the dictation ends by /stop, /cancel or /discard, or at the cap with an empty "timeout" transcript.
  if (rec.autostop === 'none') {
    capTimer = setTimeout(() => {
      if (!rec || rec.id !== id || state !== 'recording') return;
      log({ ev: 'cap', id });
      send('transcript', Object.assign({ type: 'transcript', id, text: '', error: 'timeout' }, rec.wake ? { wake: true } : {}));
      endRec();
      setState('idle');
    }, CAP_MS);
  }
}
function endRec() {
  clearTimeout(capTimer);
  if (rec) rec.timers.forEach(clearTimeout);
  rec = null;
}
function emitPartial() {
  if (rec && rec.partials) send('partial', { type: 'partial', id: rec.id, text: rec.text });
}
// Says the words one by one (growing partials) after the existing text, or instead of it with replace.
function sayWords(text, gap, replace) {
  if (!rec) return 0;
  const words = String(text).split(/\s+/).filter(Boolean);
  if (replace) {
    rec.text = '';
    if (!words.length) emitPartial();
  }
  words.forEach((w, i) => {
    const r = rec;
    r.timers.push(setTimeout(() => {
      if (rec !== r || state !== 'recording') return;
      r.text = (r.text ? r.text + ' ' : '') + w;
      emitPartial();
    }, gap * (i + 1)));
  });
  return words.length;
}
function endSpeech() {
  clearTimeout(speakTimer);
  speakTimer = null;
}

// ---- audio for the phone flow: /transcribe takes a WAV, /speak with to:"wav" gives one back ----
const WAV_MAX = 4 * 1024 * 1024;
const TONE_MS = Number(flag('--tone-ms')) || 600; // length of the tone /speak with to:"wav" gives back
let transcribeText = flag('--transcribe-text') ?? process.env.FAKEVOICE_TRANSCRIBE_TEXT ?? "what's the status of BlitzRaw";

// Checks the same things the real one does: RIFF/WAVE, a PCM 16-bit mono 16000 Hz fmt chunk and a data chunk.
// Returns { seconds } or { error }.
const forceFail = { transcribe: null, speak: null }; // set by POST /test/fail
const holdMs = { transcribe: 0, speak: 0 }; // set by POST /test/hold: how long the next answers wait (for in-flight limit checks)
const OLD404 = args.includes('--old404');
const OLD = args.includes('--old') || OLD404; // acts like a BlitzVoice before phone voice: no /transcribe, and /speak ignores to:"wav" (so it plays)

// Answers with the headers and 5 bytes of a 100 byte body, then drops the connection (the test mode "cut").
function cutReply(res, req, sent) {
  log({ ev: 'request', method: req.method, path: req.url, body: sent, status: 200, reply: 'cut' });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100, Connection: 'close' });
  res.write('{"ok"', () => res.socket.destroy());
}
const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);
function checkWav(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return { error: 'not a WAV file' };
  let fmt = null;
  let dataBytes = -1;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && size >= 16 && at + 8 + 16 <= buf.length) {
      fmt = { tag: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - (at + 8));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt) return { error: 'no fmt chunk' };
  if (fmt.tag !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return { error: 'need PCM 16-bit mono 16000 Hz' };
  if (dataBytes < 0) return { error: 'no data chunk' };
  return { seconds: dataBytes / 32000 };
}

// A short sine tone as a PCM 16-bit mono WAV.
function toneWav(ms, rate, hz = 440) {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 240, (n - i) / 240); // no click at either end
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 9000 * fade), 44 + i * 2);
  }
  return buf;
}

// Reads a raw body up to `limit` bytes; resolves null when it is longer.
function readRaw(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        resolve(null);
      }
    });
  });
}
function reply(res, status, body, req, sent) {
  const out = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out), Connection: 'close' });
  res.end(out);
  log({ ev: 'request', method: req.method, path: req.url, body: sent, status, reply: body });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    log({ ev: 'request', method: req.method, path: req.url, status: 401 });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error":"unauthorized"}');
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', state })}\n\n`);
    clients.add(res);
    // the new subscriber always gets the current status; the others only when it changed
    const before = lastWakeJson;
    pushWake();
    if (lastWakeJson === before) res.write(`event: wake_state\ndata: ${JSON.stringify({ type: 'wake_state', status: wakeStatus() })}\n\n`);
    log({ ev: 'request', method: 'GET', path: '/events', status: 200, clients: clients.size });
    req.on('close', () => { clients.delete(res); pushWake(); });
    return;
  }
  if (req.method === 'GET' && req.url.replace(/\/+$/, '') === '/wake') return reply(res, 200, wakeStatus(), req, null);
  if (req.method !== 'POST') return reply(res, 404, { error: 'not found' }, req, null);
  if (req.url.replace(/\/+$/, '') === '/transcribe') {
    // A phone's recording: a WAV body, not JSON. The answer is the text set by --transcribe-text, the environment or /test/transcribe-text.
    if (OLD && !OLD404) {
      const small = await readRaw(req, 4096);
      if (!small) return reply(res, 413, { error: 'too large' }, req, { bytes: 'over 4 KB' });
      return reply(res, 400, { error: 'invalid json' }, req, { bytes: small.length });
    }
    const raw = await readRaw(req, WAV_MAX);
    if (OLD) return reply(res, 404, { error: 'not found' }, req, { bytes: raw ? raw.length : 0 });
    await wait(holdMs.transcribe);
    if (!raw) return reply(res, 413, { error: 'too_large' }, req, { bytes: 'over 4 MB' });
    const sent = { bytes: raw.length, type: req.headers['content-type'] || '' };
    if (forceFail.transcribe === 'cut') return cutReply(res, req, sent);
    const wav = checkWav(raw);
    if (wav.error) return reply(res, 400, { error: 'bad_audio' }, req, { ...sent, why: wav.error });
    if (forceFail.transcribe === 'no_link_model') return reply(res, 409, { error: 'no_link_model' }, req, { ...sent, seconds: wav.seconds });
    if (forceFail.transcribe === 'busy' || state === 'recording' || state === 'transcribing') return reply(res, 409, { error: 'busy' }, req, { ...sent, seconds: wav.seconds });
    return reply(res, 200, { ok: true, text: transcribeText, ms: 120 }, req, { ...sent, seconds: wav.seconds });
  }
  const body = await readBody(req);
  if (body === null) return reply(res, 400, { error: 'invalid json' }, req, null);
  const p = req.url.replace(/\/+$/, '');

  if (p === '/start') {
    if (state !== 'idle' && state !== 'speaking') return reply(res, 409, { error: 'busy' }, req, body);
    if (state === 'speaking') {
      endSpeech();
    }
    const id = String(nextId++);
    beginRec(id, { partials: body.partials, autostop: body.autostop, model: body.model });
    const r = { ok: true, id };
    if (body.cleanup === true && CLEANUP_UNAVAILABLE) r.cleanup = 'unavailable';
    return reply(res, 200, r, req, body);
  }
  if (p === '/stop') {
    if (state !== 'recording') return reply(res, 409, { error: 'not recording' }, req, body);
    const id = recId;
    const text = rec && rec.text ? rec.text : `fake dictation ${id}`;
    const wakeFlag = rec && rec.wake;
    endRec();
    setState('transcribing');
    transcribeTimer = setTimeout(() => {
      send('transcript', Object.assign({ type: 'transcript', id, text }, wakeFlag ? { wake: true } : {}));
      setState('idle');
    }, 600);
    return reply(res, 200, { ok: true, id }, req, body);
  }
  if (p === '/cancel') {
    if (state !== 'recording') return reply(res, 409, { error: 'not recording' }, req, body);
    endRec();
    setState('idle');
    return reply(res, 200, { ok: true }, req, body);
  }
  if (p === '/discard') {
    // Ends at once: no transcription, no paste, no transcript event.
    if (state !== 'recording') return reply(res, 409, { error: 'not recording' }, req, body);
    endRec();
    setState('idle');
    return reply(res, 200, { ok: true }, req, body);
  }
  if (p === '/speak') {
    if (typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 20000) return reply(res, 400, { error: 'text must be 1 to 20000 characters' }, req, body);
    if (body.to === 'wav' && !OLD) {
      // The phone flow: the voice comes back as a WAV and nothing plays on the PC (no state change).
      // The real one takes at most 4000 characters and one job at a time.
      if (body.text.length > 4000) return reply(res, 400, { error: 'text must be 1 to 4000 characters for a WAV' }, req, body);
      if (forceFail.speak === 'busy') return reply(res, 409, { error: 'busy' }, req, body);
      await wait(holdMs.speak);
      if (forceFail.speak === 'cut') return cutReply(res, req, body);
      if (forceFail.speak === 'big') return reply(res, 200, { ok: true, wav: 'A'.repeat(13 * 1024 * 1024) }, req, body); // bigger than a phone reply may be
      const wav = toneWav(TONE_MS, 24000);
      return reply(res, 200, { ok: true, wav: wav.toString('base64'), seconds: TONE_MS / 1000, ms: 80 }, req, body);
    }
    if (state === 'recording' || state === 'transcribing') return reply(res, 409, { error: 'busy' }, req, body);
    endSpeech();
    setState('speaking');
    speakTimer = setTimeout(() => {
      speakTimer = null;
      if (state === 'speaking') setState('idle');
    }, SPEAK_MS);
    return reply(res, 200, { ok: true }, req, body);
  }
  if (p === '/speak/stop') {
    endSpeech();
    if (state === 'speaking') setState('idle');
    return reply(res, 200, { ok: true }, req, body);
  }
  if (p === '/wake') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { error: 'send an object' }, req, body);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => !['enabled', 'model', 'threshold', 'autostop'].includes(k))) return reply(res, 400, { error: 'only enabled, model, threshold and autostop are accepted' }, req, body);
    if ('autostop' in body && body.autostop !== 'silence' && body.autostop !== 'phrase') return reply(res, 400, { error: 'autostop must be silence or phrase' }, req, body);
    if ('enabled' in body && typeof body.enabled !== 'boolean') return reply(res, 400, { error: 'enabled must be true or false' }, req, body);
    if ('model' in body && !WAKE_MODELS.some((m) => m.id === body.model)) return reply(res, 400, { error: 'unknown model' }, req, body);
    if ('threshold' in body && !(typeof body.threshold === 'number' && body.threshold >= 0.05 && body.threshold <= 0.99)) return reply(res, 400, { error: 'threshold must be 0.05 to 0.99' }, req, body);
    if ('enabled' in body) wk.enabled = body.enabled;
    if ('model' in body) wk.model = body.model;
    if ('threshold' in body) wk.threshold = body.threshold;
    if ('autostop' in body) wk.autostop = body.autostop;
    pushWake();
    return reply(res, 200, wakeStatus(), req, body);
  }
  // Test helpers (not part of the contract): change what /transcribe answers, force a status, or act out what the wake word does.
  if (p === '/test/fail') {
    // {transcribe: "no_link_model" | "busy" | "cut" | null, speak: "busy" | "big" | "cut" | null}: the next calls of that kind fail until
    // it is called again. "cut" sends the headers (Content-Length 100) and 5 bytes, then drops the connection.
    for (const k of ['transcribe', 'speak']) if (k in body) forceFail[k] = typeof body[k] === 'string' ? body[k] : null;
    return reply(res, 200, { ok: true, ...forceFail }, req, body);
  }
  if (p === '/test/hold') {
    // {transcribe: ms, speak: ms}: the answers of those calls wait that long (0 turns it off).
    for (const k of ['transcribe', 'speak']) if (k in body) holdMs[k] = Math.max(0, Math.min(10000, Number(body[k]) || 0));
    return reply(res, 200, { ok: true, ...holdMs }, req, body);
  }
  if (p === '/test/transcribe-text') {
    if (typeof body.text !== 'string') return reply(res, 400, { error: 'text is required' }, req, body);
    transcribeText = body.text;
    return reply(res, 200, { ok: true, text: transcribeText }, req, body);
  }
  if (p === '/test/wake-status') {
    wk.force = body && (body.state || body.error) ? { state: body.state || null, paused_reason: body.paused_reason || null, error: body.error || null } : null;
    pushWake();
    return reply(res, 200, wakeStatus(), req, body);
  }
  if (p === '/test/wake') {
    if (wakeStatus().state !== 'listening') return reply(res, 409, { error: 'wake word is not listening', status: wakeStatus() }, req, body);
    const id = typeof body.id === 'string' && body.id ? body.id : String(nextId++); // an explicit id replays one (for the dedupe check)
    const text = typeof body.text === 'string' ? body.text : 'fake wake dictation';
    const gap = Math.max(50, Number(body.delay) || 400);
    send('wake', { type: 'wake', id, model: wk.model, score: 0.93 });
    if (wk.autostop === 'phrase') {
      // Phrase mode: partials on, no silence stop. It runs until /stop, /cancel or /discard (or the cap). A text given here is said word by word.
      beginRec(id, { partials: true, autostop: 'none', wake: true });
      if (typeof body.text === 'string' && body.text.trim()) sayWords(body.text, Math.max(10, Number(body.wordDelay) || 60), false);
      return reply(res, 200, { ok: true, id, autostop: 'phrase' }, req, body);
    }
    recId = id;
    setState('recording');
    transcribeTimer = setTimeout(() => {
      setState('transcribing');
      transcribeTimer = setTimeout(() => {
        send('transcript', { type: 'transcript', id, text, wake: true });
        setState('idle');
      }, gap);
    }, gap);
    return reply(res, 200, { ok: true, id }, req, body);
  }
  if (p === '/test/say') {
    if (state !== 'recording' || !rec) return reply(res, 409, { error: 'not recording' }, req, body);
    if (typeof body.text !== 'string') return reply(res, 400, { error: 'text is required' }, req, body);
    const n = sayWords(body.text, Math.max(10, Number(body.delay) || 60), body.replace === true);
    return reply(res, 200, { ok: true, id: rec.id, words: n }, req, body);
  }
  reply(res, 404, { error: 'not found' }, req, body);
});

server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(path.dirname(path.resolve(controlFile)), { recursive: true });
  fs.writeFileSync(controlFile, JSON.stringify({ port, token, pid: process.pid }));
  log({ ev: 'listening', port, pid: process.pid, controlFile: path.resolve(controlFile), wakeModel: wk.model, speakMs: SPEAK_MS, cleanupUnavailable: CLEANUP_UNAVAILABLE });
  setInterval(() => { for (const c of clients) c.write(': heartbeat\n\n'); }, 15000).unref();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { fs.unlinkSync(controlFile); } catch {} process.exit(0); });
