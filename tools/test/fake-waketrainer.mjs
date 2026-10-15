// A fake wake word trainer (tests only). Prints the real trainer's JSON lines in a moment and writes a tiny fake model
// to --out. It never touches the GPU and never trains anything.
//   MC_FAKE_WT_MODE   ok (default) | error (prints an error line, exit 1) | crash (exit 3, no result) | hang (one line, then waits) | demo (three stages, then waits)
//   MC_FAKE_WT_ARGS   a file where the received arguments are written as JSON
//   MC_FAKE_WT_PIDFILE a file where this process id is written
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
// MC_FAKE_WT_MODEFILE names a file holding the mode, read at each start (a screenshot run changes it between trainings).
const fileMode = process.env.MC_FAKE_WT_MODEFILE && fs.existsSync(process.env.MC_FAKE_WT_MODEFILE) ? fs.readFileSync(process.env.MC_FAKE_WT_MODEFILE, 'utf8').trim() : '';
const mode = fileMode || process.env.MC_FAKE_WT_MODE || 'ok';
if (process.env.MC_FAKE_WT_ARGS) fs.writeFileSync(process.env.MC_FAKE_WT_ARGS, JSON.stringify(args));
if (process.env.MC_FAKE_WT_PIDFILE) fs.writeFileSync(process.env.MC_FAKE_WT_PIDFILE, String(process.pid));
const val = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stderr.write('fake trainer: stderr noise that must reach the log only\n');
say({ stage: 'generate', pct: 0, msg: 'start' });
if (mode === 'demo') {
  // Early stages done, features part way, then it waits: a stable picture of a training in progress.
  say({ stage: 'generate', pct: 100, msg: 'voices ready' });
  say({ stage: 'augment', pct: 100, msg: 'augmented' });
  say({ stage: 'features', pct: 45, msg: 'features 4500/10000' });
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  say({ stage: 'generate', pct: 10, msg: 'working' });
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('not json, ignored\n');
  // One line cut in two pieces, to prove the reader joins them.
  process.stdout.write('{"stage":"generate","pc');
  await sleep(30);
  process.stdout.write('t":100,"msg":"voices"}\r\n');
  for (const stage of ['augment', 'features', 'train', 'export', 'verify']) {
    say({ stage, pct: 50, msg: `${stage} half` });
    await sleep(20);
  }
  if (mode === 'error') {
    say({ error: 'fake failure' });
    process.exit(1);
  }
  if (mode === 'crash') process.exit(3);
  const out = val('--out');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'FAKEONNX');
  say({ done: true, out, seconds: 12.5 });
}
