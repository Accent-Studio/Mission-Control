// Tests for wake word training: argument validation, path safety, the trainer's JSON lines, one job at a time,
// clips, install, and the phone policy. A FAKE trainer (fake-waketrainer.mjs / .bat) stands in for the real one, so
// no test trains anything or touches the GPU, and every folder (models, clips, BlitzVoice) is a throwaway one.
// Run: node --test "tools/test/*.test.mjs"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { KNOWN_DEVICE, bridgeReq, localReq, makeDataDir, seedFixture, startServer } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MJS = path.join(here, 'fake-waketrainer.mjs');

// ---- folders for the in-process tests: set before the service is imported ----
const unitDir = makeDataDir('wt-unit');
const dirs = {
  models: path.join(unitDir, 'models'),
  clips: path.join(unitDir, 'clips'),
  install: path.join(unitDir, 'blitzvoice', 'wake-models'),
  argsFile: path.join(unitDir, 'args.json'),
  pidFile: path.join(unitDir, 'pid.txt'),
};
Object.assign(process.env, {
  MC_DATA_DIR: path.join(unitDir, 'data'),
  MC_WAKETRAINER_CMD: FAKE_MJS,
  MC_WAKETRAINER_MODELS_DIR: dirs.models,
  MC_WAKETRAINER_CLIPS_DIR: dirs.clips,
  MC_BLITZVOICE_WAKE_DIR: dirs.install,
  MC_VOICE_CONTROL_FILE: path.join(unitDir, 'no-voice-control.json'),
  MC_FAKE_WT_ARGS: dirs.argsFile,
  MC_FAKE_WT_PIDFILE: dirs.pidFile,
});
const wt = await import('../../server/services/waketrainer.js');

