// How much context a local model gets: as much as fits in the graphics memory left at the moment it starts, up to its
// "ctx" in .data/config.json, so that the card stays under the model's "vramTargetMB" in all (default 15 GB: past about
// 15.6 GB Windows quietly moves memory to the PC's RAM and the model slows down several times).
//
// A llama-server's memory = a fixed part (weights, working buffers, the MTP head's own buffers) + context memory per
// token. The per-token part is exact, from the model file's own numbers (llama.cpp keeps a cache only for its full
// attention layers, plus the MTP layer when speculative decoding runs on it). The fixed part is measured: every start
// reads the card before and after loading (VRAM_FILE), and the latest start of the same file and cache types is used.
// Before the first measure, it is estimated from the file's size.
// Used by the gate (llmgate/index.js) and the benchmark (services/localPerf.js).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { LOCAL_MODELS_DIR } from '../config.js';

export const VRAM_FILE = path.join(LOCAL_MODELS_DIR, 'vram.json');
export const DEFAULT_TARGET_MB = 15360;
// The context sizes tried, largest first (only those up to the model's own "ctx").
export const CTX_STEPS = [262144, 196608, 131072, 98304, 65536, 49152, 32768, 16384];
const MIN_CTX = 16384;
const MiB = 1048576;

// ---- The model file's own numbers ----

// Reads the header of a GGUF file (only as far as its settings), in pieces.
function readGgufMeta(file) {
  const fd = fs.openSync(file, 'r');
  let buf = Buffer.alloc(0);
  let pos = 0; // file offset of buf[0]
  let at = 0; // read position in the file
  const need = (n) => {
    while (at + n > pos + buf.length) {
      const chunk = Buffer.alloc(Math.max(1 << 20, n));
      const got = fs.readSync(fd, chunk, 0, chunk.length, pos + buf.length);
      if (!got) throw new Error('the file ends in its header');
      buf = Buffer.concat([buf.subarray(at - pos), chunk.subarray(0, got)]);
      pos = at;
    }
  };
  const u32 = () => { need(4); const v = buf.readUInt32LE(at - pos); at += 4; return v; };
  const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(at - pos)); at += 8; return v; };
  const str = () => { const n = u64(); need(n); const s = buf.toString('utf8', at - pos, at - pos + n); at += n; return s; };
  const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const one = (t) => {
    if (t === 8) return str();
    const n = SIZE[t];
    need(n);
    const o = at - pos;
    const v = t === 0 ? buf.readUInt8(o) : t === 1 ? buf.readInt8(o) : t === 2 ? buf.readUInt16LE(o) : t === 3 ? buf.readInt16LE(o)
      : t === 4 ? buf.readUInt32LE(o) : t === 5 ? buf.readInt32LE(o) : t === 6 ? buf.readFloatLE(o) : t === 7 ? buf.readUInt8(o) !== 0
      : t === 10 ? Number(buf.readBigUInt64LE(o)) : t === 11 ? Number(buf.readBigInt64LE(o)) : buf.readDoubleLE(o);
    at += n;
    return v;
  };
  try {
    need(4);
    if (buf.toString('latin1', 0, 4) !== 'GGUF') throw new Error('not a GGUF file');
    at = 4;
    u32(); u64(); // version, tensor count
    const keys = u64();
    const meta = {};
    for (let i = 0; i < keys; i++) {
      const k = str();
      const t = u32();
      if (t === 9) {
        const et = u32();
        const n = u64();
        if (et === 8) { for (let j = 0; j < n; j++) str(); meta[k] = `[${n} strings]`; } // the tokenizer's words: skipped
        else { const v = []; for (let j = 0; j < n; j++) v.push(one(et)); meta[k] = n <= 4096 ? v : `[${n}]`; }
      } else meta[k] = one(t);
    }
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

const infoCache = new Map(); // file -> { mtime, info }
// { layers, attnLayers, kvHeads (per attention layer, summed), keyLen, valLen, mtpLayers, bytes } or null
export function ggufInfo(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = infoCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.info;
  let info = null;
  try {
    const meta = readGgufMeta(file);
    const arch = meta['general.architecture'];
    const g = (k) => meta[`${arch}.${k}`];
    const mtpLayers = Number(g('nextn_predict_layers')) || 0;
    const layers = (Number(g('block_count')) || 0) - mtpLayers;
    const every = Number(g('full_attention_interval')) || 1;
    const heads = g('attention.head_count_kv');
    const headsAt = (i) => (Array.isArray(heads) ? Number(heads[i]) || 0 : Number(heads) || 0);
    let kvHeads = 0;
    let attnLayers = 0;
    for (let i = 0; i < layers; i++) if ((i + 1) % every === 0 && headsAt(i) > 0) { attnLayers++; kvHeads += headsAt(i); }
    const keyLen = Number(g('attention.key_length')) || Number(g('embedding_length')) / (Number(g('attention.head_count')) || 1);
    const valLen = Number(g('attention.value_length')) || keyLen;
    info = layers > 0 && kvHeads > 0 && keyLen > 0 ? { layers, attnLayers, kvHeads, keyLen, valLen, mtpLayers, mtpKvHeads: headsAt(layers) || headsAt(0), bytes: st.size } : null;
  } catch {
    info = null;
  }
  infoCache.set(file, { mtime: st.mtimeMs, info });
  return info;
}

// Bytes per value of each cache type (a block of 32 values and its scale).
const TYPE_BYTES = { f32: 4, f16: 2, bf16: 2, q8_0: 34 / 32, q5_1: 24 / 32, q5_0: 22 / 32, q4_1: 20 / 32, q4_0: 18 / 32, iq4_nl: 18 / 32 };
const flag = (args, names, d) => { for (const n of names) { const i = args.indexOf(n); if (i >= 0 && i + 1 < args.length) return args[i + 1]; } return d; };
export const cacheTypes = (args) => ({ k: flag(args, ['-ctk', '--cache-type-k'], 'f16'), v: flag(args, ['-ctv', '--cache-type-v'], 'f16') });
export const usesMtp = (args) => /draft-mtp/.test(flag(args, ['--spec-type'], ''));

// Context memory per token, in bytes; null when the file cannot be read.
export function bytesPerToken(info, args) {
  if (!info) return null;
  const { k, v } = cacheTypes(args);
  const per = (heads) => heads * (info.keyLen * (TYPE_BYTES[k] || 2) + info.valLen * (TYPE_BYTES[v] || 2));
  return per(info.kvHeads) + (usesMtp(args) && info.mtpLayers ? per(info.mtpKvHeads * info.mtpLayers) : 0);
}

// ---- Measures ----

const keyOf = (file, args) => { const { k, v } = cacheTypes(args); return [path.basename(file), k, v, usesMtp(args) ? 'mtp' : ''].join('|'); };
function readSamples() { try { const j = JSON.parse(fs.readFileSync(VRAM_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }

// One start: the card before and after loading. Kept: the last 200.
export function recordStart(file, args, ctx, beforeMB, afterMB) {
  const all = readSamples();
  all.push({ t: new Date().toISOString(), key: keyOf(file, args), ctx, beforeMB, afterMB, ownMB: afterMB - beforeMB });
  try { fs.mkdirSync(LOCAL_MODELS_DIR, { recursive: true }); fs.writeFileSync(VRAM_FILE, JSON.stringify(all.slice(-200), null, 1)); } catch { /* not kept */ }
}

// The fixed part of a model's memory, in MiB: measured (the latest start of the same file and cache types, without its
// context memory), or estimated from the file's size.
export function fixedMB(file, args, perTok) {
  const key = keyOf(file, args);
  const s = readSamples().filter((x) => x.key === key && x.ownMB > 0).pop();
  if (s && perTok) return { mb: Math.max(0, s.ownMB - (perTok * s.ctx) / MiB), measured: true };
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch { /* missing */ }
  return { mb: bytes / MiB + (usesMtp(args) ? 2048 : 1280), measured: false };
}

// The card now: { usedMB, totalMB }, or null without nvidia-smi. Tests set MC_VRAM_TEST to '{"usedMB":..,"totalMB":..}'.
export function vramNow() {
  if (process.env.MC_VRAM_TEST) { try { return Promise.resolve(JSON.parse(process.env.MC_VRAM_TEST)); } catch { return Promise.resolve(null); } }
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const [used, total] = String(out).split(/\r?\n/)[0].split(',').map((x) => parseFloat(x));
      resolve(Number.isFinite(used) && Number.isFinite(total) ? { usedMB: used, totalMB: total } : null);
    });
  });
}

