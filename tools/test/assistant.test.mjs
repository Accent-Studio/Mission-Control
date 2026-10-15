// Tests for the voice assistant: spoken phrases ("send it", "cancel that") on live text, the voice preferences, and the link to
// BlitzVoice (start options, discard, live words, wake routing) against the FAKE BlitzVoice in tools/fakevoice.
// Nothing here uses a microphone, a speaker or a real Claude. Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { ROOT, freePort, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

await import('../../app/phrases.js');
const PH = globalThis.MCPhrases;
const here = path.dirname(fileURLToPath(import.meta.url));
void here;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHR = { send: 'send it', cancel: 'cancel that' };

describe('phrases: normalize and end match', () => {
  test('normalize lowercases, drops punctuation and apostrophes, squeezes spaces', () => {
    assert.equal(PH.normalize('  Send   IT!! '), 'send it');
    assert.equal(PH.normalize("What's the time?"), 'whats the time');
    assert.equal(PH.normalize(null), '');
  });
  test('the send phrase at the end is stripped, casing and sentence marks of the rest are kept', () => {
    assert.deepEqual(PH.detect('What time is it send it', PHR), { kind: 'send', rest: 'What time is it' });
    assert.deepEqual(PH.detect('What time is it? Send it.', PHR), { kind: 'send', rest: 'What time is it?' });
    assert.deepEqual(PH.detect('Open the log, send it!', PHR), { kind: 'send', rest: 'Open the log' });
  });
  test('only whole words at the very end count', () => {
    assert.equal(PH.detect('please resend it', PHR), null);
    assert.equal(PH.detect('send it to me tomorrow', PHR), null);
    assert.equal(PH.detect('I will send it later', PHR), null);
    assert.equal(PH.detect('', PHR), null);
    assert.equal(PH.detect('send', PHR), null);
  });
  test('the cancel phrase at the end cancels and keeps what came before', () => {
    assert.deepEqual(PH.detect('never mind, cancel that', PHR), { kind: 'cancel', rest: 'never mind' });
    assert.equal(PH.detect('Cancel that!', PHR).kind, 'cancel');
  });
  test('a send phrase with nothing before it is a cancel', () => {
    assert.deepEqual(PH.detect('send it', PHR), { kind: 'cancel', rest: '', empty: true });
    assert.deepEqual(PH.detect('  Send it. ', PHR), { kind: 'cancel', rest: '', empty: true });
    assert.deepEqual(PH.detect(', send it', PHR), { kind: 'cancel', rest: '', empty: true });
  });
  test('the longer phrase wins when both end the text', () => {
    assert.equal(PH.detect('ok send it', { send: 'it', cancel: 'send it' }).kind, 'cancel');
    assert.equal(PH.detect('ok send it', { send: 'send it', cancel: 'it' }).kind, 'send');
  });
  test('custom phrases, numbers and accents', () => {
    assert.deepEqual(PH.detect('what is 2 plus 2 go ahead', { send: 'go ahead', cancel: 'forget it' }), { kind: 'send', rest: 'what is 2 plus 2' });
    assert.equal(PH.detect('c est fini, envoie ça', { send: 'envoie ça', cancel: 'annule' }).kind, 'send');
  });
  test('checkPhrase: 2 to 30 characters, letters and spaces', () => {
    assert.equal(PH.checkPhrase('send it').ok, true);
    assert.equal(PH.checkPhrase('  go   ahead ').phrase, 'go ahead');
    for (const bad of ['a', 'x'.repeat(31), 'send it!', 'send 1', 'send-it', '', 5, null]) assert.equal(PH.checkPhrase(bad).ok, false, String(bad));
  });
});

// A manual clock for the stability rule.
function clock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { at: now + ms, f }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].f();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