// A 16kHz mono 16-bit WAV of silence with a small tone, `seconds` long.
function wav(seconds = 2, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const n = Math.round(seconds * rate * channels);
  const data = Buffer.alloc(n * (bits / 8));
  for (let i = 0; i < n && bits === 16; i++) data.writeInt16LE(Math.round(Math.sin(i / 20) * 3000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * (bits / 8), 28);
  h.writeUInt16LE(channels * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function until(pred, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

describe('phrase and argument validation', () => {
  test('a plain phrase is cleaned and slugged', () => {
    const v = wt.validateStart({ phrase: '  Hey   Mission Control ' });
    assert.equal(v.ok, true);
    assert.deepEqual(v.value, { phrase: 'hey mission control', slug: 'hey_mission_control', preset: 'standard', steps: null, negatives: [] });
  });

  test('apostrophes are allowed, curly ones become straight', () => {
    const v = wt.validateStart({ phrase: 'What\u2019s up doc' });
    assert.equal(v.ok, true);
    assert.equal(v.value.phrase, "what's up doc");
    assert.equal(v.value.slug, 'what_s_up_doc');
  });

  test('bad phrases are refused', () => {
    const bad = ['', ' ', 'a', '1 2 3', 'hey & calc', 'hey "x"', 'a\nb', 'x'.repeat(41), 'hey;rm', 'hey|x', 'hey %PATH%', "''", '\u00e9\u00e9', null, 42, ['hey there'], { a: 1 }, undefined];
    for (const phrase of bad) {
      const v = wt.validateStart({ phrase });
      assert.equal(v.ok, false, `accepted ${JSON.stringify(phrase)}`);
      assert.equal(v.status, 400);
    }
    assert.equal(wt.validateStart(null).ok, false);
    assert.equal(wt.validateStart([]).ok, false);
    assert.equal(wt.validateStart({ phrase: 'x'.repeat(40) }).ok, true);
    assert.equal(wt.validateStart({ phrase: 'ab' }).ok, true);
  });

  test('preset must be one of the three', () => {
    for (const preset of ['quick', 'standard', 'thorough']) assert.equal(wt.validateStart({ phrase: 'hey you', preset }).value.preset, preset);
    for (const preset of ['smoke', 'QUICK', '', 'quick --steps 1', 5, null, ['quick'], '__proto__', 'constructor']) {
      assert.equal(wt.validateStart({ phrase: 'hey you', preset }).ok, false, `accepted ${JSON.stringify(preset)}`);
    }
  });

  test('steps are optional and bounded', () => {
    assert.equal(wt.validateStart({ phrase: 'hey you', steps: 5000 }).value.steps, 5000);
    for (const steps of [99, 200001, 1.5, '5000', -1, NaN]) assert.equal(wt.validateStart({ phrase: 'hey you', steps }).ok, false);
  });

  test('negatives: a list or a comma string, same rule, at most 12, no duplicates, never the phrase itself', () => {
    const a = wt.validateStart({ phrase: 'hey mission control', negatives: 'hey vision control, hey michigan control,, Hey Vision Control' });
    assert.deepEqual(a.value.negatives, ['hey vision control', 'hey michigan control']);
    const b = wt.validateStart({ phrase: 'hey mission control', negatives: ['mission control', 'hey mission control'] });
    assert.deepEqual(b.value.negatives, ['mission control']);
    const twelve = Array.from({ length: 12 }, (_, i) => `near miss ${'abcdefghijkl'[i]}`);
    assert.equal(wt.validateStart({ phrase: 'hey you', negatives: twelve }).value.negatives.length, 12);
    assert.equal(wt.validateStart({ phrase: 'hey you', negatives: [...twelve, 'one more'] }).ok, false);
    for (const negatives of [['ok', 'bad & worse'], ['x'], [42], [['nested']], { a: 1 }, 7, ['hey "x"']]) {
      assert.equal(wt.validateStart({ phrase: 'hey you', negatives }).ok, false, `accepted ${JSON.stringify(negatives)}`);
    }
  });

  test('slug and clip name rules block path tricks', () => {
    assert.equal(wt.isSlug('hey_mission_control'), true);
    for (const s of ['', '..', '../x', 'a/b', 'a\\b', 'C:', 'a..b', '_a', 'a_', 'a__b', 'A', 'x'.repeat(61), 'hey mission', 'a.b', null]) assert.equal(wt.isSlug(s), false, s);
    assert.equal(wt.isClipName('clip-1.wav'), true);
    assert.equal(wt.isClipName('clip-12345.wav'), true);
    for (const n of ['clip-.wav', 'clip-1.wav.exe', '../clip-1.wav', 'clip-1.WAV', 'clip-123456.wav', 'clip-1.wav/', 'clip-1\\..\\x.wav', 'x.wav']) assert.equal(wt.isClipName(n), false, n);
  });
});

describe('the trainer JSON lines', () => {
  test('progress, done and error lines', () => {
    assert.deepEqual(wt.parseTrainLine('{"stage":"train","pct":42,"msg":"step 12"}'), { type: 'progress', stage: 'train', pct: 42, msg: 'step 12' });
    assert.deepEqual(wt.parseTrainLine('\uFEFF{"stage":"verify","pct":150.6}'), { type: 'progress', stage: 'verify', pct: 100, msg: '' });
    assert.equal(wt.parseTrainLine('{"stage":"features","pct":-5}').pct, 0);
    assert.deepEqual(wt.parseTrainLine('{"done":true,"out":"D:\\\\m.onnx","seconds":2580.5,"timings":{"a":1}}'), { type: 'done', out: 'D:\\m.onnx', seconds: 2580.5 });
    assert.deepEqual(wt.parseTrainLine('{"error":"out of memory"}'), { type: 'error', error: 'out of memory' });
  });

  test('anything else is ignored', () => {
    for (const l of ['', '   ', 'hello', '[1,2]', '{"stage":"dance","pct":1}', '{"stage":5}', '{"done":false}', '{"x":1}', '{broken', 'null', '"text"']) {
      assert.equal(wt.parseTrainLine(l), null, l);
    }
  });

  test('a long message is cut', () => {
    assert.equal(wt.parseTrainLine(JSON.stringify({ stage: 'train', pct: 1, msg: 'x'.repeat(2000) })).msg.length, 300);
  });

  test('the line splitter joins pieces and strips CRLF', () => {
    const got = [];
    const s = wt.lineSplitter((l) => got.push(l));
    s.push('{"stage":"gen');
    s.push('erate","pct":1}\r\n{"stage":"augment"');
    s.push(',"pct":2}\n\nlast');
    assert.deepEqual(got, ['{"stage":"generate","pct":1}', '{"stage":"augment","pct":2}', '']);
    s.end();
    assert.equal(got.at(-1), 'last');
  });
});

describe('WAV checks', () => {
  test('16kHz mono 16-bit passes, anything else is named', () => {
    const good = wt.parseWav(wav(2));
    assert.equal(good.ok, true);
    assert.equal(good.seconds, 2);
    assert.match(wt.parseWav(wav(2, { rate: 48000 })).error, /16kHz mono 16-bit/);
    assert.match(wt.parseWav(wav(2, { channels: 2 })).error, /16kHz mono 16-bit/);
    assert.match(wt.parseWav(wav(0.1)).error, /too short/);
    assert.match(wt.parseWav(wav(6)).error, /longer/);
    assert.match(wt.parseWav(Buffer.from('RIFFxxxxAVI LIST'.padEnd(60, 'x'))).error, /not a WAV/);
    assert.match(wt.parseWav(Buffer.from('hello')).error, /not a WAV/);
    assert.equal(wt.parseWav(null).ok, false);
  });

  test('trailing junk beyond 64 bytes is refused, a little padding is fine', () => {
    assert.equal(wt.parseWav(Buffer.concat([wav(1), Buffer.alloc(64)])).ok, true);
    const r = wt.parseWav(Buffer.concat([wav(1), Buffer.alloc(65, 7)]));
    assert.equal(r.ok, false);
    assert.match(r.error, /extra data/);
    assert.equal(wt.saveClip('junk_clip', Buffer.concat([wav(1), Buffer.alloc(5000, 7)])).status, 400);
  });

  test('a saved clip is a rewritten canonical header plus the audio only', () => {
    const w = wav(1);
    const padded = Buffer.concat([w, Buffer.alloc(40, 9)]);
    padded.writeUInt32LE(36 + w.length + 40, 4); // an untidy RIFF size
    const r = wt.saveClip('canon_clip', padded);
    assert.equal(r.status, 200);
    const saved = fs.readFileSync(path.join(dirs.clips, 'canon_clip', r.body.name));
    assert.equal(saved.length, 44 + 32000);
    assert.deepEqual(saved, w);
  });

  test('a header that claims more data than the file has is clamped, not trusted', () => {
    const w = wav(2);
    w.writeUInt32LE(0xffffffff, 40);
    assert.equal(wt.parseWav(w).ok, true);
  });

  test('chunks before the data are skipped', () => {
    const w = wav(1);
    const list = Buffer.alloc(8 + 5 + 1);
    list.write('LIST', 0, 'latin1');
    list.writeUInt32LE(5, 4);
    const withList = Buffer.concat([w.subarray(0, 36), list, w.subarray(36)]);
    assert.equal(wt.parseWav(withList).ok, true);
  });
});

describe('clips on disk', () => {
  test('save, number, list, delete', () => {
    const a = wt.saveClip('hey_clips', wav(2));
    assert.equal(a.status, 200);
    assert.equal(a.body.name, 'clip-1.wav');
    const b = wt.saveClip('hey_clips', wav(1.5));
    assert.equal(b.body.name, 'clip-2.wav');
    assert.deepEqual(wt.listClips('hey_clips').map((c) => c.name), ['clip-1.wav', 'clip-2.wav']);
    assert.equal(wt.deleteClip('hey_clips', 'clip-1.wav').status, 200);
    assert.equal(wt.saveClip('hey_clips', wav(2)).body.name, 'clip-3.wav'); // numbers are never reused
    assert.equal(wt.deleteClip('hey_clips', 'clip-1.wav').status, 404);
    assert.ok(wt.clipFile('hey_clips', 'clip-2.wav').startsWith(dirs.clips));
  });

  test('global caps: 20 clip folders and 200MB in total answer 413', () => {
    const keep = process.env.MC_WAKETRAINER_CLIPS_DIR;
    const root = path.join(unitDir, 'caps-clips');
    process.env.MC_WAKETRAINER_CLIPS_DIR = root;
    try {
      for (let i = 0; i < wt.MAX_CLIP_FOLDERS; i++) fs.mkdirSync(path.join(root, `phrase_${i}`), { recursive: true });
      const full = wt.saveClip('one_too_many', wav(1));
      assert.equal(full.status, 413);
      assert.match(full.body.error, /At most 20 phrases/);
      assert.equal(fs.existsSync(path.join(root, 'one_too_many')), false);
      assert.equal(wt.saveClip('phrase_3', wav(1)).status, 200); // an existing folder still takes clips
      // Size: one sparse file nearly fills the 200MB.
      const big = path.join(root, 'phrase_4', 'clip-1.wav');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, wt.MAX_CLIPS_TOTAL_BYTES - 1000);
      const over = wt.saveClip('phrase_5', wav(1));
      assert.equal(over.status, 413);
      assert.match(over.body.error, /full/);
    } finally {
      process.env.MC_WAKETRAINER_CLIPS_DIR = keep;
    }
  });

  test('bad slugs, names and bodies are refused and nothing escapes the clips folder', () => {
    assert.equal(wt.saveClip('../evil', wav(2)).status, 400);
    assert.equal(wt.saveClip('hey_clips', Buffer.from('not a wav')).status, 400);
    assert.equal(wt.deleteClip('hey_clips', '../../clip-1.wav').status, 400);
    assert.equal(wt.deleteClip('..', 'clip-1.wav').status, 400);
    assert.equal(wt.clipFile('hey_clips', '..\\clip-1.wav'), null);
    assert.equal(wt.clipFile('../x', 'clip-1.wav'), null);
    assert.equal(fs.existsSync(path.join(unitDir, 'evil')), false);
    assert.deepEqual(wt.listClips('../clips'), []);
  });
});

describe('install: only a model from the trained folder, by name', () => {
  test('refuses names that are not plain model names', async () => {
    fs.mkdirSync(dirs.models, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'secret.onnx'), 'outside');
    for (const m of ['..\\secret', '../secret', '../models/x', 'a/b', 'a\\b', 'C:\\x\\y', '/etc/x', '..', '', 'a'.repeat(81), 'x.onnx\0', 5, null, undefined, 'x y', 'models\\..\\..\\secret']) {
      const r = await wt.installModel(m);
      assert.equal(r.status, 400, `accepted ${JSON.stringify(m)}`);
    }
    assert.equal(fs.existsSync(dirs.install) ? fs.readdirSync(dirs.install).length : 0, 0);
  });

  test('an unknown model is a 404, and a model outside the folder is never copied', async () => {
    assert.equal((await wt.installModel('nothing_here')).status, 404);
    assert.equal((await wt.installModel('secret')).status, 404);
    assert.equal(fs.existsSync(path.join(dirs.install, 'secret.onnx')), false);
  });

  test('a trained model is copied under its slug, whole, with no part file left (BlitzVoice is not linked here)', async () => {
    fs.writeFileSync(path.join(dirs.models, 'hey_there.onnx'), 'MODELBYTES');
    const r = await wt.installModel('hey_there');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, id: 'hey_there', phrase: 'Hey There', selected: false, reason: 'not_linked' });
    assert.equal(fs.readFileSync(path.join(dirs.install, 'hey_there.onnx'), 'utf8'), 'MODELBYTES');
    assert.deepEqual(fs.readdirSync(dirs.install), ['hey_there.onnx']);
  });

  test('the model list merges trained and installed', () => {
    const l = wt.listModels();
    assert.equal(l.linked, false);
    const m = l.models.find((x) => x.id === 'hey_there');
    assert.equal(m.trained, true);
    assert.equal(m.installed, true);
    assert.equal(m.selected, false);
    assert.equal(m.phrase, 'Hey There');
  });
});

