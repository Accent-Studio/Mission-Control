/* Mission Control 2: the Settings page on real data, ported from today's Settings page (settings.html).
   Look (this PC), Com Link (brain, listening, memory), Talk, Claude, Reading, Spoken commands, Wake words, Folders and
   archived projects. The server keeps every pref in .data/voice-prefs.json (GET and PUT /api/voice/prefs) and uses a change
   at once. Loads after panels.js. */
(() => {
  const { $, $$, esc, icon: I, state: S } = MC;
  const api = MC.api, LV = MC.live, enc = encodeURIComponent;
  const errText = (e) => (e && (e.body && e.body.error)) || (e && e.message) || 'No answer';

  const ST = { prefs: null, models: [], memory: null, wake: null, archived: null, err: {}, saved: {} };
  let el = null;

  async function loadAll() {
    const got = await Promise.allSettled([api.get('/api/voice/prefs'), api.get('/api/chat/options'), api.get('/api/voice/memory'), api.get('/api/waketrain/models'), api.get('/api/projects?all=1'), api.get('/api/waketrain')]);
    const v = (i) => (got[i].status === 'fulfilled' ? got[i].value : null);
    ST.prefs = v(0) || ST.prefs; if (!v(0)) ST.err.page = errText(got[0].reason);
    ST.models = ((v(1) && v(1).models) || []).filter((m) => !m.disabled);
    ST.memory = v(2);
    ST.wake = v(3);
    const pr = v(4); ST.archived = pr ? (Array.isArray(pr) ? pr : pr.projects || []).filter((p) => p.hidden) : null;
    if (v(5)) wkOverview(v(5));
    paint();
  }

  /* ---------- controls: each carries the pref key it saves ---------- */
  const row = (label, ctl) => `<div class="fr"><div class="fl2"><b>${label}</b></div>${ctl}</div>`;
  const tog = (key) => `<span class="tog ${ST.prefs && ST.prefs[key] ? 'on' : ''}" data-pt="${key}" role="switch" tabindex="0"></span>`;
  const seg = (key, opts, cur) => `<span class="seg" data-sk="${key}">${opts.map(([v, l]) => `<button data-v="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(l)}</button>`).join('')}</span>`;
  /* a list of choices: a field that opens the app's small menu (OPTS keeps the choices for the click) */
  const OPTS = {};
  const sel = (key, opts) => { OPTS[key] = opts; const cur = opts.find(([v]) => ST.prefs && String(ST.prefs[key]) === v) || opts[0]; return `<button class="input dsel" data-ps="${key}"><span class="grow ellip">${esc(cur[1])}</span>${I('chev', 'sm')}</button>`; };
  const inp = (key, kind, attrs, w, unit) => `<span class="sinp"><span class="input" style="width:${w}"><input data-pi="${key}" data-kind="${kind}" value="${esc(ST.prefs ? ST.prefs[key] : '')}" ${attrs}></span>${unit ? `<span class="faint">${unit}</span>` : ''}</span>`;
  const err = (k) => (ST.err[k] ? `<div class="serr" role="alert">${I('warn', 'sm')}${esc(ST.err[k])}</div>` : '');
  const card = (cls, title, body, k) => `<div class="card ${cls}"><h3>${title}<span class="grow"></span>${k && ST.saved[k] ? `<span class="faint">${esc(ST.saved[k])}</span>` : ''}</h3><div class="form" style="padding:0;max-width:none">${body}</div>${k ? err(k) : ''}</div>`;

  const EFFORT = [['max', 'Max'], ['xhigh', 'Extra high'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['default', 'Model default']];
  const MODE = [['auto', 'Auto'], ['default', 'Ask first'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan']];
  /* the sample every theme card shows (the same as on the old Settings page) */
  const SAMPLE = '# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6\n\nA paragraph with **bold**, *italic*, a [link](https://example.com) and `inline code`.\n\n- First item\n- Second item\n\n```js\nconst answer = 42;\n```\n\n> A quote from the notes.';
  let sampleHtml = null;
  const SAMPLE_HTML = () => sampleHtml || (sampleHtml = MC.md(SAMPLE));
  const PHRASES = [['sendPhrase', 'Send'], ['cancelPhrase', 'Cancel'], ['rewritePhrase', 'Start over'], ['endPhrase', 'End conversation']];

  function paint() {
    if (!el) return;
    const p = ST.prefs;
    if (!p) { el.innerHTML = `<div class="card"><div class="${ST.err.page ? 'lv-err' : 'faint'}">${ST.err.page ? 'Could not read the settings: ' + esc(ST.err.page) : 'Reading the settings'}</div></div>`; return; }
    const md = MC.mdStyle;
    const look = row('Theme', seg('*theme', [['slate', 'Slate'], ['redline', 'Redline'], ['midnight', 'Midnight']], S.theme))
      + row('Text size', seg('*size', [['S', 'S'], ['M', 'M'], ['L', 'L']], S.size))
      + row('Work mode', `<span class="tog ${S.work ? 'on' : ''}" data-local="work" role="switch" tabindex="0"></span>`);
    const reading = md ? row('Text size in answers', seg('*mdsize', md.sizes.map((s) => [s.id, s.name]), md.size)) : '';
    const cards = md ? `<div class="mdgrid">${md.themes.map((t) => `<div class="mdcard md-prev ${t.id === md.theme ? 'on' : ''}" data-mdtheme="${t.id}" data-md-theme="${t.id}" role="radio" tabindex="0" aria-checked="${t.id === md.theme}"><div class="nm"><b>${esc(t.name)}</b>${t.id === md.theme ? `<span class="pick">${I('check', 'sm')}Selected</span>` : ''}</div><div class="md">${SAMPLE_HTML()}</div></div>`).join('')}</div>` : '';
    const brain = row('Name', inp('comlinkName', 'text', 'maxlength="24"', 'calc(220px*var(--k))'))
      + row('Face', seg('comlinkLook', [['hal', 'HAL eye'], ['clawd', 'Clawd']], p.comlinkLook))
      + row('Model', sel('comlinkModel', [['', 'Newest Haiku']].concat(ST.models.map((m) => [m.id, m.label || m.id]))))
      + row('Effort', sel('comlinkEffort', EFFORT)) + row('Permissions', sel('comlinkMode', MODE)) + row('Personality', tog('comlinkPersona'));
    const listen = row('Listen again after an answer', tog('autoListen'))
      + row('Stop listening after silence', inp('listenSilenceSec', 'num', 'type="number" min="5" max="600" step="1"', 'calc(100px*var(--k))', 's'))
      + row('Hide the panel after', inp('hidePanelSec', 'num', 'type="number" min="0" max="3600" step="1"', 'calc(100px*var(--k))', 's (0: never)'));
    const mem = ST.memory;
    const memory = mem ? `<div class="input smemw"><textarea class="smem" data-mem spellcheck="false">${esc(mem.text || '')}</textarea></div>${mem.over ? `<div class="serr">${I('warn', 'sm')}Over ${Math.round((mem.warnAt || 100000) / 1000)}k characters</div>` : ''}<div class="row" style="margin-top:calc(10px*var(--k));gap:calc(10px*var(--k))"><button class="btn sm primary" data-memsave>Save memory</button><span class="faint">${esc(ST.saved.mem || '')}</span></div>` : '<div class="faint">Not available</div>';
    const talk = row('Read replies aloud', tog('readAloud')) + row('Clean up dictation', tog('cleanup'));
    const claude = row('Show on claude.ai', tog('remoteControl'));
    const spoken = PHRASES.map(([k, l]) => row(l, inp(k, 'text', 'maxlength="250" spellcheck="false"', 'calc(320px*var(--k))'))).join('');
    const W = ST.wake;
    const wake = !W ? '<div class="faint">Not available</div>' : `<div class="row" style="gap:calc(10px*var(--k));margin-bottom:calc(6px*var(--k))">${MC.st(W.linked ? 'done' : 'idle', W.linked ? 'BlitzVoice linked' : 'BlitzVoice not running')}</div>`
      + ((W.models || []).map((m) => `<div class="fr"><div class="fl2"><b>${esc(m.phrase || m.id)}</b><span>${m.bundled ? 'Built in' : m.trained ? 'Trained here' + (m.clips ? `, ${m.clips} clips` : '') : 'Added by hand'}</span></div>${MC.st(m.selected ? 'run' : m.installed ? 'done' : 'idle', m.selected ? 'In use' : m.installed ? (m.stale ? 'Installed, update ready' : 'Installed') : 'Not installed')}${m.trained && (!m.installed || m.stale) && W.canInstall !== false ? `<button class="btn sm" data-wk="install" data-id="${esc(m.id)}">${m.installed ? 'Install update' : 'Install'}</button>` : ''}${m.installed && !m.selected ? `<button class="btn sm" data-wk="use" data-id="${esc(m.id)}" ${W.linked ? '' : 'disabled'}>Use</button>` : ''}</div>`).join('') || '<div class="faint">No wake words yet</div>');
    const roots = (LV.roots || []).map((r) => { const n = LV.projects.filter((q) => (q.folder || '').toLowerCase().startsWith(r.folder.toLowerCase() + '\\')).length; return `<div class="fr"><div class="fl2"><b class="mono">${esc(r.folder)}</b></div><span class="faint">${n} project${n === 1 ? '' : 's'}</span><button class="btn sm ghost" data-reveal="${esc(r.folder)}">${I('folder', 'sm')}Open</button></div>`; }).join('');
    const arch = ST.archived == null ? '<div class="faint">Not available</div>' : ST.archived.map((q) => `<div class="fr"><div class="fl2"><b>${esc(q.name)}</b></div><span class="faint mono">${esc(q.folder || '')}</span><button class="btn sm" data-unhide="${esc(q.id)}">Bring back</button></div>`).join('') || '<div class="faint">None</div>';
    /* a repaint keeps the caret in a wake word field */
    const f = document.activeElement, fk = f && el.contains(f) && f.dataset.wtIn, fsel = fk ? [f.selectionStart, f.selectionEnd] : null;
    el.innerHTML = card('', 'Look', look) + `<div class="sgroup">Reading</div>` + card('', 'Answers', reading + cards)
      + `<div class="sgroup">Com Link</div>` + card('c6', 'Brain', brain, 'brain') + card('c6', 'Listening', listen, 'listen') + card('', 'Memory', memory, 'mem')
      + `<div class="sgroup">Claude</div>` + card('c6', 'Talk page', talk, 'talk') + card('c6', 'Claude', claude, 'claude')
      + `<div class="sgroup">Voice</div>` + card('c6', 'Spoken commands', spoken, 'spoken') + card('c6', 'Wake words', wake, 'wake')
      + (isRemote() ? '' : card('wkt', 'Train a wake word', wkBody()))
      + `<div class="sgroup">Folders</div>` + card('c6', 'Root folders', roots || '<div class="faint">None</div>') + card('c6', 'Archived projects', arch, 'arch');
    wkDraw();
    if (fk) { const n = el.querySelector(`[data-wt-in="${fk}"]`); if (n && !n.disabled) { n.focus(); try { n.setSelectionRange(fsel[0], fsel[1]); } catch (e) { /* not a text field */ } } }
  }

  /* ---------- Wake words: train a model from your own voice (ported from settings.html). A phone may not record clips. ---------- */
  const isRemote = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  const WK = {
    presets: { quick: 15, standard: 45, thorough: 120 }, stages: ['generate', 'augment', 'features', 'train', 'export', 'verify'], target: 30, maxNeg: 12,
    train: null,      // the server's training state (also pushed as 'waketrain' events)
    clips: [],        // clips of the phrase in the box
    raw: '', phrase: '', slug: '', negRaw: '', preset: 'standard',
    neg: [],          // near misses of the phrase in the box
    rec: null,        // { level, t0, stop } while recording
    busy: false,      // a request from a button is running
    playing: null,    // { name, audio }
    note: '', ask: null, ready: false, seq: 0,
  };
  const WK_STAGE = { generate: 'Generate voices', augment: 'Add noise and rooms', features: 'Extract features', train: 'Train', export: 'Export', verify: 'Verify' };
  const WK_REC_SECONDS = 2;
  /* the capture processor: hands each block of microphone samples to the page */
  const WK_WORKLET = 'class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("wk-cap",C)';
  const wkEst = (min) => (min >= 60 && min % 60 === 0 ? min / 60 + 'h' : min + ' min');
  const wkTime = (sec) => { sec = Math.max(0, Math.round(sec)); if (sec < 60) return sec + 's'; const m = Math.floor(sec / 60), r = sec % 60; return m + ' min' + (r ? ' ' + r + 's' : ''); };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  /* the same rules as the server: letters, spaces and apostrophes, 2 to 40 characters */
  function wkClean(v) {
    const s = String(v == null ? '' : v).replace(/[‘’]/g, "'").replace(/ +/g, ' ').replace(/^ | $/g, '').toLowerCase();
    return s.length < 2 || s.length > 40 || !/^[a-z' ]+$/.test(s) || (s.match(/[a-z]/g) || []).length < 2 ? null : s;
  }
  const wkSlug = (p) => String(p).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const wkDefaults = (phrase) => { const rest = phrase.replace(/^(hey|hi|ok|okay|hello) +/, ''); return rest !== phrase && wkClean(rest) ? [rest] : []; };
  /* near misses are kept per phrase in this browser, under the same keys as the old page */
  function wkStore(slug, list) {
    try {
      if (list === undefined) { const j = localStorage.getItem('mc-wake-neg:' + slug); return j ? JSON.parse(j) : null; }
      localStorage.setItem('mc-wake-neg:' + slug, JSON.stringify(list));
    } catch (e) { /* storage may be blocked */ }
    return null;
  }
  const wkRunning = () => !!(WK.train && WK.train.running);
  const wkLocked = () => wkRunning() && !!WK.slug && WK.train.slug === WK.slug;
  const wkErr = (e) => (e && e.data && (e.data.message || e.data.error)) || errText(e);
  const wkSay = (text) => { WK.note = text; wkDraw(); };

  /* the answer of GET /api/waketrain; the first one also fills the phrase box */
  function wkOverview(r) {
    WK.presets = r.presets || WK.presets; WK.stages = r.stages || WK.stages; WK.target = r.clipTarget || WK.target; WK.maxNeg = r.maxNegatives || WK.maxNeg;
    WK.train = r.state || null;
    if (WK.ready) return;
    WK.ready = true;
    let first = ''; try { first = localStorage.getItem('mc-wake-phrase') || ''; } catch (e) { /* ignore */ }
    const t = WK.train;
    if (t && t.phrase) first = t.phrase;
    if (t && t.preset && WK.presets[t.preset]) WK.preset = t.preset;
    wkPhrase(first);
    if (t && t.negatives && t.negatives.length && t.slug === WK.slug && !wkStore(WK.slug)) WK.neg = t.negatives.slice();
  }
  async function wkReload() {
    const got = await Promise.allSettled([api.get('/api/waketrain'), api.get('/api/waketrain/models')]);
    if (got[0].status === 'fulfilled') wkOverview(got[0].value);
    if (got[1].status === 'fulfilled') ST.wake = got[1].value;
    paint();
  }

  /* the parts of the card that change while it is open: each is drawn again without touching the text fields */
  const WKP = {
    preset: () => { const k = wkRunning() && WK.presets[WK.train.preset] ? WK.train.preset : WK.preset; return `<button class="input dsel wk-size" data-wt="preset" ${wkRunning() ? 'disabled' : ''}><span class="grow ellip">${cap(k)}, about ${wkEst(WK.presets[k] || 0)}</span>${I('chev', 'sm')}</button>`; },
    go: () => (wkRunning() ? `<button class="btn" data-wt="stop">${I('stop', 'sm')}Stop</button>` : `<button class="btn primary" data-wt="start" ${WK.phrase && !WK.busy ? '' : 'disabled'}>Train</button>`),
    bad: () => (WK.raw.trim() && !WK.phrase ? `<div class="serr" role="alert">${I('warn', 'sm')}Use 2 to 40 characters: letters, spaces and apostrophes.</div>` : ''),
    note: () => (WK.note ? `<div class="serr" role="alert">${I('warn', 'sm')}${esc(WK.note)}</div>` : ''),
    chips: () => (WK.neg.length ? WK.neg.map((n, i) => `<span class="wk-chip">${esc(n)}<button class="ibtn sm" data-wt="negdel" data-i="${i}" aria-label="Remove ${esc(n)}">${I('x', 'sm')}</button></span>`).join('') : '<span class="faint">None yet</span>'),
    count: () => { const n = WK.clips.length; return WK.slug ? MC.st(n >= WK.target ? 'done' : 'idle', n >= WK.target ? `${n} clips` : `${n} of ${WK.target}`) : ''; },
    rec: () => { const r = !!WK.rec, lock = wkLocked(); return `<button class="btn ${r ? '' : 'primary'}" data-wt="rec" ${!WK.slug || lock || (WK.busy && !r) ? 'disabled' : ''} ${lock ? 'title="Training is using these clips"' : ''}>${I(r ? 'stop' : 'mic', 'sm')}${r ? 'Stop' : 'Record'}</button>`; },
    clips: () => {
      if (!WK.slug) return '';
      if (!WK.clips.length) return '<div class="faint wk-none">No recordings yet. Say the phrase when you press Record.</div>';
      const lock = wkLocked();
      return WK.clips.map((c) => {
        const num = c.name.replace(/^clip-|\.wav$/g, ''), on = WK.playing && WK.playing.name === c.name;
        return `<div class="wk-clip ${on ? 'on' : ''}"><b class="mono">${esc(num.padStart(2, '0'))}</b><button class="ibtn sm" data-wt="play" data-name="${esc(c.name)}" aria-label="${on ? 'Stop' : 'Play'} clip ${esc(num)}">${I(on ? 'stop' : 'play', 'sm')}</button><button class="ibtn sm" data-wt="clipdel" data-name="${esc(c.name)}" aria-label="Delete clip ${esc(num)}" ${lock ? 'disabled' : ''}>${I('x', 'sm')}</button></div>`;
      }).join('');
    },
    run: () => {
      const t = WK.train; if (!t || !t.phase || t.phase === 'idle') return '';
      const chip = t.phase === 'running' ? MC.st('run', 'Training') : t.phase === 'done' ? MC.st('done', 'Done') : t.phase === 'stopped' ? MC.st('warn', 'Stopped') : t.phase === 'interrupted' ? MC.st('warn', 'Interrupted') : MC.st('fail', 'Failed');
      const rows = WK.stages.map((s) => {
        const pct = t.stages && t.stages[s] != null ? t.stages[s] : null, done = pct === 100 || t.phase === 'done', on = t.running && t.stage === s && !done;
        const w = done ? 100 : pct || 0, name = WK_STAGE[s] || cap(s);
        return `<span class="nm ${on ? 'on' : ''}">${esc(name)}</span><span class="ic">${I(done ? 'tick' : on ? 'loader' : 'circle', 'sm')}</span><div class="bar ${done ? 'ok' : ''}" role="progressbar" aria-label="${esc(name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}"><i style="width:${w}%"></i></div><span class="pc mono">${done ? 'Done' : pct != null ? pct + '%' : 'Waiting'}</span>`;
      }).join('');
      let tail = '';
      if (t.phase === 'running') tail = t.msg ? `<div class="wk-msg">${esc(t.msg)}</div>` : '';
      else if (t.phase === 'done') {
        const m = ST.wake && (ST.wake.models || []).find((x) => x.id === t.slug), inst = m && m.installed && !m.stale;
        tail = `<div class="wk-res"><span>Trained "${esc(t.phrase)}" in ${esc(wkTime(t.seconds != null ? t.seconds : t.elapsed))}.</span><code>${esc(t.out || '')}</code>${inst || (ST.wake && ST.wake.canInstall === false) ? '' : `<button class="btn sm primary" data-wk="install" data-id="${esc(t.slug)}">${m && m.stale ? 'Install update' : 'Install'}</button>`}</div>`;
      } else if (t.phase === 'error') tail = `<div class="wk-res"><span>${esc(t.error || 'The training failed.')}</span>${t.log ? `<code>${esc(t.log)}</code>` : ''}</div>`;
      else if (t.phase === 'interrupted') tail = `<div class="wk-res"><span>${esc(t.error || 'This training was interrupted.')} Nothing was installed.</span></div>`;
      else if (t.phase === 'stopped') tail = '<div class="wk-res"><span>Training was stopped. Nothing was installed.</span></div>';
      return `<div class="wk-rt">${chip}<b>${esc(t.phrase || '')}</b><span class="faint mono">${esc(cap(t.preset || ''))}</span><span class="faint mono" data-wk-el>${wkElapsed()}</span></div><div class="wk-st">${rows}</div>${tail}`;
    },
  };
  function wkBody() {
    const P = (n, cls = '') => `<div class="${cls}" data-wkp="${n}"></div>`;
    return `<div class="wk-form"><label class="wk-f"><span class="wk-lb">Phrase</span><span class="input wk-phrase"><input data-wt-in="phrase" maxlength="40" placeholder="hey mission control" autocomplete="off" spellcheck="false" value="${esc(WK.raw)}"></span></label>`
      + `<div class="wk-f"><span class="wk-lb">Size</span>${P('preset')}</div>${P('go', 'wk-go')}</div>${P('bad')}${P('note')}`
      + `<div class="wk-cols"><div class="wk-col"><div class="wk-hd"><b>Near misses</b></div>${P('chips', 'wk-chips')}`
      + `<div class="wk-add"><span class="input"><input data-wt-in="neg" maxlength="40" placeholder="Add a sound-alike" aria-label="Add a near miss" autocomplete="off" spellcheck="false" value="${esc(WK.negRaw)}"></span><button class="btn sm" data-wt="negadd">Add</button></div></div>`
      + `<div class="wk-col"><div class="wk-hd"><b>Your voice</b><span class="grow"></span><span data-wkp="count"></span></div>`
      + `<div class="wk-rec"><span data-wkp="rec"></span><div class="bar wk-meter" aria-hidden="true"><i data-wk-meter></i></div><span class="wk-t mono" data-wk-t role="status"></span></div>${P('clips', 'wk-clips')}</div></div>`
      + P('run', 'wk-run');
  }
  function wkDraw() {
    if (!el) return;
    el.querySelectorAll('[data-wkp]').forEach((h) => { const v = WKP[h.dataset.wkp](); if (h._v !== v) { h._v = v; h.innerHTML = v; } });
    const ph = el.querySelector('[data-wt-in="phrase"]'), ng = el.querySelector('[data-wt-in="neg"]'), add = el.querySelector('[data-wt="negadd"]');
    if (ph) { ph.disabled = wkRunning(); if (WK.raw.trim() && !WK.phrase) ph.setAttribute('aria-invalid', 'true'); else ph.removeAttribute('aria-invalid'); }
    if (ng) ng.disabled = !WK.slug;
    if (add) add.disabled = !WK.slug || WK.neg.length >= WK.maxNeg;
  }
  function wkElapsed() { const t = WK.train; if (!t) return ''; const end = t.running ? Date.now() : t.finishedAt; return t.startedAt && end ? wkTime((end - t.startedAt) / 1000) : ''; }

  /* ----- the phrase and its near misses ----- */
  function wkPhrase(raw) {
    WK.raw = raw;
    const phrase = wkClean(raw), slug = phrase ? wkSlug(phrase) : '';
    if (slug !== WK.slug) {
      WK.slug = slug; WK.phrase = phrase || '';
      WK.neg = slug ? (wkStore(slug) || wkDefaults(phrase)) : [];
      WK.clips = [];
      if (slug) { try { localStorage.setItem('mc-wake-phrase', phrase); } catch (e) { /* ignore */ } }
      wkLoadClips();
    } else WK.phrase = phrase || '';
    wkDraw();
  }
  function wkNegAdd() {
    if (!WK.negRaw.trim()) return;
    const n = wkClean(WK.negRaw);
    if (!n) { wkSay('A near miss is 2 to 40 characters: letters, spaces and apostrophes.'); return; }
    if (n === WK.phrase) { wkSay('That is the wake phrase itself.'); return; }
    if (WK.neg.length >= WK.maxNeg) { wkSay(WK.maxNeg + ' is the most near misses.'); return; }
    if (!WK.neg.includes(n)) WK.neg.push(n);
    wkStore(WK.slug, WK.neg);
    WK.negRaw = ''; WK.note = '';
    const i = el.querySelector('[data-wt-in="neg"]'); if (i) i.value = '';
    wkDraw();
  }

  /* ----- clips: record, list, play, delete ----- */
  async function wkLoadClips() {
    const slug = WK.slug, mine = ++WK.seq;
    if (!slug) { WK.clips = []; wkDraw(); return; }
    try { const r = await api.get('/api/waketrain/clips/' + enc(slug)); if (mine !== WK.seq || slug !== WK.slug) return; WK.clips = r.clips || []; }
    catch (e) { if (mine !== WK.seq) return; WK.clips = []; }
    wkDraw();
  }
  function wkPlay(name) {
    if (WK.playing) {
      const old = WK.playing; WK.playing = null;
      try { old.audio.pause(); } catch (e) { /* ignore */ }
      if (old.name === name) { wkDraw(); return; }
    }
    const audio = new Audio('/api/waketrain/clips/' + enc(WK.slug) + '/' + enc(name)), me = WK.playing = { name, audio };
    const done = () => { if (WK.playing === me) { WK.playing = null; wkDraw(); } };
    audio.addEventListener('ended', done); audio.addEventListener('error', done);
    audio.play().catch(done);
    wkDraw();
  }
  async function wkDelClip(name) {
    try { const r = await api.post('/api/waketrain/clips/' + enc(WK.slug) + '/' + enc(name) + '/delete', {}); WK.clips = r.clips || []; }
    catch (e) { wkSay('Could not delete the clip: ' + wkErr(e)); return; }
    wkDraw();
  }
  /* the browser's own resampler first; plain averaging if it is not there */
  async function wkTo16k(samples, rate) {
    if (rate === 16000) return samples;
    try {
      const n = Math.max(1, Math.round(samples.length * 16000 / rate)), off = new OfflineAudioContext(1, n, 16000), b = off.createBuffer(1, samples.length, rate);
      b.copyToChannel(samples, 0);
      const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
      return (await off.startRendering()).getChannelData(0);
    } catch (e) {
      const ratio = rate / 16000, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
      for (let i = 0; i < n; i++) { const a = Math.floor(i * ratio), z = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < z; k++) s += samples[k]; out[i] = s / (z - a); }
      return out;
    }
  }
  /* two seconds of the raw microphone (no echo cancelling, noise suppression or gain), the way the model will hear it */
  async function wkRecord() {
    if (WK.rec) { WK.rec.stop(); return; }
    if (!WK.slug || wkLocked() || WK.busy) return;
    const slug = WK.slug; let stream, ctx;
    WK.note = '';
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { wkSay('The microphone is blocked or missing. Allow it for this page and try again.'); return; }
    try {
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WK_WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'wk-cap', { numberOfOutputs: 0 }), chunks = [], need = Math.round(WK_REC_SECONDS * ctx.sampleRate);
      let total = 0;
      const rec = WK.rec = { level: 0, t0: performance.now(), stopped: false, stop: () => finish() };
      node.port.onmessage = (e) => {
        const d = e.data; chunks.push(d); total += d.length;
        let peak = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
        rec.level = Math.max(peak, rec.level * 0.8);
        if (total >= need) finish();
      };
      ctx.createMediaStreamSource(stream).connect(node);
      // A microphone that never delivers audio must not leave the button stuck on Stop.
      setTimeout(() => finish(), (WK_REC_SECONDS + 2) * 1000);
      wkDraw(); wkMeter();
      async function finish() {
        if (rec.stopped) return;
        rec.stopped = true;
        const rate = ctx.sampleRate;
        stream.getTracks().forEach((t) => t.stop());
        try { await ctx.close(); } catch (e) { /* ignore */ }
        WK.rec = null; WK.busy = true; wkDraw();
        try {
          const all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
          const mono = await wkTo16k(all.subarray(0, Math.min(all.length, need)), rate);
          let peak = 0; for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
          if (mono.length < 16000 * 0.3) WK.note = 'That recording was too short.';
          else if (peak < 0.005) WK.note = 'Nothing was heard. Check the microphone.';
          else {
            const res = await fetch('/api/waketrain/clips/' + enc(slug), { method: 'POST', headers: { 'X-MC': '1', 'Content-Type': 'audio/wav' }, body: MC.audio.wav(mono) });
            let j = null; try { j = await res.json(); } catch (e) { /* no body */ }
            if (!res.ok) throw new Error((j && (j.message || j.error)) || 'HTTP ' + res.status);
            if (slug === WK.slug) WK.clips = j.clips || [];
          }
        } catch (e) { WK.note = 'Could not save the clip: ' + e.message; }
        WK.busy = false; wkDraw();
      }
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      try { if (ctx) await ctx.close(); } catch (e2) { /* ignore */ }
      WK.rec = null; wkSay('Recording does not work in this browser.');
    }
  }
  function wkMeter() {
    const step = () => {
      const m = el && el.querySelector('[data-wk-meter]'), t = el && el.querySelector('[data-wk-t]');
      if (!WK.rec) { if (m) m.style.width = '0'; if (t) t.textContent = ''; return; }
      const s = Math.min(WK_REC_SECONDS, (performance.now() - WK.rec.t0) / 1000);
      if (m) m.style.width = Math.min(100, Math.round(Math.sqrt(WK.rec.level) * 100)) + '%';
      if (t) t.textContent = `Recording ${s.toFixed(1)}s of ${WK_REC_SECONDS}s`;
      requestAnimationFrame(step);
    };
    step();
  }

  /* ----- training: start, stop (asked first), install the result ----- */
  async function wkStart() {
    if (!WK.phrase) return;
    WK.busy = true; WK.note = ''; wkDraw();
    try { WK.train = await api.post('/api/waketrain/start', { phrase: WK.phrase, preset: WK.preset, negatives: WK.neg }); }
    catch (e) { WK.note = e.data && e.data.error === 'busy' ? 'A training is already running.' : 'Could not start: ' + wkErr(e); }
    WK.busy = false; wkDraw();
  }
  function wkAskStop() {
    const d = WK.ask = document.createElement('div'); d.className = 'mdlg';
    d.innerHTML = `<div class="mbox" role="dialog" aria-modal="true"><div class="mt2">Stop training?</div><div class="mb2">The work so far is lost.</div><div class="row" style="gap:calc(8px*var(--k))"><span class="grow"></span><button class="btn sm ghost" data-x>Keep going</button><button class="btn sm wk-danger" data-ok>${I('stop', 'sm')}Stop</button></div></div>`;
    document.body.appendChild(d);
    const end = () => { d.remove(); if (WK.ask === d) WK.ask = null; };
    d.onkeydown = (e) => { if (e.key === 'Escape') end(); };
    d.onclick = async (e) => {
      if (e.target === d || e.target.closest('[data-x]')) return end();
      if (!e.target.closest('[data-ok]')) return;
      end();
      try { WK.train = await api.post('/api/waketrain/stop', {}); } catch (er) { if (er.status !== 409) wkSay('Could not stop: ' + wkErr(er)); }
      wkDraw();
    };
    d.querySelector('[data-x]').focus();
  }
  async function wkClick(b) {
    const a = b.dataset.wt;
    if (a === 'preset') MC.menu(b, ['quick', 'standard', 'thorough'].map((k) => ({ id: k, label: `${cap(k)}, about ${wkEst(WK.presets[k] || 0)}`, on: k === WK.preset })), (v) => { WK.preset = v; wkDraw(); });
    else if (a === 'start') wkStart();
    else if (a === 'stop') wkAskStop();
    else if (a === 'negadd') wkNegAdd();
    else if (a === 'negdel') { WK.neg.splice(Number(b.dataset.i), 1); wkStore(WK.slug, WK.neg); wkDraw(); }
    else if (a === 'rec') wkRecord();
    else if (a === 'play') wkPlay(b.dataset.name);
    else if (a === 'clipdel') wkDelClip(b.dataset.name);
  }
  MC.events.on('waketrain', (ev) => {
    WK.train = ev;
    if (!ev.running && WK.ask) { WK.ask.remove(); WK.ask = null; }
    if (!el || !el.isConnected) return;
    wkDraw();
    if (ev.kind === 'done' || ev.kind === 'error' || ev.kind === 'stopped' || ev.kind === 'started') api.get('/api/waketrain/models').then((m) => { ST.wake = m; paint(); }).catch(() => {});
  });
  let wkVoiceT = 0;
  MC.events.on('voice', (d) => {
    if (!d || (d.kind !== 'wake_state' && d.kind !== 'status') || !el || !el.isConnected) return;
    clearTimeout(wkVoiceT); wkVoiceT = setTimeout(() => api.get('/api/waketrain/models').then((m) => { ST.wake = m; paint(); }).catch(() => {}), 400);
  });
  setInterval(() => { const e = el && el.querySelector('[data-wk-el]'); if (e) e.textContent = wkElapsed(); }, 1000);
  /* the models and the BlitzVoice link stay fresh while the page shows; a repaint only when something changed */
  setInterval(() => {
    if (document.hidden || !el || !el.offsetParent || wkRunning() || WK.rec) return;
    api.get('/api/waketrain/models').then((m) => { if (JSON.stringify(m) !== JSON.stringify(ST.wake)) { ST.wake = m; paint(); } }).catch(() => {});
  }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el && el.offsetParent) wkReload(); });

  /* ---------- saving ---------- */
  const groupOf = (key) => (/^comlink(Name|Look|Model|Effort|Mode|Persona)$/.test(key) ? 'brain' : /^(autoListen|listenSilenceSec|hidePanelSec)$/.test(key) ? 'listen' : /Phrase$/.test(key) ? 'spoken' : /^(readAloud|cleanup)$/.test(key) ? 'talk' : 'claude');
  async function save(key, value) {
    const g = groupOf(key), before = ST.prefs[key];
    ST.prefs[key] = value; delete ST.err[g];
    try { ST.prefs = await api.put('/api/voice/prefs', { [key]: value }); ST.saved[g] = 'Saved'; setTimeout(() => { delete ST.saved[g]; paint(); }, 1500); }
    catch (e) { ST.prefs[key] = before; ST.err[g] = errText(e); }
    paint();
  }
  function bind() {
    el.onclick = async (e) => {
      const wt = e.target.closest('[data-wt]'); if (wt) { if (!wt.disabled) wkClick(wt); return; }
      const t = e.target.closest('[data-pt]'); if (t) { save(t.dataset.pt, !ST.prefs[t.dataset.pt]); return; }
      const ds = e.target.closest('[data-ps]'); if (ds) { const k = ds.dataset.ps, opts = OPTS[k] || []; MC.menu(ds, opts.map(([v, l]) => ({ id: v, label: l, on: String(ST.prefs[k]) === v })), (v) => save(k, v), { alignRight: true }); return; }
      const mc = e.target.closest('[data-mdtheme]'); if (mc) { MC.mdStyle.setTheme(mc.dataset.mdtheme); paint(); return; }
      const lt = e.target.closest('[data-local="work"]'); if (lt) { MC.setWork(!S.work); paint(); return; }
      const sb = e.target.closest('.seg[data-sk] button'); if (sb) {
        const k = sb.parentNode.dataset.sk, v = sb.dataset.v;
        if (k === '*theme') MC.setTheme(v); else if (k === '*size') MC.setSize(v); else if (k === '*mdsize') MC.mdStyle.setSize(v); else { save(k, v); return; }
        paint(); return;
      }
      if (e.target.closest('[data-memsave]')) {
        const text = el.querySelector('[data-mem]').value; delete ST.err.mem;
        try { ST.memory = await api.put('/api/voice/memory', { text }); ST.saved.mem = 'Saved'; setTimeout(() => { delete ST.saved.mem; paint(); }, 1500); } catch (er) { ST.err.mem = errText(er); }
        paint(); return;
      }
      const wk = e.target.closest('[data-wk]'); if (wk) {
        wk.disabled = true; delete ST.err.wake;
        try {
          const m = ST.wake && (ST.wake.models || []).find((x) => x.id === wk.dataset.id);
          if (wk.dataset.wk === 'use') { await api.post('/api/voice/wake', { model: wk.dataset.id }); MC.toast(`BlitzVoice now uses "${(m && m.phrase) || wk.dataset.id}"`); }
          else { const r = await api.post('/api/waketrain/install', { model: wk.dataset.id }); if (r.selected) MC.toast(`Installed, and BlitzVoice now uses "${r.phrase || (m && m.phrase) || wk.dataset.id}"`); else ST.err.wake = r.reason === 'not_linked' ? 'Installed. Press Use once BlitzVoice runs.' : 'Installed, but BlitzVoice did not switch to it. Press Use.'; }
        } catch (er) { ST.err.wake = errText(er); }
        try { ST.wake = await api.get('/api/waketrain/models'); } catch (er) { /* keep the old list */ }
        paint(); return;
      }
      const un = e.target.closest('[data-unhide]'); if (un) {
        un.disabled = true; delete ST.err.arch;
        try { await api.put(`/api/projects/${enc(un.dataset.unhide)}/settings`, { hidden: false }); ST.archived = ST.archived.filter((q) => q.id !== un.dataset.unhide); } catch (er) { ST.err.arch = errText(er); }
        paint(); return;
      }
      const rv = e.target.closest('[data-reveal]'); if (rv) { api.post('/api/path/reveal', { path: rv.dataset.reveal }).catch((er) => MC.toast('Could not open it: ' + errText(er), 'warn')); }
    };
    el.onchange = (e) => {
      const i = e.target.closest('[data-pi]'); if (i) {
        const k = i.dataset.pi, raw = i.value.trim();
        if (i.dataset.kind === 'num') { const n = Number(raw); if (!Number.isInteger(n)) { ST.err[groupOf(k)] = 'A whole number, please'; paint(); return; } save(k, n); } else save(k, raw);
      }
    };
    el.oninput = (e) => {
      const w = e.target.closest('[data-wt-in]'); if (!w) return;
      if (w.dataset.wtIn === 'phrase') wkPhrase(w.value); else WK.negRaw = w.value;
    };
    el.onkeydown = (e) => {
      const w = e.target.closest('[data-wt-in]'); if (w && e.key === 'Enter') {
        e.preventDefault();
        if (w.dataset.wtIn === 'neg') wkNegAdd(); else { const s = el.querySelector('[data-wt="start"]'); if (s && !s.disabled) wkStart(); }
        return;
      }
      const mc = e.target.closest('[data-mdtheme]'); if (mc && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); mc.click(); return; }
      const i = e.target.closest('[data-pi]'); if (!i) return;
      if (e.key === 'Enter') i.blur();
      if (e.key === 'Escape') { i.value = ST.prefs[i.dataset.pi]; i.blur(); }
      const t = e.target.closest('[data-pt]'); if (t && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); t.click(); }
    };
  }

  MC.events.on('voice', (d) => { if (d && d.kind === 'prefs' && el && el.isConnected) api.get('/api/voice/prefs').then((p) => { ST.prefs = p; if (!el.contains(document.activeElement)) paint(); }).catch(() => {}); });
  MC.events.on('projects.changed', () => { if (el && el.isConnected && el.offsetParent) loadAll(); });

  /* the page shell calls this each time Settings is shown */
  MC.drawSettings = (target) => { el = target; if (MC.mdStyle && !el._fonts) { el._fonts = true; MC.mdStyle.loadAllFonts(); } if (!el._bound) { bind(); el._bound = true; } paint(); loadAll(); };
})();
