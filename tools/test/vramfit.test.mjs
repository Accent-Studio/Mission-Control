// How much context a local model starts with (lib/vramFit.js): the context memory per token from the model file's own
// numbers, the fixed part measured at each start, and the largest context that keeps the card under its target.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { makeDataDir } from './harness.mjs';

let V, dir;
before(async () => {
  dir = makeDataDir('mc-vramfit');
  process.env.MC_DATA_DIR = dir; // the measures go to this test's folder, not the real one
  V = await import('../../server/lib/vramFit.js');
});

// A GGUF header with the settings of a hybrid model: 64 layers, one in 4 with full attention, 4 KV heads of 256, and
// an MTP layer when mtp. Then `pad` bytes, so the file has a size.
function gguf(file, { mtp = false, pad = 0 } = {}) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); };
  const str = (s) => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
  const kv = [['general.architecture', 8, 'qwen35'], ['qwen35.block_count', 4, mtp ? 65 : 64], ['qwen35.full_attention_interval', 4, 4],
    ['qwen35.attention.head_count', 4, 24], ['qwen35.attention.head_count_kv', 4, 4], ['qwen35.attention.key_length', 4, 256],
    ['qwen35.attention.value_length', 4, 256], ['tokenizer.ggml.tokens', 9, ['a', 'b', 'c']]];
  if (mtp) kv.push(['qwen35.nextn_predict_layers', 4, 1]);
  parts.push(Buffer.from('GGUF')); u32(3); u64(0); u64(kv.length);
  for (const [k, t, v] of kv) {
    str(k); u32(t);
    if (t === 8) str(v); else if (t === 4) u32(v); else { u32(8); u64(v.length); v.forEach(str); }
  }
  parts.push(Buffer.alloc(pad));
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

const ARGS = ['-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q4_0'];
const MTP = [...ARGS, '--spec-type', 'draft-mtp'];

describe('the context memory of a model', () => {
  test('counts only the full attention layers, at the cache types, plus the MTP layer when it drafts', () => {
    const plain = gguf(path.join(dir, 'm.gguf'));
    const withMtp = gguf(path.join(dir, 'm-mtp.gguf'), { mtp: true });
    // 16 layers x 4 heads x 256 x (34/32 + 18/32) bytes
    assert.equal(V.bytesPerToken(V.ggufInfo(plain), ARGS), 26624);
    assert.equal(V.bytesPerToken(V.ggufInfo(withMtp), ARGS), 26624); // MTP off: its layer keeps no cache
    assert.equal(V.bytesPerToken(V.ggufInfo(withMtp), MTP), 26624 + 1664);
    assert.equal(V.bytesPerToken(V.ggufInfo(plain), ['-ctk', 'q8_0', '-ctv', 'q8_0']), 16 * 4 * 256 * 2 * (34 / 32));
    assert.equal(V.ggufInfo(path.join(dir, 'missing.gguf')), null);
  });
});

describe('the context a model starts with', () => {
  test('is the largest that keeps the card under the target, from the measured fixed part', () => {
    const f = gguf(path.join(dir, 'fit.gguf'));
    // measured: 128K took 13,000 MiB, so 9,672 MiB of it is fixed (128K x 26,624 bytes = 3,328 MiB)
    V.recordStart(f, ARGS, 131072, 600, 13600);
    const at = (usedMB) => V.chooseCtx({ file: f, args: ARGS, maxCtx: 131072, targetMB: 15360, usedMB });
    assert.equal(at(600).ctx, 131072); // 600 + 13,000 fits under 15,360
    assert.equal(at(600).measured, true);
    assert.equal(at(2600).ctx, 98304); // ComfyUI holds 2 GB more: 96K
    assert.equal(at(4200).ctx, 49152);
    assert.equal(at(4500).ctx, 32768);
    const none = at(6000);
    assert.equal(none.ctx, null);
    assert.ok(none.needMB > 9672);
    assert.equal(at(NaN).ctx, 131072); // no reading of the card: the saved context
  });

  test('never goes above the saved context, and estimates from the file size before the first start', () => {
    const f = gguf(path.join(dir, 'new.gguf'), { pad: 1024 * 1024 });
    const c = V.chooseCtx({ file: f, args: ARGS, maxCtx: 32768, targetMB: 15360, usedMB: 0 });
    assert.equal(c.ctx, 32768);
    assert.equal(c.measured, false);
  });
});
