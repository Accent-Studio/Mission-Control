import { sendJson, readJson, readBytes, badRequest } from '../lib/http.js';
import { getMemory, setMemory, stripMemoryTags } from '../services/persona.js';
import { applyRemoteSetting } from '../services/runs.js';
import {
  startVoice, voiceStatus, voiceAction, voiceDiscard, buildStartBody, voiceSpeak, getVoicePrefs, setVoicePrefs, wakeStatus, setWakeSettings, noteTab, SPEAK_MAX,
  PHONE_WAV_MAX, checkPhoneWav, voiceTranscribe, voiceSpeakWav,
} from '../services/voice.js';

// Connect as soon as the routes load, so the first page view already has a live link.
startVoice();

const act = (name) => ({
  method: 'POST',
  path: `/api/voice/${name}`,
  handler: async (req, res) => {
    // Start may ask for live words (partials), no automatic stop (autostop) and a model; the dictation cleanup switch
    // lives in the voice preferences unless the page says otherwise, so every tab and later a phone agree on it.
    const r = name === 'start' ? await voiceAction('start', buildStartBody(await readJson(req))) : name === 'discard' ? await voiceDiscard() : await voiceAction(name, {});
    sendJson(res, r.status, r.body);
  },
});

// At most two phone voice jobs (transcribe and tts together) are in flight at once. Over that is a 429 busy, answered before
// the body is read (the connection is closed after it, so an unread upload is not kept). Returns a release function, or null.
const PHONE_JOBS_MAX = 2;
let phoneJobs = 0;
function takePhoneSlot(req, res) {
  if (phoneJobs >= PHONE_JOBS_MAX) {
    res.setHeader('Connection', 'close');
    sendJson(res, 429, { error: 'busy' });
    return null;
  }
  phoneJobs++;
  let freed = false;
  return () => {
    if (freed) return;
    freed = true;
    phoneJobs--;
  };
}

export const routes = [
  { method: 'GET', path: '/api/voice', handler: async (req, res) => sendJson(res, 200, voiceStatus()) },
  { method: 'GET', path: '/api/voice/prefs', handler: async (req, res) => sendJson(res, 200, getVoicePrefs()) },
  {
    method: 'PUT',
    path: '/api/voice/prefs',
    handler: async (req, res) => {
      const body = await readJson(req);
      const prefs = setVoicePrefs(body);
      if (body && typeof body === 'object' && 'remoteControl' in body) applyRemoteSetting(); // the live Claude processes follow "Show on claude.ai"
      sendJson(res, 200, prefs);
    },
  },
  // The Com Link's own memory (its persona), shown and edited on the Settings page
  { method: 'GET', path: '/api/voice/memory', handler: async (req, res) => sendJson(res, 200, getMemory()) },
  { method: 'PUT', path: '/api/voice/memory', handler: async (req, res) => sendJson(res, 200, setMemory(await readJson(req))) },
  { method: 'GET', path: '/api/voice/wake', handler: async (req, res) => sendJson(res, 200, wakeStatus()) },
  {
    method: 'POST',
    path: '/api/voice/wake',
    handler: async (req, res) => {
      const r = await setWakeSettings(await readJson(req));
      sendJson(res, r.status, r.body);
    },
  },
  // Pages say when they are visible or focused, so a wake dictation reaches the tab being looked at.
  { method: 'POST', path: '/api/voice/focus', handler: async (req, res) => sendJson(res, 200, noteTab(await readJson(req, 4096))) },
  act('start'),
  act('stop'),
  act('cancel'),
  // Ends the dictation at once with no transcription, no paste and no transcript (the assistant uses it for "send it" and "cancel that").
  act('discard'),
  {
    method: 'POST',
    path: '/api/voice/speak',
    handler: async (req, res) => {
      const b = await readJson(req, 256 * 1024);
      if (!b || typeof b.text !== 'string' || !b.text.trim()) return badRequest(res, 'text is required');
      if (b.key != null && typeof b.key !== 'string') return badRequest(res, 'key must be a string');
      const r = await voiceSpeak(b.text.slice(0, SPEAK_MAX * 2), b.key, b.voice);
      sendJson(res, r.status, r.body);
    },
  },
  // A phone's voice. Its own microphone makes the recording and its own speaker plays the answer, so these use only
  // BlitzVoice's speech engines (never the PC's microphone or speakers) and a paired phone may call them.
  {
    method: 'POST',
    path: '/api/voice/transcribe',
    handler: async (req, res) => {
      const release = takePhoneSlot(req, res);
      if (!release) return;
      try {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes(type)) return sendJson(res, 415, { error: 'Send the recording as audio/wav' });
        const wav = await readBytes(req, PHONE_WAV_MAX);
        const ok = checkPhoneWav(wav);
        if (!ok.ok) return sendJson(res, 400, { error: ok.why });
        const r = await voiceTranscribe(wav);
        sendJson(res, r.status, r.body);
      } finally {
        release();
      }
    },
  },
  {
    method: 'POST',
    path: '/api/voice/tts',
    handler: async (req, res) => {
      const release = takePhoneSlot(req, res);
      if (!release) return;
      try {
        const b = await readJson(req, 256 * 1024);
        if (!b || typeof b.text !== 'string' || !b.text.trim()) return badRequest(res, 'text is required');
        // A "voice" field is ignored on purpose: the voice is the one chosen in BlitzVoice.
        const r = await voiceSpeakWav(stripMemoryTags(b.text));
        if (r.status !== 200) return sendJson(res, r.status, r.body);
        if (r.body.skipped) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': r.body.wav.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(r.body.wav);
      } finally {
        release();
      }
    },
  },
  {
    method: 'POST',
    path: '/api/voice/speak/stop',
    handler: async (req, res) => {
      const r = await voiceAction('speak/stop', {});
      sendJson(res, r.status, r.body);
    },
  },
];
