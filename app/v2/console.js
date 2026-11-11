/* Mission Control 2: the Console module on real data, and "Paste in the console" on the command blocks of a conversation.
   Terminal: a shell on the PC per console panel (PowerShell on Windows, zsh on a Mac: the server picks it, routes/console.js).
   Server log: what the server printed in its window. Dev server: the output of the project's jobs (its dev server and other
   scripts). The PC only: a phone, a linked computer and the hub get a note instead (the server refuses them too).
   Load order: after live.js and panels.js (it replaces the sample Console module of modules.js). */
(() => {
  const { $, $$, esc, icon: I, state: S } = MC;
  const M = MC.modules, api = MC.api, enc = encodeURIComponent;
  const LV = () => MC.live || {};
  const errText = (e) => (e && ((e.data && e.data.error) || e.message)) || 'unknown error';
  const root = document.documentElement;
  const MAX_LINES = 5000, MAX_LOG_SHOWN = 1500;

  /* ---------- may the console run here ---------- */
  let ok = null; /* null: not known yet */
  (MC.whoami || Promise.resolve(null)).then((w) => {
    ok = !!w && !w.remote && w.role !== 'hub';
    root.toggleAttribute('data-console', ok);
    if (ok) api.get('/api/console').then((d) => { SHELL = d.shell; MC.emit('rerender', 'console'); }, () => {});
    MC.emit('rerender', 'console');
  });
  let SHELL = null; /* { name, kind, prompt } of this PC */

  /* ---------- state on this page ---------- */
  const C = {}; /* console id -> { lines, seq, shell, prompt, cwd, busy, alive, loading, hist, hi } */
  const LOG = { lines: [], seq: 0, loaded: false, loading: false };
  const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const con = (id) => (C[id] = C[id] || { lines: [''], seq: 0, busy: false, alive: false, cwd: '', hist: [], hi: -1 });

  /* text into a console's lines: after a \r alone, the next text writes its line again (a progress counter); \b takes one
     character back */
  function addText(c, text) {
    String(text).split('\n').forEach((p, i) => {
      if (i) { c.lines.push(''); c.cr = false; }
      let cur = c.lines[c.lines.length - 1];
      p.split('\r').forEach((seg, j) => {
        if (j) c.cr = true;
        if (!seg) return;
        if (c.cr) { cur = ''; c.cr = false; }
        cur += seg;
      });
      if (cur.includes('\b')) { let o = ''; for (const ch of cur) o = ch === '\b' ? o.slice(0, -1) : o + ch; cur = o; }
      c.lines[c.lines.length - 1] = cur;
    });
    if (c.lines.length > MAX_LINES) c.lines.splice(0, c.lines.length - MAX_LINES);
  }
  /* d.ver counts the server's state changes: an answer older than an event already seen changes nothing */
  const takeState = (c, d) => { if (d.ver != null && c.ver != null && d.ver < c.ver) return; if (d.ver != null) c.ver = d.ver; ['shell', 'kind', 'prompt', 'cwd', 'busy', 'alive'].forEach((k) => { if (d[k] !== undefined) c[k] = d[k]; }); };
  function takeSnap(id, d, full) {
    const c = con(id);
    if (full) c.lines = [''];
    if (full && d.cut) addText(c, '[older output is no longer kept]\n');
    addText(c, d.text || ''); c.seq = d.seq || c.seq; takeState(c, d); c.gone = false;
    paintCon(id);
  }
  async function catchUp(id) {
    const c = C[id]; if (!c || c.loading) return;
    c.loading = true;
    try { takeSnap(id, await api.get(`/api/console/${enc(id)}?since=${c.seq}`), false); }
    catch (e) { if (e.status === 404 && !c.gone) { c.gone = true; c.alive = false; c.busy = false; addText(c, '\n[This shell ended when Mission Control restarted. Press Enter to start a new one.]\n'); paintCon(id); } }
    finally { c.loading = false; }
  }
  async function openCon(id, cwd) {
    const c = con(id); if (c.loading || c.opened) return;
    c.loading = true; c.opened = true;
    try { takeSnap(id, await api.post(`/api/console/${enc(id)}/open`, { cwd: cwd || '' }), true); }
    catch (e) { c.opened = false; addText(c, `[Could not start the console: ${errText(e)}]\n`); paintCon(id); }
    finally { c.loading = false; }
  }

  /* one stream for every console and the server log; it opens with the first Console panel */
  let es = null;
  function stream() {
    if (es || !ok || typeof EventSource !== 'function') return;
    es = new EventSource('/api/console/stream');
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'hello') { Object.keys(C).forEach((id) => { if (C[id].opened) catchUp(id); }); if (LOG.loaded) loadLog(); return; }
      if (m.type === 'out') {
        const c = C[m.id]; if (!c || m.seq <= c.seq) return;
        if (m.seq > c.seq + 1 && c.seq) { catchUp(m.id); return; } /* missed a piece: ask for it */
        addText(c, m.text); c.seq = m.seq; paintCon(m.id, true); return;
      }
      if (m.type === 'state') { const c = C[m.id]; if (!c) return; takeState(c, m); if (m.closed) { c.alive = false; c.opened = false; } paintBar(m.id); return; }
      if (m.type === 'log') { if (!LOG.loaded || m.line.seq <= LOG.seq) return; if (m.line.seq > LOG.seq + 1) { loadLog(); return; } pushLog([m.line]); }
    };
  }

  /* ---------- drawing a terminal without redrawing the panel (the box keeps what is typed) ---------- */
  const raf = {};
  function paintCon(id, soon) {
    if (soon) { if (raf[id]) return; raf[id] = requestAnimationFrame(() => { raf[id] = 0; paintCon(id); }); return; }
    const c = C[id]; if (!c) return;
    $$(`.cons-out[data-cid="${CSS.escape(id)}"]`).forEach((pre) => {
      const end = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
      pre.textContent = c.lines.join('\n');
      if (end) pre.scrollTop = pre.scrollHeight;
    });
    paintBar(id);
  }
  const stateChip = (c) => !c.alive && c.opened ? `<span class="st st-idle">${I('circle')}Ended</span>` : c.busy ? `<span class="st st-run">${I('loader')}Running</span>` : c.alive ? `<span class="st st-done">${I('check')}Ready</span>` : `<span class="st st-idle">${I('clock')}Starting</span>`;
  function paintBar(id) {
    const c = C[id]; if (!c) return;
    $$(`.cons[data-cid="${CSS.escape(id)}"]`).forEach((el) => {
      const s = $('.cons-st', el); if (s) s.innerHTML = stateChip(c);
      if (!c.busy) c.stopAt = 0;
      const k = $('[data-k="stop"]', el); if (k) { const f = forceNext(c); k.hidden = !c.busy; k.innerHTML = I('stop', 'sm') + (f ? 'Force stop' : 'Stop'); k.title = f ? 'It did not stop: end it and what it started, now' : c.kind === 'powershell' ? 'End the running command and the programs it started. The shell stays' : 'Interrupt the running command. The shell stays'; }
      const w = $('.cons-where', el); if (w) { w.textContent = `${c.shell || (SHELL && SHELL.name) || 'Shell'} · ${c.cwd || ''}`; w.title = c.cwd || ''; }
      const p = $('.cons-ps', el); if (p) p.textContent = c.busy ? '>' : (c.prompt || (SHELL && SHELL.prompt) || '>');
      const i = $('.cons-in', el); if (i) i.placeholder = c.busy ? 'Input for the running command, or wait for it to end' : 'Type a command, Enter runs it (Shift Enter for a new line)';
    });
  }

  /* Stop: what Ctrl+C does in a terminal, as a button only (Ctrl+C stays copy here, on purpose). A second press 2 s later, when it still runs, forces it (a Mac; Windows always ends
     the command's programs). The shell, its folder and its variables stay. */
  const forceNext = (c) => c.busy && c.stopAt && Date.now() - c.stopAt > 2000 && c.kind !== 'powershell';
  async function stopCmd(id) {
    const c = C[id]; if (!c || !c.busy) return;
    const force = forceNext(c);
    c.stopAt = Date.now(); paintBar(id);
    try {
      const d = await api.post(`/api/console/${enc(id)}/stop`, { force });
      if (d.inShell) { addText(c, '[This runs inside the shell itself, with no program of its own to stop. Restart ends it.]\n'); paintCon(id); }
    } catch (e) { MC.toast('Could not stop it: ' + errText(e), 'warn'); }
    setTimeout(() => paintBar(id), 2100);
  }

  /* the folder a new console starts in: where the pasted command came from, else the panel's project */
  const projectOf = () => { const n = MC.curProject(); return (LV().byName || {})[n] || null; };
  const startDir = (vp) => vp.state.cwd || (projectOf() && projectOf().folder) || '';

  async function send(vp, el, text) {
    const id = vp.state.cid, c = con(id);
    if (text.trim()) { c.hist = c.hist.filter((h) => h !== text).concat([text]).slice(-100); }
    c.hi = -1; vp.state.typed = ''; vp.state.prefill = '';
    const note = $('.cons-paste', el); if (note) note.remove();
    stream();
    try {
      const d = await api.post(`/api/console/${enc(id)}/input`, { line: text, cwd: startDir(vp) });
      takeState(c, d); c.opened = true; paintBar(id);
      if (c.gone) { c.gone = false; c.seq = 0; catchUp(id); }
    } catch (e) { addText(c, `[Not sent: ${errText(e)}]\n`); paintCon(id); }
  }
  const fitIn = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };

  /* ---------- server log ---------- */
  const t8 = (ms) => new Date(ms).toTimeString().slice(0, 8);
  const srcOf = (text) => { const m = /^\[([\w .:-]{1,24})\]/.exec(text); return m ? m[1] : ''; };
  const logRow = (l) => { const src = srcOf(l.text); return `<div class="ln" data-seq="${l.seq}"><span class="tm">${t8(l.t)}</span><span class="lv ${l.err ? 'error' : 'info'}">${l.err ? 'ERROR' : 'INFO'}</span><span class="src ellip" title="${esc(src)}">${esc(src)}</span><span class="tx">${esc(src ? l.text.slice(src.length + 2).trim() : l.text)}</span><button class="btn sm ghost ask" data-ask title="Put this line in the message box">${I('chat', 'sm')}Ask about this line</button></div>`; };
  async function loadLog() {
    if (LOG.loading) return; LOG.loading = true;
    try { const d = await api.get(`/api/console/server-log?since=${LOG.seq}`); const first = !LOG.loaded; LOG.loaded = true; LOG.err = null; pushLog(d.lines || [], true); if (first) MC.emit('rerender', 'console'); }
    catch (e) { LOG.err = errText(e); MC.emit('rerender', 'console'); }
    finally { LOG.loading = false; }
  }
  function pushLog(lines, redraw) {
    lines = lines.filter((l) => l.seq > LOG.seq); if (!lines.length && !redraw) return;
    LOG.lines.push(...lines); if (lines.length) LOG.seq = lines[lines.length - 1].seq;
    if (LOG.lines.length > 2000) LOG.lines.splice(0, LOG.lines.length - 2000);
    $$('.cons-log[data-log="server"]').forEach((box) => {
      const end = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      if (redraw) box.innerHTML = LOG.lines.slice(-MAX_LOG_SHOWN).map(logRow).join('') || '<div class="faint">Nothing printed yet.</div>';
      else { box.insertAdjacentHTML('beforeend', lines.map(logRow).join('')); while (box.children.length > MAX_LOG_SHOWN) box.firstElementChild.remove(); }
      filterRows(box);
      if (end) box.scrollTop = box.scrollHeight;
    });
  }
  function filterRows(box) {
    const q = String(box.dataset.q || '').toLowerCase();
    [...box.children].forEach((r) => { r.hidden = !!q && !r.textContent.toLowerCase().includes(q); });
  }

  /* ---------- dev server: the project's job runs and their output ---------- */
  const DEV = { runs: null, at: 0, logs: {} }; /* logs: runId -> { lines, loading } */
  async function loadRuns(force) {
    if (!force && DEV.runs && Date.now() - DEV.at < 5000) return;
    try { const d = await api.get('/api/jobs'); DEV.runs = d.runs || []; DEV.at = Date.now(); } catch (e) { DEV.err = errText(e); DEV.runs = DEV.runs || []; }
    MC.emit('rerender', 'console');
  }
  async function loadDevLog(runId) {
    const L = DEV.logs[runId] = DEV.logs[runId] || { lines: null };
    if (L.loading) return; L.loading = true;
    try { const d = await api.get(`/api/jobs/${enc(runId)}/log?tail=1500`); L.lines = d.lines || []; L.cut = d.truncated; }
    catch (e) { L.lines = []; L.err = e.status === 404 ? 'This run kept no output.' : errText(e); }
    finally { L.loading = false; }
    MC.emit('rerender', 'console');
  }
  const devRow = (t, i) => `<div class="ln" data-i="${i}"><span class="tx">${esc(t)}</span><button class="btn sm ghost ask" data-ask title="Put this line in the message box">${I('chat', 'sm')}Ask about this line</button></div>`;
  MC.events.on('job', (d) => {
    if (!d || !d.runId) return;
    if (d.done || !DEV.runs || !DEV.runs.some((r) => r.runId === d.runId)) { loadRuns(true); }
    const L = DEV.logs[d.runId]; if (!L || !L.lines || d.line == null) return;
    L.lines.push(d.line); if (L.lines.length > 3000) L.lines.splice(0, L.lines.length - 3000);
    $$(`.cons-log[data-run="${CSS.escape(d.runId)}"]`).forEach((box) => {
      const end = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      box.insertAdjacentHTML('beforeend', devRow(d.line, L.lines.length - 1)); filterRows(box);
      if (end) box.scrollTop = box.scrollHeight;
    });
  });
  const runWord = (r) => r.state === 'running' ? 'running' : r.state === 'done' || r.code === 0 ? 'done' : r.state === 'stopped' ? 'stopped' : 'failed';

  /* ---------- "Ask about this line": into the open conversation's message box ---------- */
  function toBox(text) {
    const pick = () => { const all = $$('.convo[data-sid] textarea.md-in').filter((t) => t.offsetParent && !t.disabled); return all.find((t) => t.closest('.convo').dataset.sid === S.session) || all[0]; };
    const put = (ta) => { ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n\n') : '') + text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); MC.toast('In the message box: add your question and send it', 'chat'); };
    const ta = pick(); if (ta) { put(ta); return; }
    MC.emit('open', 'convo');
    setTimeout(() => { const t = pick(); if (t) put(t); else MC.toast('Open a conversation first', 'chat'); }, 120);
  }
  const fence = (s) => { const n = Math.max(3, ...(String(s).match(/`+/g) || ['']).map((x) => x.length + 1)); return '`'.repeat(n); };
  const askText = (where, line, before) => { const body = before.length ? before.concat([line]).join('\n') : line; const f = fence(body); return `About this line in ${where}${before.length ? ' (the lines before it too, for context)' : ''}:\n\n${f}\n${body}\n${f}\n\n`; };

  /* ---------- the module ---------- */
  const offHere = () => `<div class="empty">${I('lock')}<div>The console runs commands on the PC, so it opens there only, never from a phone or the hub.</div></div>`;
  M.console = {
    label: 'Console', icon: 'terminal', tabs: ['Terminal', 'Server log', 'Dev server'],
    render: (vp) => {
      if (ok === null) return '<div class="empty">Loading...</div>';
      if (!ok) return offHere();
      if (vp.tab === 'Server log') {
        if (!LOG.loaded) { loadLog(); return LOG.err ? `<div class="empty">${I('warn')}Could not read the server log: ${esc(LOG.err)}</div>` : '<div class="empty">Loading the server log...</div>'; }
        return `<div class="cons"><div class="cons-bar"><div class="input">${I('search', 'sm')}<input data-filter placeholder="Filter the log" value="${esc(vp.state.filter || '')}"></div><span class="grow"></span><span class="faint">What the server printed since it started</span></div>
          <div class="cons-log" data-log="server" data-q="${esc(vp.state.filter || '')}">${LOG.lines.slice(-MAX_LOG_SHOWN).map(logRow).join('') || '<div class="faint">Nothing printed yet.</div>'}</div></div>`;
      }
      if (vp.tab === 'Dev server') {
        const p = projectOf();
        if (!p || !p.id || p.root || p.chats) return `<div class="empty">${I('folder')}Pick a project: this tab shows the output of its scripts.</div>`;
        if (!DEV.runs) { loadRuns(); return '<div class="empty">Loading...</div>'; }
        const runs = DEV.runs.filter((r) => r.projectId === p.id).slice(0, 6);
        if (!runs.length) return `<div class="empty">${I('play')}<div>No script of ${esc(p.name)} has run yet. Run its dev server from the Scripts panel (or ask Claude to), and its output shows here.</div></div>`;
        const run = runs.find((r) => r.runId === vp.state.run) || runs.find((r) => r.state === 'running') || runs[0];
        const L = DEV.logs[run.runId];
        if (!L || (L.lines === null && !L.loading) || (run.state === 'running' && !L.lines && !L.loading)) loadDevLog(run.runId);
        const lines = (L && L.lines) || [];
        return `<div class="cons"><div class="cons-bar">${runs.map((r) => `<button class="chip ${r.runId === run.runId ? 'on' : ''}" data-run="${esc(r.runId)}" title="Started ${esc(new Date(r.startedAt).toLocaleString('en-US'))}">${I(r.state === 'running' ? 'loader' : r.code === 0 || r.state === 'done' ? 'check' : 'circle', 'sm')}${esc(r.label || r.jobId)} <span class="faint">${runWord(r)}</span></button>`).join('')}<span class="grow"></span><div class="input">${I('search', 'sm')}<input data-filter placeholder="Filter" value="${esc(vp.state.filter || '')}"></div></div>
          <div class="cons-log" data-run="${esc(run.runId)}" data-where="${esc(run.label || run.jobId)}" data-q="${esc(vp.state.filter || '')}">${L && L.err ? `<div class="faint">${esc(L.err)}</div>` : !L || L.lines === null ? '<div class="faint">Loading...</div>' : (L.cut ? '<div class="faint">[the start of this output is cut]</div>' : '') + (lines.map(devRow).join('') || '<div class="faint">No output yet.</div>')}</div></div>`;
      }
      /* Terminal */
      if (!vp.state.cid) { vp.state.cid = newId(); vp.cidNew = true; }
      const id = vp.state.cid, c = con(id);
      const typed = vp.state.prefill || vp.state.typed || '';
      return `<div class="cons" data-cid="${esc(id)}"><div class="cons-bar"><span class="cons-where ellip faint"></span><span class="grow"></span><span class="cons-st"></span>
          <button class="btn sm" data-k="stop" hidden>${I('stop', 'sm')}Stop</button><button class="btn sm ghost" data-k="clear" title="Clear what is shown (the shell keeps running)">${I('trash', 'sm')}Clear</button><button class="btn sm" data-k="restart" title="End the shell and everything it started, and open a new one in the same folder">${I('refresh', 'sm')}Restart</button></div>
        <pre class="cons-out" data-cid="${esc(id)}">${esc(c.lines.join('\n'))}</pre>
        ${vp.state.prefill ? `<div class="cons-paste faint">${I('sparkle', 'sm')} Pasted from Claude's message. Read it, then press Enter to run it.</div>` : ''}
        <div class="prompt"><span class="cons-ps"></span><textarea class="cons-in ${vp.state.prefill ? 'pasted' : ''}" rows="1" spellcheck="false" autocomplete="off">${esc(typed)}</textarea></div></div>`;
    },
    mount: (el, vp) => {
      if (!ok) return;
      stream();
      if (vp.tab === 'Server log' || vp.tab === 'Dev server') {
        const box = $('.cons-log', el); if (!box) return;
        box.scrollTop = box.scrollHeight;
        const f = $('[data-filter]', el); if (f) f.oninput = () => { vp.state.filter = f.value; box.dataset.q = f.value; filterRows(box); };
        filterRows(box);
        el.onclick = (e) => {
          const r = e.target.closest('[data-run]'); if (r && !e.target.closest('.cons-log')) { vp.state.run = r.dataset.run; delete DEV.logs[r.dataset.run]; vp.rerender(); return; }
          const a = e.target.closest('[data-ask]'); if (!a) return;
          const row = a.closest('.ln'), line = $('.tx', row).textContent;
          const prev = []; for (let x = row.previousElementSibling; x && prev.length < 5; x = x.previousElementSibling) if (x.classList.contains('ln') && !x.hidden) prev.unshift($('.tx', x).textContent);
          if (vp.tab === 'Server log') { const lv = $('.lv', row).textContent, src = $('.src', row).textContent; toBox(askText(`the Mission Control server log (${lv}${src ? ', ' + src : ''}, ${$('.tm', row).textContent})`, (src ? `[${src}] ` : '') + line, [])); }
          else toBox(askText(`the output of ${box.dataset.where || 'the dev server'} (${projectOf() ? projectOf().name : 'this project'})`, line, prev));
        };
        return;
      }
      const id = vp.state.cid, c = con(id);
      if (!c.opened) openCon(id, startDir(vp)); else if (!C[id].seq) catchUp(id);
      if (vp.cidNew) { vp.cidNew = false; vp.owner && vp.owner.changed && vp.owner.changed(); } /* the console id is kept in the layout: a reload finds the same shell */
      const pre = $('.cons-out', el), ta = $('.cons-in', el);
      pre.scrollTop = pre.scrollHeight; paintBar(id); fitIn(ta);
      if (vp.state.prefill) setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
      ta.oninput = () => { vp.state.typed = ta.value; if (vp.state.prefill) { vp.state.prefill = ''; ta.classList.remove('pasted'); } fitIn(ta); };
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value; ta.value = ''; ta.classList.remove('pasted'); fitIn(ta); send(vp, el, v); return; }
        const one = !ta.value.includes('\n');
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && one && c.hist.length) {
          e.preventDefault();
          c.hi = e.key === 'ArrowUp' ? (c.hi < 0 ? c.hist.length - 1 : Math.max(0, c.hi - 1)) : (c.hi < 0 ? -1 : c.hi + 1);
          if (c.hi >= c.hist.length) c.hi = -1;
          ta.value = c.hi < 0 ? '' : c.hist[c.hi]; vp.state.typed = ta.value; fitIn(ta);
        }
        if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); c.lines = ['']; paintCon(id); }
      };
      pre.onmouseup = () => { if (!String(getSelection() || '')) ta.focus(); };
      el.onclick = async (e) => {
        const b = e.target.closest('[data-k]'); if (!b) return;
        if (b.dataset.k === 'clear') { c.lines = ['']; paintCon(id); ta.focus(); return; }
        if (b.dataset.k === 'stop') { stopCmd(id); ta.focus(); return; }
        if (b.dataset.k === 'restart') {
          b.disabled = true;
          try { const d = await api.post(`/api/console/${enc(id)}/restart`); c.opened = true; c.gone = false; takeState(c, d); if (!c.seq) catchUp(id); }
          catch (err) { MC.toast('Could not restart: ' + errText(err), 'warn'); }
          b.disabled = false; ta.focus();
        }
      };
    },
  };

  /* ---------- "Paste in the console" on a command block (md.js marks them) ---------- */
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.md-paste') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (!ok) { MC.toast('The console opens at the PC only', 'lock'); return; }
    const code = b.closest('.md-code') && b.closest('.md-code').querySelector('pre code');
    const line = code ? code.textContent.replace(/\n+$/, '') : '';
    if (!line.trim()) return;
    const cv = b.closest('.convo');
    MC.emit('paste', { line, cwd: (cv && cv.dataset.cwd) || '' });
    MC.toast('Pasted in the console. Check it, then press Enter.', 'terminal');
  }, true);
})();
