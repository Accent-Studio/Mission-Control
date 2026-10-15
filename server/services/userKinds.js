// Sorts the user-side records of a Claude Code transcript (and the same events in a live stream-json output)
// into what they really are. The CLI stores more than the human's words as type "user":
//   task notifications  a background agent, command or workflow finished
//   helper reports      "Another Claude session sent a message": the hand-back of a subagent
//   skill and hook text, image notes and other meta records
//   tool results        going back to the model
// Newer transcripts mark them: origin.kind ("human", "task-notification", "peer"), promptSource ("sdk" for
// the human's prompts and Mission Control's own, "system" for injected ones) and isMeta. Older ones have no
// markers, so the text shape is the fallback (only when the record has no origin and no promptSource at all,
// so a message sent from Mission Control that happens to start with the same words stays the user's).
// Pure functions, no file or network access.

export const NOTICE_TEXT_MAX = 20 * 1024;
const LABEL_MAX = 120;

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TASK_START = /^\s*<task-notification>/;
const PEER_START = /^\s*Another Claude session sent a message:/;
const BAD_WORDS = /fail|kill|stop|cancel|error/i;

// The Handoff expiry action (expiryAction.js) sends this message before the prompt cache runs out. It shows as one dim line,
// not as the user's words; Claude's handoff that follows is a normal answer.
export const HANDOFF_MARK = '[Mission Control handoff]';
export const HANDOFF_PROMPT = `${HANDOFF_MARK} The prompt cache of this conversation runs out in a few minutes. Use the handoff skill now: write the handoff of this conversation (work half done, gaps, what to do next, and a handoff prompt for a new conversation). Do not start new work.`;

export function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Turns raw user text into something readable, or '' when it is only system noise.
export function cleanUserText(raw) {
  let t = String(raw || '').replace(REMINDER_RE, '').trim();
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    return collapse(`${cmd[1].trim()} ${args ? args[1].trim() : ''}`);
  }
  if (/^<(local-command-|command-message|bash-)/.test(t)) return '';
  if (/^Caveat: The messages below/.test(t)) return '';
  if (/^\[Request interrupted/.test(t)) return '';
  return t;
}

// All text blocks of a message, joined (a plain string is returned as is).
export function rawTextOf(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = [];
    for (const b of c) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    return parts.join('\n');
  }
  return '';
}

export function userTextOf(message) {
  return cleanUserText(rawTextOf(message));
}

function clip(s, n) {
  const t = collapse(String(s == null ? '' : s));
  return t.length > n ? t.slice(0, n - 3).trimEnd() + '...' : t;
}

function capText(s) {
  return s.length > NOTICE_TEXT_MAX ? s.slice(0, NOTICE_TEXT_MAX) + '...' : s;
}

function tagOf(text, name) {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(text);
  return m ? m[1] : '';
}

// Words for a finished background task. A failure is always said in words, never by color alone.
function statusWord(status, summaryVerb) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'finished') return 'finished';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled' || s === 'canceled') return s === 'canceled' ? 'cancelled' : s;
  if (s) return s;
  const v = String(summaryVerb || '').toLowerCase();
  if (v === 'completed' || v === 'finished') return 'finished';
  return v || null;
}

function taskNotice(text) {
  const summary = clip(tagOf(text, 'summary'), 400);
  const status = tagOf(text, 'status');
  const toolUseId = tagOf(text, 'tool-use-id') || null;
  const m = /^(Agent|Dynamic workflow) "([^"]*)"\s+(\w+)/.exec(summary);
  let label;
  let word;
  if (m) {
    word = statusWord(status, m[3]);
    label = `${m[1] === 'Agent' ? 'Helper' : 'Workflow'} ${word || 'finished'}: ${clip(m[2], 80)}`;
  } else {
    word = statusWord(status, '');
    label = clip(summary || 'Background task update', LABEL_MAX);
    if (word && BAD_WORDS.test(word) && !BAD_WORDS.test(label)) label = clip(label, LABEL_MAX - word.length - 3) + ` (${word})`;
  }
  return { kind: 'notice', type: 'task', label, status: word, toolUseId, text: capText(text.trim()) };
}

function peerNotice(o, text) {
  const origin = o.origin && typeof o.origin === 'object' ? o.origin : {};
  const name = typeof origin.name === 'string' && origin.name.trim() ? clip(origin.name, 40) : 'a helper';
  const body = typeof origin.body === 'string' && origin.body.trim() ? origin.body : text;
  return { kind: 'notice', type: 'peer', label: `Report from ${name}`, status: null, toolUseId: null, text: capText(body.trim()) };
}

