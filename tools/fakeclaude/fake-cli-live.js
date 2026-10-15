// Fake Claude CLI, stream-json input mode: stays alive until stdin closes, one turn per burst of user lines.
// A turn is 3 steps (tool_use, wait, tool_result). User lines that arrive during a turn are taken in at the next
// step boundary (their replay is emitted there), like the real CLI. No network, no model.
// Magic words in a prompt: ASK (permission request at step 2), HANG (never finishes), CRASH (exits with 3), FLOOD (many big text blocks),
// SENDFILE <path> (a SendUserFile call and result at step 1), READIMG (a tool_result holding an image),
// BGAGENT / BGBASH (a background helper agent / shell command, with the real CLI's task events; see startBackground below).
// Env: FAKE_STEP_MS (default 250), FAKE_LOG (file: one JSON line per spawn, stdin line and response),
// FAKE_INIT_MS (delay before the first output of a turn, so the session id arrives late),
// FAKE_FLOOD_N, FAKE_FLOOD_B, FAKE_FLOOD_MS (size and pace of the FLOOD word),
// FAKE_END_MS (a pause between the last reply of a turn and its result line), FAKE_UUID=ignore (replay ids of its own, not the ones given),
// FAKE_RC (how the remote_control control request is answered: ok, error, policy, silent, foreign),
// FAKE_BG_MS and FAKE_BG_MODE (how long a background task runs, and which events tell about it: system, text, lost).
const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (n) => {
  const k = args.indexOf(n);
  return k >= 0 ? args[k + 1] : null;
};
const sid = flag('--resume') || crypto.randomUUID();
const STEP = Number(process.env.FAKE_STEP_MS) || 250;
const LOG = process.env.FAKE_LOG;
const log = (o) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, t: Date.now(), ...o }) + '\n');
};
// FAKE_TRANSCRIPT (a folder): the process writes its conversation to <folder>/<session id>.jsonl as it goes, shaped like
// the real CLI's transcript: a user record for the first message of a turn, a queued_command attachment for a message
// taken in mid-turn, one assistant record per block, one user record per tool result. The file is appended to, so a
// resumed conversation keeps its earlier records.
const TDIR = process.env.FAKE_TRANSCRIPT || '';
let tLast = null;
let tPrompted = false;
const savedAtArrival = new Set(); // ids of messages already saved when they arrived mid-turn
const textOfBlocks = (m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
// A message that arrives while a turn is running is saved at once, as a queued_command attachment naming the message it
// delivers (source_uuid): the real CLI writes it before it takes the message into a turn, so it can be in the transcript
// before the result line of the turn it arrived in has been read.
function persistQueued(m) {
  if (!TDIR) return;
  const uuid = crypto.randomUUID();
  const rec = { parentUuid: tLast, isSidechain: false, attachment: { type: 'queued_command', prompt: textOfBlocks(m.message), source_uuid: m.rid, delivery_id: crypto.randomUUID(), commandMode: 'prompt', origin: { kind: 'human' } }, type: 'attachment', uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'sdk-cli', cwd: process.cwd(), sessionId: sid, version: '2.1.296' };
  tLast = uuid;
  savedAtArrival.add(m.rid);
  fs.mkdirSync(TDIR, { recursive: true });
  fs.appendFileSync(require('path').join(TDIR, sid + '.jsonl'), JSON.stringify(rec) + '\n');
}
function persist(o) {
  if (!TDIR) return;
  if (o.type === 'user' && o.isReplay && savedAtArrival.delete(o.uuid)) return;
  const uuid = crypto.randomUUID();
  const base = { parentUuid: tLast, isSidechain: false, uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'sdk-cli', cwd: process.cwd(), sessionId: sid, version: '2.1.296' };
  let rec = null;
  if (o.type === 'assistant') rec = { ...base, type: 'assistant', message: o.message };
  else if (o.type === 'user' && o.isReplay) {
    const text = (Array.isArray(o.message.content) ? o.message.content : [{ type: 'text', text: String(o.message.content) }]).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (!tPrompted) {
      tPrompted = true;
      rec = { ...base, uuid: o.uuid, type: 'user', promptId: crypto.randomUUID(), message: o.message, promptSource: 'sdk', turnOrigin: 'sdk' };
    } else rec = { ...base, type: 'attachment', attachment: { type: 'queued_command', prompt: text, source_uuid: o.uuid, delivery_id: crypto.randomUUID(), commandMode: 'prompt', origin: { kind: 'human' } } };
  } else if (o.type === 'user') rec = { ...base, type: 'user', message: o.message };
  if (!rec) return;
  tLast = uuid;
  fs.mkdirSync(TDIR, { recursive: true });
  fs.appendFileSync(require('path').join(TDIR, sid + '.jsonl'), JSON.stringify(rec) + '\n');
}
const out = (o) => {
  persist(o);
  process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

log({ ev: 'spawn', args, cwd: process.cwd() });

let queue = [];
let busy = false;
let stdinClosed = false;
const waiters = new Map(); // request_id -> resolve(response)

const blocksOf = (m) => (Array.isArray(m.message.content) ? m.message.content : [{ type: 'text', text: String(m.message.content) }]);
const textOf = (m) => blocksOf(m).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
const typesOf = (m) => blocksOf(m).map((b) => b.type).join(',');
// FAKE_CACHE=5m or 1h: every answer reads the prompt cache and writes a little to it with that lifetime (Keep warm tests)
const CACHE = process.env.FAKE_CACHE === '5m' || process.env.FAKE_CACHE === '1h' ? process.env.FAKE_CACHE : '';
const usageNow = () => (CACHE ? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: CACHE === '5m' ? 50 : 0, ephemeral_1h_input_tokens: CACHE === '1h' ? 50 : 0 } } : { input_tokens: 10, output_tokens: 5 });
const assistant = (content) => out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID().slice(0, 8), role: 'assistant', model: flag('--model') || 'fake', content, usage: usageNow() } });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === 'user') {
      log({ ev: 'stdin-user', text: textOf(m), blocks: typesOf(m), blockData: blocksOf(m).map((b) => (b.type === 'image' || b.type === 'document' ? { type: b.type, media_type: b.source && b.source.media_type, bytes: b.source && b.source.data ? Buffer.from(b.source.data, 'base64').length : 0 } : b)) });
      // FAKE_UUID=ignore: like a CLI that does not take the id Mission Control gives the message, it makes up its own.
      m.rid = (process.env.FAKE_UUID === 'ignore' ? null : typeof m.uuid === 'string' && m.uuid) || crypto.randomUUID();
      if (busy) persistQueued(m);
      queue.push(m);
      kick();
    } else if (m.type === 'control_request') {
      answerControl(m);
    } else if (m.type === 'control_response') {
      const r = m.response || {};
      log({ ev: 'stdin-control-response', response: m });
      const w = waiters.get(r.request_id);
      if (w) {
        waiters.delete(r.request_id);
        w(r.response || {});
      }
    }
  }
});
// Control requests from Mission Control. Only remote_control is answered, like the real CLI:
// success {session_url, connect_url, environment_id, bridge_epoch, bridge_session_id} (enabled:true) or {} (enabled:false).
// FAKE_RC: ok (default), error (not signed in with a claude.ai account), policy (organization policy, with an error_code),
// silent (never answers), foreign (the session_url is not a claude.ai address).
let rcEpoch = 0;
function answerControl(m) {
  const req = m.request || {};
  log({ ev: 'stdin-control-request', subtype: req.subtype, enabled: req.enabled, request_id: m.request_id });
  if (req.subtype !== 'remote_control') {
    out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported control request subtype: ' + req.subtype } });
    return;
  }
  const mode = process.env.FAKE_RC || 'ok';
  if (mode === 'silent') return;
  const fail = (error, code) => out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error, ...(code ? { error_code: code } : {}) } });
  if (req.enabled === false) {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    return;
  }
  if (mode === 'error') return fail('Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in with your claude.ai account.');
  if (mode === 'policy') return fail("Remote Control is disabled by your organization's policy.", 'remote_control_policy_disabled');
  const bridge = 'session_fake' + sid.replace(/-/g, '').slice(0, 12);
  out({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: m.request_id,
      response: {
        session_url: mode === 'foreign' ? 'https://example.com/code/' + bridge : 'https://claude.ai/code/' + bridge,
        connect_url: 'https://claude.ai/code?environment=env_fake',
        environment_id: 'env_fake',
        bridge_epoch: ++rcEpoch,
        bridge_session_id: bridge,
      },
    },
  });
}

