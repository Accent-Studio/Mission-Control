// The timings llama-server writes to its log, read back (services/localPerf.js). Nothing but text in, numbers out.
import path from 'node:path';

// ---- The settings a llama-server ran with, from its flags ----

const QUANT = /(IQ\d_[A-Z]+|Q\d_K(?:_[SML])?|Q\d_\d|Q\d_K|BF16|F16|F32|MXFP4)/i;
function flagValue(args, names) {
  for (const n of names) { const i = args.indexOf(n); if (i >= 0 && i + 1 < args.length) return args[i + 1]; }
  return null;
}
const DRAFT_FLAGS = ['-md', '--model-draft', '--spec-draft-model', '-hfd', '-hfrd', '--hf-repo-draft', '--spec-draft-hf', '--spec-type', '--draft', '--draft-max', '--lookup-ngram-min'];

// { quant, ctx, kv, draft, model } from the words after "===== <time>" (or from a model's entry when nothing ran yet).
export function settingsOf(args, fallback = {}) {
  const model = flagValue(args, ['-m', '--model']) || fallback.model || '';
  const q = QUANT.exec(path.basename(model));
  const ctk = flagValue(args, ['-ctk', '--cache-type-k']) || 'f16';
  const ctv = flagValue(args, ['-ctv', '--cache-type-v']) || 'f16';
  const draftAt = args.findIndex((a) => DRAFT_FLAGS.includes(a));
  const draftModel = flagValue(args, ['-md', '--model-draft', '--spec-draft-model']);
  return {
    model: path.basename(model),
    quant: q ? q[1].toUpperCase() : null,
    ctx: Number(flagValue(args, ['-c', '--ctx-size'])) || fallback.ctx || null,
    kv: ctk === ctv ? ctk : `K ${ctk}, V ${ctv}`,
    draft: draftAt < 0 || flagValue(args, ['--spec-type']) === 'none' ? null : draftModel ? path.basename(draftModel) : args.slice(draftAt, draftAt + 2).join(' '),
  };
}

const START = /^===== (\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/;
const REL = /^(\d+)\.(\d\d)\.(\d{3})\.\d{3} /;
const TIMING = /task (\d+) \|\s+(prompt eval|eval) time =\s+([\d.]+) ms \/\s+(\d+) tokens/;
const DRAFT = /task (\d+) \|.*draft acceptance rate = ([\d.]+) \(\s*(\d+) accepted \/\s*(\d+) generated/;
const RELEASE = /task (\d+) \| stop processing: n_tokens = (\d+)/;
// written after a start by the gate or the benchmark: what it took on the card
const VRAM = /^##### vram (-?\d+) MiB at (\d+) context, (\d+) MiB in use before, (\d+) of (\d+) MiB after/;
const SLOW_KV = /no FlashAttention vector kernel compiled for K\/V types (\S+?),/;

// The answers and the llama-server starts of one log text: { sessions: [{ at, settings, warn }], answers: [...] }.
// An answer: { t, s (its session), task, promptTok, promptMs, genTok, genMs, ctx, draftOk, draftAll }.
export function parseServerLog(text, fallback) {
  const sessions = [];
  const answers = [];
  const byTask = new Map();
  let s = null;
  for (const line of text.split(/\r?\n/)) {
    const st = START.exec(line);
    if (st) {
      const words = st[2].split(/\s+/);
      s = { at: Date.parse(st[1]), settings: settingsOf(words.slice(1), fallback), warn: null, vram: null };
      sessions.push(s);
      byTask.clear();
      continue;
    }
    if (!s) continue;
    const vr = VRAM.exec(line);
    if (vr) { s.vram = { ownMB: Number(vr[1]), ctx: Number(vr[2]), beforeMB: Number(vr[3]), afterMB: Number(vr[4]), totalMB: Number(vr[5]) }; continue; }
    const r = REL.exec(line);
    if (!r) continue;
    const t = s.at + Number(r[1]) * 60000 + Number(r[2]) * 1000 + Number(r[3]);
    let m;
    if ((m = TIMING.exec(line))) {
      const task = m[1];
      let a = byTask.get(task);
      if (!a) { a = { t, s: sessions.length - 1, task: Number(task), promptTok: 0, promptMs: 0, genTok: 0, genMs: 0, ctx: null, draftOk: null, draftAll: null }; byTask.set(task, a); answers.push(a); }
      a.t = t;
      if (m[2] === 'prompt eval') { a.promptMs = Number(m[3]); a.promptTok = Number(m[4]); } else { a.genMs = Number(m[3]); a.genTok = Number(m[4]); }
    } else if ((m = DRAFT.exec(line))) {
      const a = byTask.get(m[1]);
      if (a) { a.draftOk = Number(m[3]); a.draftAll = Number(m[4]); }
    } else if ((m = RELEASE.exec(line))) {
      const a = byTask.get(m[1]);
      if (a) a.ctx = Number(m[2]);
    } else if (!s.warn && (m = SLOW_KV.exec(line))) {
      s.warn = `This llama.cpp has no fast kernel for the cache types ${m[1]}, so it converts them to f16 on every token (slower).`;
    }
  }
  return { sessions, answers };
}