describe('phrases: the stability rule', () => {
  const make = (ck, acts) => new PH.PhraseWatch({ phrases: () => PHR, onAct: (kind, rest, empty) => acts.push({ kind, rest, empty }), setTimer: ck.setTimer, clearTimer: ck.clearTimer });

  test('a repeat of the same text does not act early and does not restart the wait', () => {
    const ck = clock(), acts = [], w = make(ck, acts);
    w.push('what time is it send it');
    ck.advance(300);
    w.push('what time is it send it');
    w.push('what time is it send it');
    assert.equal(acts.length, 0, 'agreeing partials are not enough');
    ck.advance(101);
    assert.deepEqual(acts, [{ kind: 'send', rest: 'what time is it', empty: false }]);
    assert.equal(ck.pending(), 0);
  });
  test('a pause after the phrase followed by more words does not send', () => {
    const ck = clock(), acts = [], w = make(ck, acts);
    w.push('what time is it send it');
    ck.advance(350);
    w.push('what time is it send it please');
    ck.advance(1000);
    assert.equal(acts.length, 0);
    w.push('what time is it send it');
    ck.advance(399);
    assert.equal(acts.length, 0);
    ck.advance(2);
    assert.equal(acts.length, 1);
  });
  test('acts after 400ms when no partial follows, not before', () => {
    const ck = clock(), acts = [], w = make(ck, acts);
    w.push('what time is it send it');
    ck.advance(399);
    assert.equal(acts.length, 0);
    ck.advance(2);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].rest, 'what time is it');
  });
  test('does not act when the model revises the word or goes on talking', () => {
    const ck = clock(), acts = [], w = make(ck, acts);
    w.push('what time is it send it');
    ck.advance(200);
    w.push('what time is it send it to the');
    ck.advance(1000);
    assert.equal(acts.length, 0);
    assert.equal(ck.pending(), 0);
    w.push('what time is it send it');
    ck.advance(100);
    w.push('what time is it sent it'); // revised away
    ck.advance(1000);
    assert.equal(acts.length, 0);
  });
  test('a changed remainder restarts the wait', () => {
    const ck = clock(), acts = [], w = make(ck, acts);
    w.push('what time is it send it');
    ck.advance(300);
    w.push('what time is it today send it');
    ck.advance(300);
    assert.equal(acts.length, 0);
    ck.advance(200);
    assert.deepEqual(acts.map((a) => a.rest), ['what time is it today']);
  });
  test('an empty remainder is a cancel, a cancel phrase is a cancel, and each fires once', () => {
    let ck = clock(), acts = [], w = make(ck, acts);
    w.push('send it');
    ck.advance(500);
    assert.deepEqual(acts, [{ kind: 'cancel', rest: '', empty: true }]);
    w.push('send it');
    ck.advance(500);
    assert.equal(acts.length, 1, 'acted once');
    ck = clock(); acts = []; w = make(ck, acts);
    w.push('never mind cancel that');
    ck.advance(500);
    assert.deepEqual(acts, [{ kind: 'cancel', rest: 'never mind', empty: false }]);
    w.reset();
    w.push('hello send it');
    ck.advance(500);
    assert.equal(acts.length, 2, 'a reset starts a new dictation');
  });
});

// ---- the server side ----
const toStop = [];
const procs = [];
after(async () => {
  for (const s of toStop) await s.stop().catch(() => {});
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
});

const asPc = (s, method, p, body) => localReq(s, { method, path: p, body, headers: method === 'GET' ? {} : { 'X-MC': '1' } });

async function waitUntil(pred, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function openSse(port) {
  const events = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    });
  });
  req.on('error', () => {});
  req.end();
  return { events, voice: () => events.filter((e) => e.type === 'voice').map((e) => e.data), close: () => req.destroy() };
}

