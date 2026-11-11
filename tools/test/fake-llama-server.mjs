// A fake llama-server (tests only, localperf.test.mjs): the benchmark starts it as it would start the real one.
//   node fake-llama-server.mjs [llama-server flags...]
// Answers /health, /props, /tokenize and /completion with fixed timings (faster with --spec-type, as a draft would make
// it). A model file with "IQ2_S" in its name does not fit above 64K of context: it exits as llama-server does when the
// graphics memory runs out. Each start adds its flags to seen.jsonl, next to the model file.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const model = val('-m');
const ctx = Number(val('-c'));
const spec = val('--spec-type');
fs.appendFileSync(path.join(path.dirname(model), 'seen.jsonl'), JSON.stringify({ model: path.basename(model), ctx, spec, args }) + '\n');
if (/IQ2_S/.test(model) && ctx > 65536) {
  console.error('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096.00 MiB on device 0: cudaMalloc failed: out of memory');
  process.exit(1);
}
const write = spec ? 80 : 50;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.url === '/props') return res.end(JSON.stringify({ build_info: 'b9999-fake' }));
    const j = JSON.parse(body || '{}');
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: j.content.split(' ').map((_, i) => i % 1000) }));
    if (req.url === '/v1/chat/completions') {
      // a real-work task: a short answer, its timings, and the slots it ran with
      fs.appendFileSync(path.join(path.dirname(model), 'chats.jsonl'), JSON.stringify({ np: Number(val('-np')), unified: args.includes('--kv-unified'), thinking: j.chat_template_kwargs && j.chat_template_kwargs.enable_thinking }) + '\n');
      const out = 20;
      const t = { prompt_n: 100, prompt_ms: 50, predicted_n: out, predicted_ms: (out / write) * 1000 };
      if (spec) Object.assign(t, { draft_n: 10, draft_n_accepted: 5 });
      return setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: out }, timings: t })), 20);
    }
    const n = j.prompt.length;
    const t = { prompt_n: n, prompt_ms: n / 2, prompt_per_second: 2000, predicted_n: j.n_predict, predicted_ms: (j.n_predict / write) * 1000, predicted_per_second: write };
    if (spec) Object.assign(t, { draft_n: 40, draft_n_accepted: 30 });
    res.end(JSON.stringify({ content: '', timings: t }));
  });
}).listen(Number(val('--port')), '127.0.0.1');
