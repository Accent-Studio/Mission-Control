/* Mission Control 2: what the voice features share, ported from redline.js.
   The voice prefs (kept by the server), the three Com Link tones, the spoken phrases (phrases.js), reading a reply aloud,
   and the wake word: this page tells the server when it is looked at (POST /api/voice/focus), and a wake dictation the server
   sends to this page goes to the Talk side (a conversation on screen) or to the Com Link, whichever MC.wakePage() names.
   A phone has its own microphone and speaker (MC.audio, MC.phoneVoice below): BlitzVoice on the PC only writes out what it
   recorded and makes the voice of an answer, which the phone plays.
   Loads after modules.js and /phrases.js, before live.js and home.js (they register MC.voiceSinks.talk and .comlink). */
(() => {
  const api = MC.api, PH = window.MCPhrases;
  const isRemote = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;

  /* ---------- prefs ---------- */
  const VP = MC.vprefs = { readAloud: false, sendPhrase: 'send it', cancelPhrase: 'cancel that', rewritePhrase: 'start over', endPhrase: 'end conversation', listenSilenceSec: 30 };
  const loadPrefs = () => api.get('/api/voice/prefs').then((p) => { if (p && typeof p === 'object') Object.assign(VP, p); }).catch(() => {});
  VP.ready = loadPrefs();
  MC.events.on('voice', (d) => { if (d && d.kind === 'prefs') loadPrefs(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPrefs(); });
  MC.phrases = (all) => ({ send: VP.sendPhrase, cancel: VP.cancelPhrase, ...(all ? { rewrite: VP.rewritePhrase, end: VP.endPhrase } : {}) });
  MC.PhraseWatch = PH ? PH.PhraseWatch : null;
  MC.detectPhrase = (text, all) => (PH ? PH.detect(text, MC.phrases(all)) : null);

  /* ---------- the Com Link tones: listen (rising), cancel (falling), send (double blip); skipped while audio is locked ---------- */
  MC.sound = (() => {
    const GAIN = 0.07, TONES = { listen: [[660, 0, 0.09], [880, 0.09, 0.11]], cancel: [[330, 0, 0.21, 196]], send: [[1568, 0, 0.05], [1568, 0.08, 0.06]] };
    let ctx = null;
    const context = () => { if (ctx) return ctx; const AC = window.AudioContext || window.webkitAudioContext; return AC ? (ctx = new AC()) : null; };
    const tone = (c, t0, s) => {
      const a = t0 + s[1], e = a + s[2], o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = s[0];
      if (s[3]) { o.frequency.setValueAtTime(s[0], a); o.frequency.exponentialRampToValueAtTime(s[3], e); }
      g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(GAIN, a + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, e);
      o.connect(g); g.connect(c.destination); o.start(a); o.stop(e + 0.02);
    };
    const play = (name) => {
      try {
        const spec = TONES[name], c = spec && context(); if (!c) return;
        const asked = Date.now(), go = () => { try { if (c.state !== 'running' || Date.now() - asked > 400) return; const t0 = c.currentTime + 0.01; spec.forEach((t) => tone(c, t0, t)); } catch (e) { /* a missing tone is fine */ } };
        if (c.state === 'running') go(); else { const r = c.resume(); if (r && r.then) r.then(go, () => {}); }
      } catch (e) { /* never throw for a tone */ }
    };
    const unlock = () => { try { const c = context(); if (c && c.state !== 'running') c.resume().catch(() => {}); } catch (e) { /* locked */ } };
    addEventListener('pointerdown', unlock, { capture: true, once: true }); addEventListener('keydown', unlock, { capture: true, once: true });
    return { play };
  })();

  /* ---------- a phone's microphone (ported from redline.js) ----------
     MC.audio.record(o) asks for this device's microphone and resolves { stop() resolving { wav, seconds, peak }, cancel(), seconds() }.
     The sound is brought down to 16kHz mono while it records. It rejects with the getUserMedia error (NotAllowedError: blocked), with
     TimeoutError when the microphone did not answer within o.openMs or the audio would not start, or with AbortError when o.signal is
     aborted. o: maxSec and onLimit (default 1200 s, the most one upload carries), silenceSec and onSilence (default 60 s with nothing
     louder than room noise), skipMs (not kept at the start, so the listen tone is not recorded), onLevel(0 to 1). A start that is
     given up releases the microphone, also when it answers late. */
  MC.audio = (() => {
    const WORKLET = 'class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("wk-cap",C)';
    const wav = (f32) => {
      const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf), str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); str(8, 'WAVEfmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
      v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, f32.length * 2, true);
      for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
      return new Blob([buf], { type: 'audio/wav' });
    };
    const err = (name, m) => Object.assign(new Error(m), { name });
    /* p, or a TimeoutError after ms (none when ms is 0), or an AbortError as soon as signal is aborted */
    const within = (p, ms, signal) => {
      let t, onAbort;
      const late = new Promise((_, no) => {
        if (ms) t = setTimeout(() => no(err('TimeoutError', 'The microphone did not start')), ms);
        if (signal) { onAbort = () => no(err('AbortError', 'Canceled')); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      });
      return Promise.race([p, late]).finally(() => { clearTimeout(t); if (signal && onAbort) signal.removeEventListener('abort', onAbort); });
    };
    async function record(o = {}) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AC && window.AudioWorkletNode)) throw err('NotSupportedError', 'Recording is not supported here');
      const sig = o.signal; let gaveUp = false, stream = null, ctx = null, node = null, url = '';
      try {
        const asked = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
        asked.then((s) => { if (gaveUp) s.getTracks().forEach((t) => t.stop()); }, () => {});
        stream = await within(asked, o.openMs || 0, sig);
        ctx = new AC();
        if (ctx.state !== 'running') await within(ctx.resume().catch(() => {}), 8000, sig);
        url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await within(ctx.audioWorklet.addModule(url), 8000, sig);
        node = new AudioWorkletNode(ctx, 'wk-cap', { numberOfOutputs: 0 });
        if (sig && sig.aborted) throw err('AbortError', 'Canceled');
        ctx.createMediaStreamSource(stream).connect(node);
      } catch (e) {
        gaveUp = true;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (ctx) ctx.close().catch(() => {});
        throw e;
      } finally { if (url) URL.revokeObjectURL(url); }
      const maxSec = o.maxSec || 1200, silenceMs = (o.silenceSec || 60) * 1000, cap = Math.round(maxSec * 16000), keepFrom = performance.now() + (o.skipMs || 0);
      const chunks = [], step = ctx.sampleRate / 16000, CH = 16000;
      let total = 0, level = 0, ended = false, limitT = 0, buf = new Float32Array(CH), at = 0, sum = 0, cnt = 0, edge = step, pos = 0, heardAt = performance.now(), silent = false;
      /* 16kHz as it comes: each kept sample is the mean of the input samples it stands for */
      node.port.onmessage = (e) => {
        const d = e.data; if (!d || performance.now() < keepFrom || total >= cap) return;
        for (let i = 0; i < d.length; i++) {
          sum += d[i]; cnt++; pos++;
          if (pos >= edge) { buf[at++] = sum / cnt; sum = 0; cnt = 0; edge += step; total++; if (at === CH) { chunks.push(buf); buf = new Float32Array(CH); at = 0; } if (total >= cap) break; }
        }
        let peak = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
        level = Math.max(peak, level * 0.85); if (o.onLevel) o.onLevel(Math.min(1, level));
        const now = performance.now();
        if (peak > 0.03) heardAt = now; else if (!silent && o.onSilence && now - heardAt > silenceMs) { silent = true; o.onSilence(); }
      };
      if (o.onLimit) limitT = setTimeout(() => { if (!ended) o.onLimit(); }, maxSec * 1000);
      const end = () => { if (ended) return false; ended = true; clearTimeout(limitT); node.port.onmessage = null; try { node.disconnect(); } catch (e) { /* gone */ } stream.getTracks().forEach((t) => t.stop()); return true; };
      return {
        async stop() {
          if (!end()) return null;
          try { await ctx.close(); } catch (e) { /* closed */ }
          const mono = new Float32Array(Math.min(total, cap)); let n = 0;
          for (const c of chunks.concat([buf.subarray(0, at)])) { const room = mono.length - n; if (room <= 0) break; mono.set(c.length > room ? c.subarray(0, room) : c, n); n += c.length; }
          let peak = 0; for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
          return { wav: wav(mono), seconds: mono.length / 16000, peak };
        },
        async cancel() { if (end()) { try { await ctx.close(); } catch (e) { /* closed */ } } },
        seconds: () => total / 16000,
      };
    }
    return { record, wav };
  })();

  /* ---------- speech written out on the phone itself (Moonshine, in the phone app) ----------
     The phone app gives the page window.MCSpeech (start, stop, cancel) and tells it what it hears through window.MCSpeechEvent(e):
     e.k is 'progress' (e.p 0 to 1, while the model downloads the first time), 'listening', 'text' (e.t all the words so far),
     'done' (e.t the final words) or 'error' (e.m). MC.phoneSpeech.record(o) works like MC.audio.record: it resolves once the
     microphone listens, and its stop() resolves { text, seconds }, or null when it failed. o: signal, onText(words so far),
     onProgress(0 to 1), onError(message) for a failure while it listens, and maxSec/onLimit and silenceSec/onSilence as for
     MC.audio.record (silence here: no new words). null outside the phone app, or in an older one. */
  MC.phoneSpeech = window.MCSpeech ? (() => {
    const N = window.MCSpeech; let sub = null;
    window.MCSpeechEvent = (e) => { if (sub && e) sub(e); };
    const err = (name, m) => Object.assign(new Error(m), { name });
    const record = (o = {}) => new Promise((ok, no) => {
      let started = false, words = '', t0 = 0, done = null, limitT = 0, quietT = 0;
      const quiet = () => { clearTimeout(quietT); if (o.onSilence) quietT = setTimeout(() => { if (sub === mine) o.onSilence(); }, (o.silenceSec || 60) * 1000); };
      const end = () => { if (sub === mine) sub = null; clearTimeout(limitT); clearTimeout(quietT); };
      const onAbort = () => { end(); N.cancel(); no(err('AbortError', 'Canceled')); };
      const finish = (v) => { const d = done; done = null; end(); if (d) d(v); };
      const mine = (e) => {
        if (e.k === 'progress') { if (o.onProgress) o.onProgress(Number(e.p) || 0); }
        else if (e.k === 'listening') {
          started = true; t0 = performance.now(); if (o.signal) o.signal.removeEventListener('abort', onAbort);
          if (o.onLimit) limitT = setTimeout(() => { if (sub === mine) o.onLimit(); }, (o.maxSec || 1200) * 1000);
          quiet(); ok(handle);
        } else if (e.k === 'text') { if (e.t !== words) { words = String(e.t || ''); quiet(); if (o.onText) o.onText(words); } }
        else if (e.k === 'done') finish({ text: String(e.t || words), seconds: handle.seconds() });
        else if (e.k === 'error') {
          if (!started) { end(); no(err('Error', e.m || 'The speech model did not start')); }
          else if (done) finish(null);
          else { end(); if (o.onError) o.onError(e.m || 'Speech recognition failed'); }
        }
      };
      const handle = {
        /* the final words; after 8 s without them, the words heard so far */
        stop: () => new Promise((r) => { done = r; setTimeout(() => { if (done === r) finish({ text: words, seconds: handle.seconds() }); }, 8000); N.stop(); }),
        cancel: async () => { end(); N.cancel(); },
        seconds: () => (t0 ? (performance.now() - t0) / 1000 : 0),
      };
      if (o.signal) { if (o.signal.aborted) { no(err('AbortError', 'Canceled')); return; } o.signal.addEventListener('abort', onAbort, { once: true }); }
      if (sub) N.cancel(); /* one recording at a time */
      sub = mine; N.start();
    });
    return { record };
  })() : null;

  /* ---------- a phone's voice: BlitzVoice on the PC writes out a recording and makes the voice of an answer ----------
     MC.phoneVoice.transcribe(wav, signal) resolves the text (POST /api/voice/transcribe) or throws an Error that says what went
     wrong in a few words. speak(text) plays an answer on this phone (POST /api/voice/tts) and stop() ends it; speaking is false,
     'preparing' or 'speaking', and on(f) is told of every change. "Read replies aloud" on a phone is its own switch (readOn,
     setRead), kept on the phone, so the PC's switch does not make the phone talk or the other way round. */
  const PV = MC.phoneVoice = { speaking: false };
  const pvSubs = new Set(), tellPV = () => pvSubs.forEach((f) => { try { f(); } catch (e) { /* a painter failed */ } });
  PV.on = (f) => pvSubs.add(f);
  PV.readOn = () => { try { return localStorage.getItem('mc2-phone-read') === '1'; } catch (e) { return false; } };
  PV.setRead = (on) => { try { localStorage.setItem('mc2-phone-read', on ? '1' : '0'); } catch (e) { /* storage off */ } if (!on) PV.stop(); tellPV(); };
  /* fetch, with one more try after a network error (the phone's proxy does not retry a POST) */
  const post = async (path, type, body, signal) => {
    let e1;
    for (let i = 0; i < 2; i++) {
      try { return await fetch(path, { method: 'POST', headers: { 'X-MC': '1', 'Content-Type': type }, body, signal }); }
      catch (e) { e1 = e; if (signal && signal.aborted) break; await new Promise((r) => setTimeout(r, 400)); }
    }
    throw e1;
  };
  PV.transcribe = async (wavBlob, signal) => {
    let res;
    try { res = await post('/api/voice/transcribe', 'audio/wav', wavBlob, signal); } catch (e) { if (signal && signal.aborted) throw e; throw new Error('Could not reach the PC, so nothing was added'); }
    let j = null; try { j = await res.json(); } catch (e) { j = null; }
    if (res.ok) return String((j && j.text) || '');
    throw new Error(res.status === 409 && j && j.error === 'no_link_model' ? 'Choose a "Model for Mission Control" in BlitzVoice on the PC'
      : res.status === 409 || res.status === 429 ? 'BlitzVoice is busy. Try again in a moment'
      : res.status === 503 ? (j && j.reason) || 'BlitzVoice is not running on the PC'
      : res.status === 413 ? 'That recording is too long'
      : 'Could not write that out, so nothing was added');
  };
  /* the answer plays through an audio player that the first tap unlocks, so an answer that comes later plays without a tap */
  let pctx = null, cur = null, gen = 0;
  const player = () => { if (pctx) return pctx; const AC = window.AudioContext || window.webkitAudioContext; return AC ? (pctx = new AC()) : null; };
  addEventListener('pointerdown', () => { if (!(MC.phone || isRemote())) return; try { const c = player(); if (c && c.state !== 'running') c.resume().catch(() => {}); } catch (e) { /* locked */ } }, true);
  const setSpeaking = (v) => { if (PV.speaking !== v) { PV.speaking = v; tellPV(); } };
  PV.stop = () => { gen++; const c = cur; cur = null; if (c) c(); setSpeaking(false); };
  PV.speak = async (text) => {
    PV.stop(); const g = ++gen; setSpeaking('preparing');
    let res, buf;
    try { res = await post('/api/voice/tts', 'application/json', JSON.stringify({ text })); if (res.ok && res.status !== 204) buf = await res.arrayBuffer(); }
    catch (e) { if (g === gen) { setSpeaking(false); MC.toast('Could not read the answer aloud', 'warn'); } return null; }
    if (g !== gen) return null;
    if (!buf) { setSpeaking(false); if (!res.ok) MC.toast(res.status === 503 ? 'BlitzVoice is not running on the PC' : 'Could not read the answer aloud', 'warn'); return null; }
    const done = () => { if (g === gen) { cur = null; setSpeaking(false); } };
    try {
      const c = player(); if (!c) throw new Error('no player');
      if (c.state !== 'running') await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (c.state !== 'running') throw new Error('locked');
      const ab = await c.decodeAudioData(buf.slice(0)); if (g !== gen) return null;
      const src = c.createBufferSource(); src.buffer = ab; src.connect(c.destination); src.onended = done;
      cur = () => { try { src.stop(); } catch (e) { /* ended */ } };
      src.start();
    } catch (e) {
      /* no unlocked player: a plain audio element, which may still be allowed */
      if (g !== gen) return null;
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })), a = new Audio(url);
      const fin = () => { URL.revokeObjectURL(url); done(); };
      a.onended = fin; a.onerror = fin;
      cur = () => { try { a.pause(); } catch (er) { /* gone */ } URL.revokeObjectURL(url); };
      try { await a.play(); } catch (er) { fin(); MC.toast('The phone would not play the answer. Tap the page once, then try again', 'warn'); return null; }
      if (g !== gen) return null;
    }
    setSpeaking('speaking');
    return { ok: true, phone: true };
  };
  addEventListener('pagehide', () => PV.stop());

  /* ---------- reading a reply aloud ---------- */
  const said = new Set();
  /* always: the Com Link reads every spoken answer; the Talk side only with "Read replies aloud" on (a phone: its own switch) */
  MC.speakReply = async (text, key, always) => {
    text = String(text || '').trim(); if (!text) return null;
    await VP.ready;
    if (!always && !(isRemote() ? PV.readOn() : VP.readAloud)) return null;
    if (key) { if (said.has(key)) return null; said.add(key); if (said.size > 100) said.delete(said.values().next().value); }
    if (isRemote()) return PV.speak(text);
    try { return await api.post('/api/voice/speak', { text, key }); } catch (e) { return null; /* BlitzVoice may be busy or off */ }
  };
  MC.stopSpeaking = () => (isRemote() ? Promise.resolve(PV.stop()) : api.post('/api/voice/speak/stop', {}).catch(() => {}));
  MC.discardDictation = () => api.post('/api/voice/discard', {}).catch(() => {});

  /* ---------- the wake word: which page gets it ---------- */
  MC.tabId = MC.tabId || (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, '').slice(0, 40);
  MC.wakePage = MC.wakePage || (() => 'comlink');
  let seq = 0;
  const tellFocus = (beat, gone) => {
    if (isRemote()) return; /* a phone never takes a wake dictation */
    const body = { tab: MC.tabId, seq: ++seq, at: performance.timeOrigin + performance.now() };
    if (gone) body.gone = true;
    else Object.assign(body, { page: MC.wakePage(), visible: document.visibilityState === 'visible', beat: !!beat, focused: document.hasFocus() });
    try { fetch('/api/voice/focus', { method: 'POST', keepalive: true, headers: { 'X-MC': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (e) { /* offline */ }
  };
  MC.tellFocus = () => tellFocus(false);
  document.addEventListener('visibilitychange', () => tellFocus(false));
  addEventListener('focus', () => tellFocus(false));
  addEventListener('pagehide', () => tellFocus(false, true));
  setInterval(() => tellFocus(true), 30000);
  Promise.resolve(MC.whoami).then(() => tellFocus(false));

  /* each wake dictation keeps the side it started on, so its live words and its text land in the same place */
  MC.voiceSinks = {};
  const sinkOf = {}, done = new Set();
  const sink = (id) => MC.voiceSinks[sinkOf[id] || (MC.wakePage() === 'chat' ? 'talk' : 'comlink')];
  MC.events.on('voice', (d) => {
    if (!d || isRemote() || !d.target || d.target !== MC.tabId) return;
    const id = d.id == null ? '' : String(d.id);
    if (d.kind === 'wake') { sinkOf[id] = MC.wakePage() === 'chat' ? 'talk' : 'comlink'; const s = sink(id); if (s && s.wake) s.wake(id); }
    else if (d.kind === 'partial' && d.wake) { if (done.has(id)) return; if (!sinkOf[id]) sinkOf[id] = MC.wakePage() === 'chat' ? 'talk' : 'comlink'; const s = sink(id); if (s && s.partial) s.partial(id, String(d.text || '')); }
    else if (d.kind === 'transcript' && d.wake) {
      if (done.has(id)) return; done.add(id); if (done.size > 50) done.delete(done.values().next().value);
      const s = sink(id); delete sinkOf[id];
      if (s && s.final) s.final(id, String(d.text == null ? '' : d.text).replace(/\s+/g, ' ').trim(), d.error ? String(d.error) : '');
    } else if (d.kind === 'wake_note' && d.note) MC.toast(String(d.note), 'mic');
  });
  /* a sink that acted on a phrase marks the dictation done, so its late words and text are ignored */
  MC.wakeDone = (id) => { if (id) done.add(String(id)); };
})();