process.stdin.on('end', () => {
  stdinClosed = true;
  log({ ev: 'stdin-end' });
  if (!busy && !bgTasks.size) process.exit(0); // like the real CLI, a closed stdin waits for background work to finish
});

function kick() {
  if (busy || !queue.length) return;
  busy = true;
  runTurn().then(() => {
    busy = false;
    if (queue.length) kick();
    else if (stdinClosed && !bgTasks.size) process.exit(0);
  });
}

// ---- Background work, reported the way the real CLI does (read from its stream-json output code) ----
// BGAGENT in a prompt starts a background helper agent (Agent tool_use with run_in_background), BGBASH a background shell command.
// Both tell the CLI's way: the tool_result "Async agent launched successfully ... agentId: X" / "Command running in background with ID: X",
// then system events: background_tasks_changed (the full set of live background tasks, replace semantics), task_started, and
// at the end task_updated (status completed), task_notification and background_tasks_changed again. When the task is done the CLI
// queues a <task-notification> user message and answers it with a turn of its own, even if nobody wrote to it.
// How long it runs: BGMS=<ms> in the prompt, else FAKE_BG_MS (default 1500).
// FAKE_BG_MODE=text leaves out the system events (only the tool_result text and the notification message remain);
// FAKE_BG_MODE=lost leaves out the end events and the notification (a "finished" event that never comes).
const bgTasks = new Map(); // task id -> { type, description, toolUseId }
const BG_MODE = process.env.FAKE_BG_MODE || 'system';
const sysEvent = (o) => out({ type: 'system', uuid: crypto.randomUUID(), ...o });
const bgLevel = () =>
  sysEvent({
    subtype: 'background_tasks_changed',
    tasks: [...bgTasks.entries()].map(([id, t]) => ({ task_id: id, run_id: id + '-1', task_type: t.type, ...(t.type === 'local_agent' ? { subagent_type: 'general-purpose' } : {}), description: t.description })),
  });

