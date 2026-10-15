// Fake Claude CLI for tests: prints stream-json like `claude -p --output-format stream-json`, no network.
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.1.278 (Claude Code)');
  process.exit(0);
}
if (args.includes('--system-prompt') && args.includes('--no-session-persistence')) {
  // a naming request (server/services/autoTitle.js): plain text out, the first four words of the message as the name
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const msg = (input.split('First message:')[1] || '').trim();
    process.stdout.write('"Fake ' + msg.split(/\s+/).slice(0, 4).join(' ') + '."\n');
    process.exit(0);
  });
} else if (args.includes('--input-format')) {
  require('./fake-cli-live.js'); // stream-json input: see fake-cli-live.js
} else {
const i = args.indexOf('--');
const prompt = i >= 0 ? args.slice(i + 1).join(' ') : '';
const r = args.indexOf('--resume');
const sid = r >= 0 ? args[r + 1] : '11111111-2222-4333-8444-' + String(Date.now()).slice(-12).padStart(12, '0');
const flag = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : null; };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: flag('--model') || 'default', permissionMode: flag('--permission-mode') || 'default', cwd: process.cwd() });
out({ type: 'assistant', session_id: sid, message: { id: 'm1', model: flag('--model') || 'x', content: [{ type: 'text', text: 'ECHO: ' + prompt + ' | cwd=' + process.cwd() + ' | model=' + flag('--model') + ' | mode=' + flag('--permission-mode') + ' | effort=' + flag('--effort') + ' | resume=' + (r >= 0 ? 'yes' : 'no') }], usage: { input_tokens: 10, output_tokens: 5 } } });
setTimeout(() => {
  out({ type: 'result', subtype: 'success', session_id: sid, is_error: false, result: 'ok', duration_ms: 4000, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
}, 4000);
}