describe('one training at a time (fake trainer)', () => {
  const ARGS = () => JSON.parse(fs.readFileSync(dirs.argsFile, 'utf8'));

  test('a running training refuses a second one, then Stop kills only that process by pid', async () => {
    process.env.MC_FAKE_WT_MODE = 'hang';
    const first = wt.startTraining({ phrase: 'hey mission control', preset: 'quick', negatives: ['mission control'] });
    assert.equal(first.status, 200);
    assert.equal(first.body.running, true);
    assert.equal(first.body.phase, 'running');
    const second = wt.startTraining({ phrase: 'other words' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'busy');
    const pid = Number(await until(() => (fs.existsSync(dirs.pidFile) ? fs.readFileSync(dirs.pidFile, 'utf8') : ''), 8000, 'fake trainer pid'));
    assert.ok(alive(pid));
    await until(() => wt.trainState().stage === 'generate' && wt.trainState().pct === 10, 8000, 'first progress');
    // Clips cannot change under a running training of the same phrase.
    assert.equal(wt.saveClip('hey_mission_control', wav(2)).status, 409);
    assert.equal(wt.saveClip('another_phrase', wav(2)).status, 200);
    assert.equal(wt.stopTraining().status, 200);
    await until(() => wt.trainState().phase === 'stopped', 10000, 'stopped');
    await until(() => !alive(pid), 5000, 'trainer process to end');
    assert.equal(wt.trainState().running, false);
    assert.equal(wt.stopTraining().status, 409);
    assert.ok(alive(process.pid));
  });

  test('a good run: arguments are passed as given, lines become state, the model lands in the models folder', async () => {
    process.env.MC_FAKE_WT_MODE = 'ok';
    fs.rmSync(path.join(dirs.clips, 'hey_mission_control'), { recursive: true, force: true });
    assert.equal(wt.saveClip('hey_mission_control', wav(2)).status, 200);
    assert.equal(wt.saveClip('hey_mission_control', wav(2)).status, 200);
    const r = wt.startTraining({ phrase: 'Hey Mission Control', preset: 'thorough', steps: 777, negatives: ['hey vision control', 'hey michigan control'] });
    assert.equal(r.status, 200);
    await until(() => wt.trainState().phase === 'done', 10000, 'done');
    const st = wt.trainState();
    assert.equal(st.out, 'hey_mission_control.onnx');
    assert.equal(st.seconds, 12.5);
    assert.equal(st.pct, 100);
    assert.equal(st.clips, 2);
    assert.deepEqual(Object.keys(st.stages), ['generate', 'augment', 'features', 'train', 'export', 'verify']);
    assert.ok(Object.values(st.stages).every((p) => p === 100));
    assert.equal(fs.readFileSync(path.join(dirs.models, 'hey_mission_control.onnx'), 'utf8'), 'FAKEONNX');
    assert.deepEqual(ARGS(), [
      '--phrase', 'hey mission control',
      '--out', path.join(dirs.models, 'hey_mission_control.onnx'),
      '--preset', 'thorough',
      '--clips', path.join(dirs.clips, 'hey_mission_control'),
      '--negatives', 'hey vision control,hey michigan control',
      '--steps', '777',
    ]);
    // The log holds the trainer's lines and its stderr; the state is saved for a reload.
    const log = fs.readFileSync(path.join(unitDir, 'data', 'logs', st.log), 'utf8');
    assert.match(log, /out: \{"stage":"generate","pct":100,"msg":"voices"\}/);
    assert.match(log, /err: fake trainer: stderr noise/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(unitDir, 'data', 'waketrain.json'), 'utf8')).phase, 'done');
    // The next one starts without clips, so --clips is left out.
    assert.equal(wt.startTraining({ phrase: 'no clips yet' }).status, 200);
    await until(() => wt.trainState().phase === 'done', 10000, 'second done');
    assert.ok(!ARGS().includes('--clips'));
    assert.ok(!ARGS().includes('--negatives'));
  });

  test('the trainer reporting an error, or dying silently, ends in an error state with a reason', async () => {
    process.env.MC_FAKE_WT_MODE = 'error';
    assert.equal(wt.startTraining({ phrase: 'hey failing' }).status, 200);
    await until(() => wt.trainState().phase === 'error', 10000, 'error');
    assert.equal(wt.trainState().error, 'fake failure');
    process.env.MC_FAKE_WT_MODE = 'crash';
    assert.equal(wt.startTraining({ phrase: 'hey crashing' }).status, 200);
    await until(() => wt.trainState().phase === 'error', 10000, 'crash');
    assert.match(wt.trainState().error, /without a result \(exit code 3\)/);
  });

  test('a missing trainer is a clear 503, bad input never starts a process', () => {
    const keep = process.env.MC_WAKETRAINER_CMD;
    process.env.MC_WAKETRAINER_CMD = path.join(unitDir, 'nope.mjs');
    assert.equal(wt.startTraining({ phrase: 'hey there' }).body.error, 'trainer_missing');
    process.env.MC_WAKETRAINER_CMD = keep;
    fs.rmSync(dirs.argsFile, { force: true });
    assert.equal(wt.startTraining({ phrase: 'hey & calc' }).status, 400);
    assert.equal(fs.existsSync(dirs.argsFile), false);
    assert.equal(wt.trainState().running, false);
  });

  test('a trainer that is not a script is refused, with no shell involved', () => {
    const keep = process.env.MC_WAKETRAINER_CMD;
    const bat = path.join(unitDir, 'train.bat');
    fs.writeFileSync(bat, '@echo off\r\n');
    process.env.MC_WAKETRAINER_CMD = bat;
    const r = wt.startTraining({ phrase: 'hey there' });
    process.env.MC_WAKETRAINER_CMD = keep;
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'bad_trainer');
    assert.equal(wt.trainState().running, false);
  });

  test('a Stop that arrives after the trainer printed done keeps the result', async () => {
    // A private fake that writes the model, prints {"done":true} and then keeps running.
    const lateFake = path.join(unitDir, 'late-fake.mjs');
    fs.writeFileSync(lateFake, [
      "import fs from 'node:fs';",
      "const out = process.argv[process.argv.indexOf('--out') + 1];",
      "fs.writeFileSync(out, 'FAKEONNX');",
      "process.stdout.write(JSON.stringify({ stage: 'verify', pct: 100, msg: 'v' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ done: true, out, seconds: 12.5 }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join(String.fromCharCode(10)));
    const keep = process.env.MC_WAKETRAINER_CMD;
    process.env.MC_WAKETRAINER_CMD = lateFake;
    try {
      assert.equal(wt.startTraining({ phrase: 'hey stop late' }).status, 200);
      await until(() => wt.trainState().stage === 'verify', 8000, 'verify line');
      await new Promise((r) => setTimeout(r, 400)); // the done line has been read
      assert.equal(wt.stopTraining().status, 200);
      await until(() => !wt.trainState().running, 10000, 'ended');
    } finally {
      process.env.MC_WAKETRAINER_CMD = keep;
    }
    const st = wt.trainState();
    assert.equal(st.phase, 'done');
    assert.equal(st.out, 'hey_stop_late.onnx');
    assert.equal(st.seconds, 12.5);
  });
});