function startBackground(kind, text) {
  const ms = Number((/\bBGMS=(\d+)/.exec(text) || [])[1]) || Number(process.env.FAKE_BG_MS) || 1500;
  const agent = kind === 'AGENT';
  const id = (agent ? 'a' : 'b') + crypto.randomBytes(agent ? 8 : 4).toString('hex');
  const toolUseId = 'toolu_' + crypto.randomUUID().slice(0, 12);
  const description = agent ? 'Fake helper' : 'Fake build';
  assistant([{ type: 'tool_use', id: toolUseId, name: agent ? 'Agent' : 'Bash', input: agent ? { description, prompt: 'help', run_in_background: true } : { command: 'long job', run_in_background: true } }]);
  const result = agent
    ? `Async agent launched successfully.\nagentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`
    : `Command running in background with ID: ${id}. Output is being written to: C:\\tmp\\tasks\\${id}.output. You will be notified when it completes.`;
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }] }, parent_tool_use_id: null });
  bgTasks.set(id, { type: agent ? 'local_agent' : 'local_bash', description, toolUseId });
  log({ ev: 'bg-start', id, ms, mode: BG_MODE });
  if (BG_MODE === 'system' || BG_MODE === 'lost') {
    bgLevel();
    sysEvent({ subtype: 'task_started', task_id: id, tool_use_id: toolUseId, description, task_type: agent ? 'local_agent' : 'local_bash', is_backgrounded: true, ...(agent ? { subagent_type: 'general-purpose' } : {}) });
  }
  if (BG_MODE === 'lost') return; // the task is never reported as finished
  setTimeout(() => {
    bgTasks.delete(id);
    log({ ev: 'bg-end', id });
    if (BG_MODE === 'system') {
      sysEvent({ subtype: 'task_updated', task_id: id, patch: { status: 'completed', end_time: Date.now() } });
      sysEvent({ subtype: 'task_notification', task_id: id, tool_use_id: toolUseId, status: 'completed', output_file: '', summary: agent ? `Agent "${description}" finished` : `Background command "${description}" completed` });
      bgLevel();
    }
    const note = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file></output-file>\n<status>completed</status>\n<summary>${agent ? `Agent "${description}" finished` : `Background command "${description}" completed`}</summary>\n</task-notification>`;
    queue.push({ type: 'user', rid: crypto.randomUUID(), origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text', text: note }] } });
    kick();
    if (stdinClosed && !busy && !bgTasks.size && !queue.length) process.exit(0);
  }, ms);
}

async function runTurn() {
  tPrompted = false;
  const consumed = [];
  const consume = () => {
    const taken = queue.splice(0);
    for (const m of taken) {
      consumed.push(m);
      out({ type: 'user', isReplay: true, uuid: m.rid, parent_tool_use_id: null, timestamp: new Date().toISOString(), message: m.message, ...(m.origin ? { origin: m.origin } : {}) });
    }
    return taken;
  };
  const all = () => consumed.map(textOf).join(' | ');
  if (Number(process.env.FAKE_INIT_MS) > 0) await sleep(Number(process.env.FAKE_INIT_MS));
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: flag('--model') || 'default', permissionMode: flag('--permission-mode') || 'default' });
  const first = consume();
  await sleep(80);
  assistant([{ type: 'text', text: `ECHO text="${first.map(textOf).join(' | ')}" blocks=[${first.map(typesOf).join('; ')}] cwd=${process.cwd()} model=${flag('--model')} mode=${flag('--permission-mode')} effort=${flag('--effort')} resume=${flag('--resume') ? 'yes' : 'no'}` }]);

  let denied = false;
  for (let step = 1; step <= 3; step++) {
    const toolId = 'toolu_' + crypto.randomUUID().slice(0, 12);
    assistant([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo step ${step}` } }]);
    const text = all();
    if (step === 1 && /\bCRASH\b/.test(text)) process.exit(3);
    if (step === 2 && /\bASK\b/.test(text)) {
      const rid = crypto.randomUUID();
      out({
        type: 'control_request',
        request_id: rid,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: { command: 'echo ask && touch ask.txt', description: 'Create ask.txt', long: 'x'.repeat(5000), n: 7 },
          description: 'Create ask.txt',
          permission_suggestions: [
            { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo ask' }], behavior: 'allow', destination: 'localSettings' },
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ],
          tool_use_id: toolId,
        },
      });
      const resp = await new Promise((resolve) => waiters.set(rid, resolve));
      denied = resp.behavior === 'deny';
      assistant([
        {
          type: 'text',
          text: `PERMISSION ${resp.behavior}${denied ? ' message=' + resp.message : ' updatedInput=' + (resp.updatedInput ? Object.keys(resp.updatedInput).join('+') : 'none') + ' updatedPermissions=' + (Array.isArray(resp.updatedPermissions) ? resp.updatedPermissions.length : 0)}`,
        },
      ]);
    }
    // QUIZ: Claude's AskUserQuestion tool, a multiple choice question card; the answers come back in updatedInput.answers
    if (step === 2 && /\bQUIZ\b/.test(text)) {
      const rid = crypto.randomUUID();
      const qid = 'toolu_' + crypto.randomUUID().slice(0, 12);
      assistant([{ type: 'tool_use', id: qid, name: 'AskUserQuestion', input: {} }]);
      out({
        type: 'control_request',
        request_id: rid,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              { question: 'Which layout should the card use?', header: 'Layout', multiSelect: false, options: [{ label: 'Stacked', description: 'Buttons one under the other' }, { label: 'One row', description: 'Buttons side by side' }] },
              { question: 'Which pages should get it?', header: 'Pages', multiSelect: true, options: [{ label: 'Home', description: '' }, { label: 'Project', description: '' }, { label: 'Talk', description: '' }] },
            ],
          },
          tool_use_id: qid,
        },
      });
      const resp = await new Promise((resolve) => waiters.set(rid, resolve));
      denied = resp.behavior === 'deny';
      assistant([{ type: 'text', text: denied ? `QUIZ denied message=${resp.message}` : `QUIZ answers=${JSON.stringify((resp.updatedInput && resp.updatedInput.answers) || null)} questions=${resp.updatedInput && Array.isArray(resp.updatedInput.questions) ? resp.updatedInput.questions.length : 0}` }]);
    }
    if (step === 2 && /\bHANG\b/.test(text)) await new Promise(() => {});
    await sleep(STEP);
    const content = [{ type: 'tool_result', tool_use_id: toolId, content: denied && step === 2 ? 'Denied' : `step ${step} done`, ...(denied && step === 2 ? { is_error: true } : {}) }];
    out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });

    // FLOOD in a prompt: a stream of big text blocks (FAKE_FLOOD_N blocks of FAKE_FLOOD_B characters, default 300 of 1500)
    if (step === 1 && /\bFLOOD\b/.test(text)) {
      const n = Number(process.env.FAKE_FLOOD_N) || 300;
      const b = Number(process.env.FAKE_FLOOD_B) || 1500;
      for (let i = 0; i < n; i++) {
        assistant([{ type: 'text', text: 'flood ' + i + ' ' + 'x'.repeat(b) }]);
        if (i % 50 === 0) await sleep(Number(process.env.FAKE_FLOOD_MS) || 20); // a pause every 50 blocks
      }
    }
    if (step === 1) {
      const sf =/SENDFILE (\S+)/.exec(text);
      if (sf) {
        const sendId = 'toolu_' + crypto.randomUUID().slice(0, 12);
        assistant([{ type: 'tool_use', id: sendId, name: 'SendUserFile', input: { files: [sf[1]], caption: 'Here it is', status: 'normal' } }]);
        const ext = (sf[1].split('.').pop() || '').toLowerCase();
        out({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: sendId, content: 'Sent 1 file' }] },
          parent_tool_use_id: null,
          tool_use_result: { caption: 'Here it is', attachments: [{ path: sf[1], size: 10, isImage: ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext), media_type: 'image/' + ext, pathValidated: true, file_uuid: crypto.randomUUID() }], rendered_locally: true },
        });
      }
      const bg = /\bBG(AGENT|BASH)\b/.exec(text);
      if (bg) startBackground(bg[1], text);
      if (/\bREADIMG\b/.test(text)) {
        const rid2 = 'toolu_' + crypto.randomUUID().slice(0, 12);
        assistant([{ type: 'tool_use', id: rid2, name: 'Read', input: { file_path: 'x.png' } }]);
        out({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: rid2, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG1 } }] }] },
          parent_tool_use_id: null,
          tool_use_result: { type: 'image', file: { base64: PNG1, type: 'image/png', originalSize: 70 } },
        });
      }
    }

    const injected = consume(); // step boundary: messages written during the step are taken in here
    if (injected.length) {
      await sleep(30);
      assistant([{ type: 'text', text: `INJECTED step=${step} text="${injected.map(textOf).join(' | ')}" blocks=[${injected.map(typesOf).join('; ')}]` }]);
    }
  }
  assistant([{ type: 'text', text: `DONE messages=${consumed.length} all="${all()}"` }]);
  if (Number(process.env.FAKE_END_MS) > 0) await sleep(Number(process.env.FAKE_END_MS)); // the window between the last reply and the result line
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1000, num_turns: 3, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });
}