function otherNotice(type, label, text) {
  return { kind: 'notice', type, label, status: null, toolUseId: null, text: capText(text.trim()) };
}

// Messages that arrive while Claude is still answering are not stored as type "user" records. The CLI writes:
//   queue-operation enqueue / dequeue / remove   bookkeeping only (the text of an idle send is enqueued too, and
//                                                then comes back as a normal user record, so these are never shown)
//   an attachment of type "queued_command"       the delivery itself: attachment.prompt is the text,
//                                                attachment.origin says who sent it (human, task-notification, peer)
// Only the queued_command attachment is read. It is the one record that exists exactly once per delivered
// mid-turn message, and a delivered one has no normal user record of its own.
export function isQueuedCommand(o) {
  return !!o && o.type === 'attachment' && !!o.attachment && typeof o.attachment === 'object' && o.attachment.type === 'queued_command';
}

function classifyQueued(o, { legacyText }) {
  const a = o.attachment;
  if (typeof a.prompt !== 'string' && !Array.isArray(a.prompt)) return { kind: 'hidden' };
  const pseudo = { type: 'user', isSidechain: o.isSidechain, message: { role: 'user', content: a.prompt } };
  if (a.origin && typeof a.origin === 'object') pseudo.origin = a.origin;
  const c = classifyUserEntry(pseudo, { legacyText });
  // Anything that is not words or a notice (a tool result, a bare image) has nothing to show here.
  if (c.kind === 'user' && !c.text) return { kind: 'hidden' };
  if (c.kind !== 'user' && c.kind !== 'notice') return { kind: 'hidden' };
  return { ...c, queued: true };
}

// Classifies one user-side record (a transcript line, or a stream-json event). Returns one of:
//   { kind: 'user', text }                      the human's words ('' for a prompt that is only an image)
//   { kind: 'notice', type, label, status, toolUseId, text }
//                                               injected by the system: type 'task', 'peer', 'summary' or 'system'
//   { kind: 'tool' }                            a tool result going back to the model
//   { kind: 'hidden' }                          noise that is shown nowhere (skill text, image notes, command echoes)
// options.legacyText: false turns the text-shape fallback off (live events: the human's own messages are replayed
// without markers, and only a marker may call one of them a notice).
export function classifyUserEntry(o, { legacyText = true } = {}) {
  const HIDDEN = { kind: 'hidden' };
  if (isQueuedCommand(o)) return classifyQueued(o, { legacyText });
  if (!o || o.type !== 'user') return HIDDEN;
  const c = o.message && o.message.content;
  const origin = o.origin && typeof o.origin === 'object' ? o.origin : null;
  const kind = origin && typeof origin.kind === 'string' ? origin.kind : null;
  const raw = rawTextOf(o.message);
  const text = raw.replace(REMINDER_RE, '').trim();
  const fallback = legacyText && !origin && !o.promptSource;

  const hasBody = !!origin && typeof origin.body === 'string' && origin.body.trim() !== '';
  if ((kind === 'peer' && (text || hasBody)) || (fallback && PEER_START.test(text))) return peerNotice(o, text); // these are isMeta too
  if (o.isMeta) return HIDDEN; // skill text, image notes, hook output: not the user's words
  if ((kind === 'task-notification' && text) || (fallback && TASK_START.test(text))) return taskNotice(text);

  const clean = cleanUserText(raw);
  if (o.isCompactSummary && clean) return otherNotice('summary', 'Earlier conversation summarized', clean);
  if (kind && kind !== 'human' && clean) return otherNotice('system', 'System message', clean);
  if (!kind && o.promptSource === 'system' && clean) return otherNotice('system', 'System message', clean);
  if (clean && clean.startsWith(HANDOFF_MARK)) return otherNotice('handoff', 'Handoff asked before the cache ran out', '');
  if (clean) return { kind: 'user', text: clean };

  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return { kind: 'tool' };
  // A prompt that is only an attached image has no text, but it is still a message.
  if (Array.isArray(c) && c.some((b) => b && b.type === 'image') && (!kind || kind === 'human') && o.promptSource !== 'system' && !o.isCompactSummary) {
    return { kind: 'user', text: '' };
  }
  return HIDDEN;
}
