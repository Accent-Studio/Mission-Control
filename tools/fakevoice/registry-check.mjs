// Unit check for the wake target registry (noteTab / pickWakeTarget). Run: node tools/fakevoice/registry-check.mjs
// It uses its own data folder and a fake clock, and never starts a server or touches BlitzVoice.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.MC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-registry-'));
const { noteTab, pickWakeTarget, resetTabs } = await import('../../server/services/voice.js');

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};
const throws = (name, fn) => {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  eq(name, e && e.status, 400);
};

const T0 = 1_000_000_000_000;
const seqs = {};
// One report from a tab at fake time `now` (ms after T0). seq rises by itself unless given; at defaults to now.
const rep = (tab, now, body = {}, extra = {}) =>
  noteTab({ tab, page: 'chat', seq: extra.seq ?? (seqs[tab] = (seqs[tab] || 0) + 1), at: T0 + (extra.at ?? now), visible: true, focused: false, ...body }, T0 + now);
const pick = (now) => pickWakeTarget(T0 + now);
const fresh = () => { resetTabs(); for (const k of Object.keys(seqs)) delete seqs[k]; };

// 1. Late visible:true after false: the older report arrives last and must not win.
fresh();
rep('A', 1000, { focused: true });
rep('B', 2000, { focused: true });
eq('B is the target after it was focused last', pick(2500), 'B');
noteTab({ tab: 'A', page: 'chat', seq: 3, at: T0 + 3000, visible: false, focused: false }, T0 + 3100); // A hid at 3000
noteTab({ tab: 'A', page: 'chat', seq: 2, at: T0 + 2900, visible: true, focused: true }, T0 + 3200); // older report, arrives late
eq('late visible:true (seq 2 after seq 3) is dropped', pick(3300), 'B');
noteTab({ tab: 'A', page: 'chat', seq: 4, at: T0 + 1500, visible: true, focused: true }, T0 + 3400);
eq('a focus event timed before the one of B does not steal the target', pick(3500), 'B');

// 2. Visible but unfocused tab: never takes the target from a focused one, even when it reports later.
fresh();
rep('A', 1000, { focused: true });
rep('B', 5000, { focused: false });
eq('visible but unfocused B does not beat focused A', pick(5100), 'A');
rep('B', 6000, { focused: false, beat: true });
eq('a heartbeat does not change the focus order', pick(6100), 'A');
rep('B', 7000, { focused: true, beat: true });
eq('a focused heartbeat is not a focus event either', pick(7100), 'A');
rep('B', 8000, { focused: true });
eq('a real focus event on B makes B the target', pick(8100), 'B');

// 3. Replay: same or lower seq is dropped.
fresh();
rep('A', 1000, { focused: true });
rep('B', 2000, { focused: true });
const r = noteTab({ tab: 'A', page: 'chat', seq: 1, at: T0 + 9000, visible: true, focused: true }, T0 + 9000);
eq('replayed seq is ignored', r.ignored, true);
eq('replay does not move the target', pick(9100), 'B');
const r2 = noteTab({ tab: 'A', page: 'chat', seq: 0, at: T0 + 9000, visible: true, focused: true }, T0 + 9000);
eq('lower seq is ignored', r2.ignored, true);

// 4. at is clamped to [now-60s, now]: a future time cannot win, an ancient one counts as 60s old.
fresh();
rep('A', 100000, { focused: true });
noteTab({ tab: 'B', page: 'chat', seq: 1, at: T0 + 999999999, visible: true, focused: true }, T0 + 101000); // claims the far future
rep('A', 102000, { focused: true });
eq('a future "at" is clamped to now, so a later real focus still wins', pick(102100), 'A');
fresh();
noteTab({ tab: 'A', page: 'chat', seq: 1, at: T0 - 5_000_000, visible: true, focused: true }, T0 + 100000);
eq('an ancient "at" is clamped to 60s old (still a target)', pick(100500), 'A');
eq('and it goes stale like any visible tab after 95s without a report', pick(100000 + 36000), null);

// 5. gone: removes the tab at once, and a late older report cannot bring it back.
fresh();
rep('A', 1000, { focused: true });
rep('B', 2000, { focused: true });
noteTab({ tab: 'B', gone: true, seq: 2, at: T0 + 2500 }, T0 + 2500);
eq('after gone the previous tab is the target', pick(2600), 'A');
noteTab({ tab: 'B', page: 'chat', seq: 1, at: T0 + 2400, visible: true, focused: true }, T0 + 2700);
eq('a late older report does not resurrect a gone tab', pick(2800), 'A');
noteTab({ tab: 'B', page: 'chat', seq: 3, at: T0 + 3000, visible: true, focused: true }, T0 + 3000);
eq('a newer report (page restored) brings it back', pick(3100), 'B');
noteTab({ tab: 'A', gone: true, seq: 2, at: T0 + 3200 }, T0 + 3200);
noteTab({ tab: 'B', gone: true, seq: 4, at: T0 + 3300 }, T0 + 3300);
eq('no tabs, no target', pick(3400), null);

// 6. Hidden fallback: most recently visible tab within 2 minutes.
fresh();
rep('A', 1000, { focused: true });
rep('B', 2000, { focused: true });
rep('A', 3000, { visible: false });
rep('B', 4000, { visible: false });
eq('all hidden: the one visible last gets it', pick(10000), 'B');
rep('B', 60000, { visible: false, beat: true });
eq('a hidden heartbeat does not extend the grace', pick(4000 + 130000), null);
eq('within 2 minutes of the last visible time it still counts', pick(4000 + 119000), 'B');

// 7. Cap 50: the least recently seen tab goes, not the oldest inserted.
fresh();
for (let i = 0; i < 50; i++) rep('t' + i, 1000 + i, { focused: true });
rep('t0', 5000, { focused: true, beat: true }); // t0 is the oldest inserted but was seen again
rep('new', 6000, { focused: true }); // the 51st tab: t1 (least recently seen) is evicted
const t0again = noteTab({ tab: 't0', page: 'chat', seq: 2, at: T0 + 6001, visible: true, focused: true, beat: true }, T0 + 6001);
eq('t0 (seen again) survived: its seq 2 is a replay', t0again.ignored, true);
const t1again = noteTab({ tab: 't1', page: 'chat', seq: 1, at: T0 + 6002, visible: true, focused: true }, T0 + 6002);
eq('t1 (least recently seen) was evicted: its seq 1 is accepted as new', t1again.ignored, undefined);

// 8. Bad input.
throws('missing seq', () => noteTab({ tab: 'A', page: 'chat', at: T0, visible: true }, T0));
throws('bad page', () => noteTab({ tab: 'A', page: 'x', seq: 1, at: T0, visible: true }, T0));
throws('missing at', () => noteTab({ tab: 'A', page: 'chat', seq: 1, visible: true }, T0));

// After a server restart: the first report of each tab is a heartbeat; the focused one must still win.
fresh();
rep('A', 1000, { focused: true, beat: true });
rep('B', 2000, { focused: false, beat: true });
eq('after a restart, the focused tab wins on its first heartbeat', pick(2100), 'A');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