describe('a trainer left running by a server that was killed', () => {
  const pidPath = path.join(unitDir, 'data', 'waketrain.pid');
  const spawned = [];
  after(() => {
    for (const c of spawned) {
      try {
        process.kill(c.pid);
      } catch {
        // gone
      }
    }
  });
  const record = (pid) => ({ pid, startedAt: Date.now() - 60000, out: path.join(dirs.models, 'hey_orphan.onnx'), phrase: 'hey orphan', slug: 'hey_orphan', preset: 'quick', negatives: [], clips: 0, log: null });

  test('a live fake trainer is adopted: running, refuses a new start, Stop kills it by pid and clears the file', async () => {
    process.env.MC_FAKE_WT_MODE = 'hang';
    const child = spawn(process.execPath, [FAKE_MJS, '--phrase', 'hey orphan'], { stdio: 'ignore', windowsHide: true });
    spawned.push(child);
    await until(() => fs.existsSync(dirs.pidFile) && Number(fs.readFileSync(dirs.pidFile, 'utf8')) === child.pid, 8000, 'fake trainer up');
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, JSON.stringify(record(child.pid)));
    wt.recoverTrainer();
    const st = wt.trainState();
    assert.equal(st.running, true);
    assert.equal(st.phase, 'running');
    assert.equal(st.phrase, 'hey orphan');
    assert.match(st.msg, /running \(started before a restart\)/);
    const again = wt.startTraining({ phrase: 'something else' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'busy');
    assert.equal(wt.stopTraining().status, 200);
    await until(() => wt.trainState().phase === 'stopped', 10000, 'stopped');
    await until(() => !alive(child.pid), 5000, 'trainer to end');
    assert.equal(fs.existsSync(pidPath), false);
    assert.equal(wt.trainState().running, false);
  });

  test('a pid file with a dead pid is cleared and the last state is "interrupted"', () => {
    wt.resetStateForTests();
    fs.writeFileSync(pidPath, JSON.stringify(record(2147483000)));
    wt.recoverTrainer();
    assert.equal(wt.trainState().running, false);
    assert.equal(wt.trainState().phase, 'interrupted');
    assert.equal(wt.trainState().phrase, 'hey orphan');
    assert.equal(fs.existsSync(pidPath), false);
  });

  test('a live pid that is not our trainer is never adopted or killed', async () => {
    wt.resetStateForTests();
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    spawned.push(other);
    await until(() => alive(other.pid), 3000, 'other process');
    fs.writeFileSync(pidPath, JSON.stringify(record(other.pid)));
    wt.recoverTrainer();
    assert.equal(wt.trainState().running, false);
    assert.equal(wt.trainState().phase, 'interrupted');
    assert.equal(fs.existsSync(pidPath), false);
    assert.ok(alive(other.pid));
  });

  test('a normal training writes the pid file while it runs and removes it when it ends', async () => {
    wt.resetStateForTests();
    process.env.MC_FAKE_WT_MODE = 'hang';
    assert.equal(wt.startTraining({ phrase: 'hey pid file' }).status, 200);
    const rec = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    assert.ok(Number.isInteger(rec.pid) && rec.pid > 0);
    assert.equal(rec.out, path.join(dirs.models, 'hey_pid_file.onnx'));
    assert.ok(rec.startedAt > 0);
    wt.stopTraining();
    await until(() => !wt.trainState().running, 10000, 'stopped');
    assert.equal(fs.existsSync(pidPath), false);
    process.env.MC_FAKE_WT_MODE = 'ok';
  });
});