// Waits until the card's use stops falling (a server just stopped gives its memory back over a second or two).
export async function vramSettled() {
  let last = await vramNow();
  for (let i = 0; i < 12 && last; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await vramNow();
    if (!now || now.usedMB >= last.usedMB - 64) return now || last;
    last = now;
  }
  return last;
}

// The context to start with: the largest step up to maxCtx whose memory keeps the card under targetMB.
// { ctx, needMB, fixedMB, perTokB, measured } (ctx null: not even MIN_CTX fits; needMB is then what MIN_CTX needs).
// Without a reading of the card (no nvidia-smi), maxCtx.
export function chooseCtx({ file, args, maxCtx, targetMB = DEFAULT_TARGET_MB, usedMB }) {
  const perTok = bytesPerToken(ggufInfo(file), args) || 65536;
  const fixed = fixedMB(file, args, perTok);
  const need = (c) => Math.round(fixed.mb + (perTok * c) / MiB);
  const base = { fixedMB: Math.round(fixed.mb), perTokB: Math.round(perTok), measured: fixed.measured };
  if (!Number.isFinite(usedMB)) return { ctx: maxCtx, needMB: need(maxCtx), ...base };
  const steps = [maxCtx, ...CTX_STEPS.filter((c) => c < maxCtx)].filter((c) => c >= Math.min(MIN_CTX, maxCtx));
  for (const c of steps) if (usedMB + need(c) <= targetMB) return { ctx: c, needMB: need(c), ...base };
  return { ctx: null, needMB: need(steps[steps.length - 1]), ...base };
}