async function bootWithFake() {
  const dir = makeDataDir('assistant');
  seedFixture(dir);
  const control = path.join(dir, 'voice', 'control.json');
  const logFile = path.join(dir, 'voice', 'fakevoice.log');
  const fake = spawn(process.execPath, [path.join(ROOT, 'tools', 'fakevoice', 'fake-voice.js'), control, '--port', String(await freePort()), '--speak-ms', '300', '--log', logFile, '--cap-ms', '1500'], { windowsHide: true, stdio: 'ignore' });
  procs.push(fake);
  await waitUntil(() => fs.existsSync(control), 8000, 'fake voice control file');
  const s = await startServer({ dataDir: dir, bridge: false, env: { MC_VOICE_CONTROL_FILE: control } });
  toStop.push(s);
  await waitUntil(async () => (await asPc(s, 'GET', '/api/voice')).json?.available === true, 10000, 'voice link');
  const ctl = JSON.parse(fs.readFileSync(control, 'utf8'));
  const fakeCall = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${ctl.port}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${ctl.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const fakeLog = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reqs = (p) => fakeLog().filter((e) => e.ev === 'request' && e.path === p && e.method === 'POST');
  return { s, dir, fake, fakeCall, fakeLog, reqs, ctl };
}

describe('voice preferences: phrases', () => {
  let s;
  test('defaults, then a valid change, kept in a file', async () => {
    const dir = makeDataDir('assistant-prefs');
    s = await startServer({ dataDir: dir, bridge: false });
    toStop.push(s);
    const got = await asPc(s, 'GET', '/api/voice/prefs');
    assert.equal(got.json.sendPhrase, 'send it');
    assert.equal(got.json.cancelPhrase, 'cancel that');
    const put = await asPc(s, 'PUT', '/api/voice/prefs', { sendPhrase: '  Go   ahead ', cancelPhrase: 'forget it' });
    assert.equal(put.status, 200);
    assert.equal(put.json.sendPhrase, 'Go ahead');
    assert.equal(put.json.cancelPhrase, 'forget it');
    assert.equal(put.json.readAloud, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice-prefs.json'), 'utf8')).sendPhrase, 'Go ahead');
  });
  test('bad phrases are refused with a 400 and change nothing', async () => {
    for (const bad of ['a', 'x'.repeat(31), 'send it!', 'send 1', 7, '', '   ']) {
      const r = await asPc(s, 'PUT', '/api/voice/prefs', { sendPhrase: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.json.error, /sendPhrase/);
    }
    const same = await asPc(s, 'PUT', '/api/voice/prefs', { cancelPhrase: 'GO AHEAD!'.replace('!', '') });
    assert.equal(same.status, 400, 'the two phrases must differ');
    assert.match(same.json.error, /differ/);
    const still = await asPc(s, 'GET', '/api/voice/prefs');
    assert.equal(still.json.sendPhrase, 'Go ahead');
    assert.equal(still.json.cancelPhrase, 'forget it');
  });
  test('the booleans still work and a wrong type is refused', async () => {
    assert.equal((await asPc(s, 'PUT', '/api/voice/prefs', { readAloud: true })).json.readAloud, true);
    assert.equal((await asPc(s, 'PUT', '/api/voice/prefs', { cleanup: 'no' })).status, 400);
  });
  test('the Com Link settings: defaults, valid changes, and refusals', async () => {
    const d = (await asPc(s, 'GET', '/api/voice/prefs')).json;
    assert.deepEqual(
      [d.comlinkPersona, d.autoListen, d.listenSilenceSec, d.hidePanelSec, d.comlinkEffort, d.comlinkMode, d.comlinkModel],
      [true, true, 30, 0, 'medium', 'auto', ''],
    );
    const ok = await asPc(s, 'PUT', '/api/voice/prefs', { listenSilenceSec: 45, hidePanelSec: 0, comlinkMode: 'default', comlinkEffort: 'high', comlinkModel: 'claude-sonnet-5-5', autoListen: false });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.listenSilenceSec, ok.json.comlinkMode, ok.json.comlinkEffort, ok.json.comlinkModel, ok.json.autoListen], [45, 'default', 'high', 'claude-sonnet-5-5', false]);
    for (const bad of [{ listenSilenceSec: 2 }, { listenSilenceSec: 4.5 }, { hidePanelSec: -1 }, { comlinkMode: 'bypassPermissions' }, { comlinkEffort: 'huge' }, { comlinkModel: 'a b' }, { autoListen: 'yes' }]) {
      assert.equal((await asPc(s, 'PUT', '/api/voice/prefs', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await asPc(s, 'GET', '/api/voice/prefs')).json.listenSilenceSec, 45);
  });
  test('her memory can be read and replaced', async () => {
    const put = await asPc(s, 'PUT', '/api/voice/memory', { text: '- 2026-10-13: He likes cigars.\r\n' });
    assert.equal(put.status, 200);
    assert.equal(put.json.text, '- 2026-10-13: He likes cigars.\n');
    assert.equal((await asPc(s, 'GET', '/api/voice/memory')).json.text, '- 2026-10-13: He likes cigars.\n');
    assert.equal((await asPc(s, 'PUT', '/api/voice/memory', { nope: 1 })).status, 400);
  });
  test('a hand-edited file with bad or equal phrases falls back to the defaults', async () => {
    const dir = makeDataDir('assistant-prefs2');
    fs.writeFileSync(path.join(dir, 'voice-prefs.json'), JSON.stringify({ sendPhrase: 'ok!', cancelPhrase: 'fine' }));
    const s2 = await startServer({ dataDir: dir, bridge: false });
    toStop.push(s2);
    const r = await asPc(s2, 'GET', '/api/voice/prefs');
    assert.equal(r.json.sendPhrase, 'send it');
    assert.equal(r.json.cancelPhrase, 'fine');
    fs.writeFileSync(path.join(dir, 'voice-prefs.json'), JSON.stringify({ sendPhrase: 'same', cancelPhrase: 'SAME' }));
  });
});

describe('the link: start options, discard, live words, wake routing', () => {
  let f;
  let sse;
  test('on connect the wake word is told to end by phrase', async () => {
    f = await bootWithFake();
    sse = openSse(f.s.port);
    await waitUntil(() => f.reqs('/wake').some((e) => e.body && e.body.autostop === 'phrase'), 8000, 'POST /wake autostop phrase');
    const st = await f.fakeCall('/wake', { threshold: 0.5 }); // reads back the status
    assert.equal(st.json.autostop, 'phrase');
  });
  test('/api/voice/start passes only the known options through', async () => {
    const r = await asPc(f.s, 'POST', '/api/voice/start', { partials: true, autostop: 'none', cleanup: false, model: 'live-small', evil: 'x', deliver: 'paste' });
    assert.equal(r.status, 200);
    const sent = f.reqs('/start').at(-1).body;
    assert.deepEqual(sent, { deliver: 'link', cleanup: false, partials: true, autostop: 'none', model: 'live-small' });
    await asPc(f.s, 'POST', '/api/voice/cancel', {});
    const plain = await asPc(f.s, 'POST', '/api/voice/start', {});
    assert.equal(plain.status, 200);
    assert.deepEqual(f.reqs('/start').at(-1).body, { deliver: 'link', cleanup: true }, 'no options: the preferences decide the cleanup');
    const bad = await asPc(f.s, 'POST', '/api/voice/start', { autostop: 'forever', partials: 'yes', model: 5 });
    assert.equal(bad.status, 409, 'busy: already recording');
    await asPc(f.s, 'POST', '/api/voice/cancel', {});
  });
  test('/api/voice/discard reaches BlitzVoice, ends the dictation and sends no transcript', async () => {
    const before = sse.voice().length;
    const st = await asPc(f.s, 'POST', '/api/voice/start', { partials: true, autostop: 'none', cleanup: false });
    const id = st.json.id;
    await f.fakeCall('/test/say', { text: 'hello there', delay: 20 });
    await waitUntil(() => sse.voice().some((e) => e.kind === 'partial' && e.id === id && e.text === 'hello there'), 4000, 'the full live text');
    const grew = sse.voice().filter((e) => e.kind === 'partial' && e.id === id).map((e) => e.text);
    assert.deepEqual(grew, ['hello', 'hello there'], 'growing partials, word by word');
    assert.ok(grew.every(() => true) && sse.voice().find((e) => e.kind === 'partial').wake === undefined, 'a manual dictation has no wake flag');
    const d = await asPc(f.s, 'POST', '/api/voice/discard', {});
    assert.equal(d.status, 200);
    assert.equal(f.reqs('/discard').length, 1);
    await waitUntil(() => sse.voice().some((e) => e.kind === 'state' && e.state === 'idle'), 3000, 'idle after discard');
    await sleep(900);
    assert.equal(sse.voice().slice(before).some((e) => e.kind === 'transcript'), false, 'no transcript after a discard');
    const again = await asPc(f.s, 'POST', '/api/voice/discard', {});
    assert.equal(again.status, 409, 'nothing to discard now');
  });
  test('a dictation with no automatic stop ends at the cap with an empty timeout transcript', async () => {
    const st = await asPc(f.s, 'POST', '/api/voice/start', { partials: true, autostop: 'none' });
    await waitUntil(() => sse.voice().some((e) => e.kind === 'transcript' && e.id === st.json.id && e.error === 'timeout'), 5000, 'the timeout transcript');
    const t = sse.voice().find((e) => e.kind === 'transcript' && e.id === st.json.id);
    assert.equal(t.text, '');
  });
  test('/api/voice/discard needs the link: 503 when BlitzVoice is not connected', async () => {
    const dir = makeDataDir('assistant-nolink');
    const s2 = await startServer({ dataDir: dir, bridge: false });
    toStop.push(s2);
    const r = await asPc(s2, 'POST', '/api/voice/discard', {});
    assert.equal(r.status, 503);
  });
  test('a wake dictation: the tab named at the wake word gets the live words and the text', async () => {
    const ok = await asPc(f.s, 'POST', '/api/voice/wake', { enabled: true });
    assert.equal(ok.status, 200);
    const report = (tab, page) => asPc(f.s, 'POST', '/api/voice/focus', { tab, seq: 1, at: Date.now(), page, visible: true, focused: true });
    assert.equal((await report('tabaaa', 'comlink')).status, 200);
    const from = sse.voice().length;
    const w = await f.fakeCall('/test/wake', { text: 'what time is it', wordDelay: 20 });
    assert.equal(w.status, 200);
    const wake = await waitUntil(() => sse.voice().slice(from).find((e) => e.kind === 'wake'), 3000, 'wake event');
    assert.equal(wake.target, 'tabaaa');
    await waitUntil(() => sse.voice().slice(from).some((e) => e.kind === 'partial' && e.text === 'what time is it'), 4000, 'live words');
    const ps = sse.voice().slice(from).filter((e) => e.kind === 'partial');
    assert.ok(ps.every((e) => e.wake === true && e.target === 'tabaaa'), 'every live word carries the wake flag and the target');
    // the page that moves on does not take the dictation over: the text still goes to the first tab
    assert.equal((await report('tabbbb', 'chat')).status, 200);
    const stop = await asPc(f.s, 'POST', '/api/voice/stop', {});
    assert.equal(stop.status, 200);
    const tr = await waitUntil(() => sse.voice().slice(from).find((e) => e.kind === 'transcript' && e.wake), 4000, 'wake transcript');
    assert.equal(tr.target, 'tabaaa');
    assert.equal(tr.text, 'what time is it');
  });
  test('a wake dictation nobody would end is discarded at once (page "other", or no page)', async () => {
    const before = f.reqs('/discard').length;
    const report = (tab, page, seq) => asPc(f.s, 'POST', '/api/voice/focus', { tab, seq, at: Date.now(), page, visible: true, focused: true });
    assert.equal((await report('tabccc', 'other', 1)).status, 200); // a page without the assistant, looked at last
    const from = sse.voice().length;
    await f.fakeCall('/test/wake', { text: 'ignore me', wordDelay: 20 });
    await waitUntil(() => f.reqs('/discard').length > before, 4000, 'an automatic discard');
    const wake = sse.voice().slice(from).find((e) => e.kind === 'wake');
    assert.equal(wake.target, null);
    await sleep(400);
    assert.equal(sse.voice().slice(from).some((e) => e.kind === 'transcript'), false);
    assert.equal((await asPc(f.s, 'POST', '/api/voice/focus', { tab: 'x', seq: 1, at: Date.now(), page: 'nope', visible: true })).status, 400);
    sse.close();
  });
});