// ---- over HTTP, with a real server process ----

const toStop = [];
const streams = [];
after(async () => {
  for (const st of streams) st.close();
  for (const s of toStop) await s.stop().catch(() => {});
});

function sse(port) {
  const events = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
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
  streams.push({ close: () => req.destroy() });
  return events;
}

describe('over HTTP', () => {
  let s;
  let events;
  const base = makeDataDir('wt-http');
  const d = { models: path.join(base, 'models'), clips: path.join(base, 'clips'), install: path.join(base, 'bv', 'wake-models'), pid: path.join(base, 'pid.txt') };
  const pc = (method, p, body, headers = {}) => localReq(s, { method, path: p, body, headers: method === 'GET' ? headers : { 'X-MC': '1', ...headers } });
  const phone = (method, p, body) => bridgeReq(s, { method, path: p, body, hdr: { post: method !== 'GET' } });

  test('start the server', async () => {
    const dataDir = makeDataDir('wt-http-data');
    seedFixture(dataDir);
    s = await startServer({
      dataDir,
      env: {
        MC_WAKETRAINER_CMD: FAKE_MJS,
        MC_WAKETRAINER_MODELS_DIR: d.models,
        MC_WAKETRAINER_CLIPS_DIR: d.clips,
        MC_BLITZVOICE_WAKE_DIR: d.install,
        MC_FAKE_WT_PIDFILE: d.pid,
        MC_FAKE_WT_ARGS: path.join(base, 'args.json'),
        MC_FAKE_WT_MODE: 'ok',
      },
    });
    toStop.push(s);
    events = sse(s.port);
    const r = await pc('GET', '/api/waketrain');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.presets, { quick: 15, standard: 45, thorough: 120 });
    assert.equal(r.json.state.phase, 'idle');
    assert.equal(/policy/.test(s.out.text) && /waketrain/.test(s.out.text), false, 'a route has no entry in the phone policy');
  });

  test('phones can read state and models but change nothing', async () => {
    assert.equal((await phone('GET', '/api/waketrain')).status, 200);
    assert.equal((await phone('GET', '/api/waketrain/models')).status, 200);
    assert.equal((await phone('GET', '/api/waketrain/clips/hey_x')).status, 403);
    assert.equal((await phone('GET', '/api/waketrain/clips/hey_x/clip-1.wav')).status, 403);
    const writes = [
      ['POST', '/api/waketrain/start', { phrase: 'hey there' }],
      ['POST', '/api/waketrain/stop', {}],
      ['POST', '/api/waketrain/install', { model: 'hey_there' }],
      ['POST', '/api/waketrain/clips/hey_x', {}],
      ['POST', '/api/waketrain/clips/hey_x/clip-1.wav/delete', {}],
    ];
    for (const [m, p, b] of writes) {
      const r = await phone(m, p, b);
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'pc_only' }, p);
    }
    assert.equal(fs.existsSync(d.models), false);
  });

  test('a POST without the X-MC header is refused', async () => {
    const r = await localReq(s, { method: 'POST', path: '/api/waketrain/start', body: { phrase: 'hey there' } });
    assert.equal(r.status, 403);
  });

  test('clips over HTTP: upload, list, play, delete, and the limits', async () => {
    const up = (body, headers = {}) => localReq(s, { method: 'POST', path: '/api/waketrain/clips/hey_mission_control', body, headers: { 'X-MC': '1', 'Content-Type': 'audio/wav', ...headers } });
    const a = await up(wav(2));
    assert.equal(a.status, 200);
    assert.equal(a.json.name, 'clip-1.wav');
    assert.equal((await up(wav(2))).json.name, 'clip-2.wav');
    const list = await pc('GET', '/api/waketrain/clips/hey_mission_control');
    assert.deepEqual(list.json.clips.map((c) => c.name), ['clip-1.wav', 'clip-2.wav']);
    const play = await pc('GET', '/api/waketrain/clips/hey_mission_control/clip-1.wav');
    assert.equal(play.status, 200);
    assert.equal(play.headers['content-type'], 'audio/wav');
    assert.equal(play.text.slice(0, 4), 'RIFF');
    assert.equal((await up(Buffer.from('this is not audio at all, just text'.padEnd(80, '.')))).status, 400);
    assert.equal((await up(wav(2, { rate: 44100 }))).status, 400);
    const big = await up(Buffer.alloc(1024 * 1024 + 10, 1));
    assert.equal(big.status, 413);
    // Path tricks through the URL
    for (const p of ['/api/waketrain/clips/..%2F..%2Fx', '/api/waketrain/clips/hey_mission_control/..%2Fclip-1.wav', '/api/waketrain/clips/hey_mission_control/clip-1.wav%00']) {
      const r = await pc('GET', p);
      assert.ok(r.status === 400 || r.status === 404, `${p} gave ${r.status}`);
    }
    assert.equal((await pc('POST', '/api/waketrain/clips/hey_mission_control/..%2Fclip-1.wav/delete', {})).status, 400);
    assert.equal((await pc('POST', '/api/waketrain/clips/hey_mission_control/clip-1.wav/delete', {})).json.clips.length, 1);
    assert.equal((await pc('POST', '/api/waketrain/clips/hey_mission_control/clip-1.wav/delete', {})).status, 404);
  });

  test('start, stream progress as waketrain events, finish, list, install', async () => {
    const bad = await pc('POST', '/api/waketrain/start', { phrase: 'hey; calc', preset: 'quick' });
    assert.equal(bad.status, 400);
    const from = events.length;
    const r = await pc('POST', '/api/waketrain/start', { phrase: 'hey mission control', preset: 'quick', negatives: ['hey vision control', "hey michigan's control"] });
    assert.equal(r.status, 200);
    assert.equal(r.json.phase, 'running');
    await until(() => events.slice(from).some((e) => e.type === 'waketrain' && e.data.kind === 'done'), 10000, 'done event');
    const mine = events.slice(from).filter((e) => e.type === 'waketrain').map((e) => e.data);
    assert.equal(mine[0].kind, 'started');
    assert.ok(mine.some((e) => e.kind === 'progress' && e.stage === 'generate' && e.pct === 100), 'the split line was joined');
    assert.ok(mine.some((e) => e.kind === 'progress' && e.stage === 'verify'));
    assert.ok(['stage', 'pct', 'msg', 'elapsed'].every((k) => k in mine[1]));
    // The quoted arguments came through cmd.exe intact.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'args.json'), 'utf8')), [
      '--phrase', 'hey mission control',
      '--out', path.join(d.models, 'hey_mission_control.onnx'),
      '--preset', 'quick',
      '--clips', path.join(d.clips, 'hey_mission_control'),
      '--negatives', "hey vision control,hey michigan's control",
    ]);
    // A reload gets the last state.
    const again = await pc('GET', '/api/waketrain');
    assert.equal(again.json.state.phase, 'done');
    assert.equal(again.json.state.out, 'hey_mission_control.onnx');
    const models = await pc('GET', '/api/waketrain/models');
    assert.deepEqual(models.json.models.map((m) => [m.id, m.trained, m.installed, m.selected]), [['hey_mission_control', true, false, false]]);
    assert.equal(models.json.models[0].clips, 1);
    const inst = await pc('POST', '/api/waketrain/install', { model: 'hey_mission_control' });
    assert.equal(inst.status, 200);
    assert.equal(inst.json.selected, false);
    assert.equal(inst.json.reason, 'not_linked');
    assert.equal(fs.readFileSync(path.join(d.install, 'hey_mission_control.onnx'), 'utf8'), 'FAKEONNX');
    const after = await pc('GET', '/api/waketrain/models');
    assert.equal(after.json.models[0].installed, true);
    assert.equal((await pc('POST', '/api/waketrain/install', { model: '..\\..\\x' })).status, 400);
  });

  test('over HTTP: a second start is refused while one runs, and Stop ends only that process', async () => {
    await s.stop();
    // Restart the server with a trainer that hangs.
    const dataDir = makeDataDir('wt-http-data2');
    seedFixture(dataDir);
    s = await startServer({
      dataDir,
      env: {
        MC_WAKETRAINER_CMD: FAKE_MJS,
        MC_WAKETRAINER_MODELS_DIR: d.models,
        MC_WAKETRAINER_CLIPS_DIR: d.clips,
        MC_BLITZVOICE_WAKE_DIR: d.install,
        MC_FAKE_WT_MODE: 'hang',
        MC_FAKE_WT_PIDFILE: d.pid,
      },
    });
    toStop.push(s);
    fs.rmSync(d.pid, { force: true });
    const r = await pc('POST', '/api/waketrain/start', { phrase: 'hey hanging' });
    assert.equal(r.status, 200);
    const second = await pc('POST', '/api/waketrain/start', { phrase: 'hey hanging again' });
    assert.equal(second.status, 409);
    const pid = Number(await until(() => (fs.existsSync(d.pid) ? fs.readFileSync(d.pid, 'utf8') : ''), 8000, 'trainer pid'));
    assert.ok(alive(pid));
    const stop = await pc('POST', '/api/waketrain/stop', {});
    assert.equal(stop.status, 200);
    await until(async () => (await pc('GET', '/api/waketrain')).json.state.phase === 'stopped', 10000, 'stopped');
    await until(() => !alive(pid), 5000, 'trainer to end');
    assert.ok(alive(s.pid), 'the server itself must still run');
    assert.equal((await pc('POST', '/api/waketrain/stop', {})).status, 409);
  });
});
