/* Mission Control 2: the System page on real data, ported from today's System page (system.html).
   VRAM, RAM, CPU and GPU, the VRAM history, Make room, the local model's speed and benchmark, VRAM and RAM by process (unload, free, stop), dev servers, GPU health,
   the temp folder (builds and scratch, delete) and conversations and attachments (review, move to the Recycle Bin, shrink).
   Also the Home panel "GPU and RAM" (M.system) on the same data. Loads after settings.js. */
(() => {
  const { esc, icon: I } = MC;
  const M = MC.modules, api = MC.api, LV = MC.live || {};
  const errText = (e) => (e && ((e.data && e.data.error) || e.message)) || 'No answer';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const nm = (n) => (n && String(n).trim()) || 'unknown process';

  let need0 = 8; try { const v = parseFloat(localStorage.getItem('mc.need')); if (Number.isFinite(v) && v >= 0) need0 = v; } catch (e) { /* no storage */ }
  const S = { sys: null, servers: null, engines: null, err: null, all: false, ticks: 0, stopping: null, unl: new Set(), notes: new Map(), need: need0, plan: null, planBusy: false, msg: null, panelAt: 0 };
  let el = null;
  const shown = () => !!(el && el.offsetParent && !document.hidden);
  const part = (k) => el && el.querySelector(`[data-p="${k}"]`);
  const setPart = (k, html) => { const p = part(k); if (p) p.innerHTML = html; };
  const panel = () => { S.panelAt = Date.now(); };
  const panelLive = () => Date.now() - S.panelAt < 15000;

  /* ---------- formats ---------- */
  const fmtGB = (v) => (v == null ? 'n/a' : v.toFixed(1));
  const fmtMB = (mb) => (mb == null ? 'n/a' : mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
  const gbOf = (mb) => (mb / 1024).toFixed(1) + ' GB';
  const fmtBytes = (b) => { b = num(b); return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? Math.round(b / 1048576) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'; };
  function startedText(iso) {
    if (!iso) return 'n/a';
    const d = new Date(iso); if (isNaN(d)) return 'n/a';
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    const up = mins < 60 ? mins + ' min' : mins < 2880 ? Math.round(mins / 60) + 'h' : Math.round(mins / 1440) + 'd';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' (' + up + ')';
  }
  function ageText(iso) {
    if (!iso) return { t: 'n/a', old: false };
    const days = (Date.now() - new Date(iso).getTime()) / 86400000;
    const t = days < 1 / 24 ? 'just now' : days < 1 ? Math.round(days * 24) + 'h ago' : Math.round(days) + 'd ago';
    return { t: days >= 7 ? t + ' (old)' : t, old: days >= 7 };
  }
  const bar = (frac, hot) => `<div class="bar${hot ? ' warn' : ''}"><i style="width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%"></i></div>`;
  const pname = (p) => (p.name ? esc(p.name) : '<span class="faint">unknown</span>');
  const empty = (t, err) => `<div class="${err ? 'lv-err' : 'lv-empty'}">${err ? I('xc', 'sm') : ''}${esc(t)}</div>`;
  const selfPid = () => { const s = (S.servers || []).find((x) => x.isSelf); return s ? s.pid : null; };
  const who = '<span class="sys-who">This server</span>';

  /* ---------- unload and free: one state for the tables, the plan and the Home panel ---------- */
  const keyM = (eng, id) => 'm:' + eng + '|' + id;
  const KEY_COMFY = 'c:comfyui';
  function setNote(key, text, bad) {
    const n = { text, bad: !!bad, until: Date.now() + 6000 };
    S.notes.set(key, n);
    setTimeout(() => { if (S.notes.get(key) === n) { S.notes.delete(key); paintGpu(); } }, 6050);
  }
  const liveNote = (key) => { const n = S.notes.get(key); return n && n.until > Date.now() ? n : null; };
  const noteHtml = (key) => { const n = liveNote(key); return n && !n.bad ? `<span class="sys-rn">${esc(n.text)}</span>` : ''; };
  const errHtml = (key) => { const n = liveNote(key); return n && n.bad ? `<span class="sys-errln">${I('warn', 'sm')}${esc(n.text)}</span>` : ''; };
  const unloadBtn = (key, attrs, idle, busy) => { const b = S.unl.has(key); return `${noteHtml(key)}<button class="btn sm" ${attrs}${b || S.planBusy ? ' disabled' : ''}>${b ? busy : idle}</button>`; };
  /* one unload or free; true when the server took it */
  async function runItem(it) {
    S.unl.add(it.key); paintGpu();
    let ok = true;
    try {
      if (it.kind === 'free') await api.post('/api/engines/comfyui/free');
      else { const r = await api.post('/api/engines/' + encodeURIComponent(it.engine) + '/unload', { model: it.id }); if (r && r.stillLoaded) setNote(it.key, 'Still loaded'); }
    } catch (e) { ok = false; S.failWhy = errText(e); setNote(it.key, S.failWhy, true); }
    S.unl.delete(it.key);
    return ok;
  }
  const comfyPid = () => { const e = ((S.engines && S.engines.engines) || []).find((x) => x.id === 'comfyui' && x.canFree); return e && e.pid != null ? e.pid : null; };
  async function unloadClick(b) {
    if (b.dataset.unl) { const k = keyM(b.dataset.eng, b.dataset.model); if (S.unl.has(k) || S.planBusy) return true; await runItem({ kind: 'unload', key: k, engine: b.dataset.eng, id: b.dataset.model }); await loadAll(); return true; }
    if (b.dataset.free) { if (S.unl.has(KEY_COMFY) || S.planBusy) return true; await runItem({ kind: 'free', key: KEY_COMFY }); await loadAll(); return true; }
    return false;
  }

  /* ---------- the four numbers ---------- */
  function tile(label, value, sub, hot) {
    return `<div class="tile${hot ? ' hot' : ''}"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div><div class="ts">${hot ? `<span class="sys-hot">${I('warn', 'sm')}High</span> · ` : ''}${esc(sub)}</div></div>`;
  }
  function tilesHtml() {
    const d = S.sys;
    if (!d) return ['VRAM used', 'RAM used', 'CPU', 'GPU'].map((l) => tile(l, '--', S.err ? 'Server offline' : 'Reading')).join('');
    const g = d.gpu, r = d.ram, c = d.cpu;
    const vp = g && g.vramTotalGB ? Math.round(g.vramUsedGB / g.vramTotalGB * 100) : null, rp = r && r.totalGB ? Math.round(r.usedGB / r.totalGB * 100) : null;
    return (vp != null ? tile('VRAM used', fmtGB(g.vramUsedGB) + ' GB', `of ${fmtGB(g.vramTotalGB)} GB · ${vp}%`, vp >= 90) : tile('VRAM used', 'n/a', 'No GPU reading'))
      + (rp != null ? tile('RAM used', fmtGB(r.usedGB) + ' GB', `of ${fmtGB(r.totalGB)} GB · ${rp}%`, rp >= 90) : tile('RAM used', 'n/a', ''))
      + (c && c.loadPct != null ? tile('CPU', Math.round(c.loadPct) + '%', `${c.cores} threads`, c.loadPct >= 90) : tile('CPU', 'n/a', ''))
      + (g && g.tempC != null ? tile('GPU', Math.round(g.tempC) + ' °C', 'Load ' + (g.utilPct == null ? 'n/a' : Math.round(g.utilPct) + '%'), g.tempC >= 85) : tile('GPU', 'n/a', ''));
  }
  const barSub = () => { const d = S.sys; if (!d) return S.err ? 'Server offline' : 'Reading this PC'; const g = d.gpu, r = d.ram, c = d.cpu; return [g && g.name, r && r.totalGB != null ? Math.round(r.totalGB) + ' GB RAM' : null, c && c.name].filter(Boolean).join(' · ') || 'No details'; };
  let lastSub = null;
  const redrawBar = () => { const s = barSub(); if (s !== lastSub && shown() && MC.D && MC.D.drawBar) { lastSub = s; MC.D.drawBar(); } };

  /* ---------- GPU health: three gauges ---------- */
  function fit(c) {
    const D = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * D) || c.height !== Math.round(h * D)) { c.width = Math.round(w * D); c.height = Math.round(h * D); }
    const x = c.getContext('2d'); x.setTransform(D, 0, 0, D, 0, 0); return [x, w, h];
  }
  const css = (v) => getComputedStyle(el || document.documentElement).getPropertyValue(v).trim();
  function gauge(c, val, max) {
    if (!c) return;
    const [x, w, h] = fit(c); x.clearRect(0, 0, w, h);
    if (!w || !h) return;
    const on = css('--text'), hot = css('--warn'), off = css('--line-2');
    const v = val == null ? 0 : Math.min(1, val / max), cx = w / 2, cy = h * .62, R = Math.min(w / 2, h * .6) - 6, N = 24;
    for (let i = 0; i < N; i++) { const a0 = Math.PI * .8 + i / N * Math.PI * 1.4, a1 = a0 + Math.PI * 1.4 / N - .04; x.beginPath(); x.arc(cx, cy, R, a0, a1); x.arc(cx, cy, R * .78, a1, a0, true); x.closePath(); x.fillStyle = i < v * N ? (i > N * .8 ? hot : on) : off; x.fill(); }
  }
  function paintHealth() {
    if (!el) return;
    const g = S.sys && S.sys.gpu, set = (k, t) => { const n = el.querySelector(`[data-g="${k}"]`); if (n) n.textContent = t; };
    const vals = { T: [g && g.tempC, 90, (v) => Math.round(v) + ' °C'], L: [g && g.utilPct, 100, (v) => Math.round(v) + '%'], M: [g && g.vramTotalGB ? g.vramUsedGB / g.vramTotalGB * 100 : null, 100, (v) => Math.round(v) + '%'] };
    for (const k of Object.keys(vals)) { const [v, max, f] = vals[k]; set(k, v == null ? 'n/a' : f(v)); gauge(el.querySelector(`canvas[data-gc="${k}"]`), v, max); }
    set('name', (g && g.name) || 'n/a'); set('driver', (g && g.driver) || 'n/a'); set('cuda', (g && g.cuda) || 'n/a');
  }

  /* ---------- VRAM by process: models sit under their process, each with its Unload ---------- */
  function gpuHtml() {
    const d = S.sys;
    if (!d) return empty(S.err ? 'Server offline' : 'Loading', !!S.err);
    const list = (d.gpuProcs || []).slice().sort((a, b) => (b.vramMB == null ? -1 : b.vramMB) - (a.vramMB == null ? -1 : a.vramMB));
    if (!list.length) return empty('No processes are using the GPU');
    const tot = d.gpu && d.gpu.vramTotalGB ? d.gpu.vramTotalGB * 1024 : 0, me = selfPid(), cp = comfyPid();
    return `<div class="tr hd"><span>Process</span><span class="hs">PID</span><span>VRAM</span><span class="hs">Share</span><span></span></div>` + list.map((p) => {
      const models = p.models || [], isComfy = cp != null && p.pid === cp;
      /* quiet: the process holds models that Unload (or Free) clears safely, so Stop is the last resort */
      const quiet = models.some((m) => m.canUnload) ? 'unload' : isComfy ? 'free' : '';
      const act = p.pid === me ? who : stopBtn('g' + p.pid, p.pid, p.name, 0, quiet);
      const free = isComfy ? unloadBtn(KEY_COMFY, 'data-free="1"', 'Free', 'Freeing...') : '';
      const row = `<div class="tr"><span class="nm" title="${esc(p.name || '')}"><span class="ellip">${pname(p)}</span>${isComfy ? errHtml(KEY_COMFY) : ''}</span><span class="mono faint hs">${num(p.pid)}</span><span class="mono">${fmtMB(p.vramMB)}</span><span class="hs">${p.vramMB != null && tot ? bar(p.vramMB / tot, p.vramMB / tot > .25) : '<span class="faint mono">n/a</span>'}</span><span class="acts">${free}${act}</span></div>`;
      const sub = models.map((m) => {
        const key = keyM(m.engine, m.id);
        const right = m.canUnload ? unloadBtn(key, `data-unl="1" data-eng="${esc(m.engine)}" data-model="${esc(m.id)}"`, 'Unload', 'Unloading...') : '<span class="faint sys-nosafe">No safe unload</span>';
        return `<div class="tr mdl"><span class="nm" title="${esc(m.id)}"><span class="ellip">${esc(m.label || m.id)}</span>${errHtml(key)}</span><span class="hs"></span><span class="mono">${m.vramMB != null ? fmtMB(m.vramMB) : ''}</span><span class="hs"></span><span class="acts">${right}</span></div>`;
      }).join('');
      return `<div class="sys-g${models.length ? ' hasm' : ''}">${row}${sub}</div>`;
    }).join('');
  }
  function ramHtml() {
    const d = S.sys;
    if (!d) return empty(S.err ? 'Server offline' : 'Loading', !!S.err);
    const list = d.topRam || [], tot = d.ram ? d.ram.totalGB * 1024 : 0, me = selfPid();
    if (!list.length) return empty('No process data');
    return `<div class="tr hd"><span>Process</span><span class="hs">PID</span><span>RAM</span><span class="hs">Share</span><span></span></div>`
      + list.map((p) => `<div class="tr"><span class="nm" title="${esc(p.name || '')}"><span class="ellip">${pname(p)}</span></span><span class="mono faint hs">${num(p.pid)}</span><span class="mono">${fmtMB(p.ramMB)}</span><span class="hs">${p.ramMB != null && tot ? bar(p.ramMB / tot, p.ramMB / tot > .1) : '<span class="faint mono">n/a</span>'}</span><span class="acts">${p.pid === me ? who : stopBtn('r' + p.pid, p.pid, p.name)}</span></div>`).join('');
  }
  function stopBtn(key, pid, name, port, quiet) {
    const busy = S.stopping === key;
    return `<button class="btn sm pc-only${quiet ? ' ghost sys-quiet' : ''}" data-stop="${esc(key)}" data-pid="${num(pid)}" data-name="${esc(nm(name))}" data-port="${port ? num(port) : ''}" data-quiet="${quiet || ''}"${busy || S.stopping ? ' disabled' : ''}>${busy ? 'Stopping' : 'Stop'}</button>`;
  }

  /* ---------- dev servers ---------- */
  function srvHtml() {
    if (!S.servers) return empty(S.err ? 'Server offline' : 'Loading', !!S.err);
    const list = S.servers.filter((s) => S.all || s.isDev || s.isSelf).sort((a, b) => (b.isDev - a.isDev) || (a.port - b.port));
    if (!list.length) return empty('No dev servers running');
    return `<div class="tr hd"><span>Port</span><span>Process</span><span>Project</span><span class="hs">PID</span><span class="hs">Started</span><span></span></div>` + list.map((s) => {
      const p = s.project && LV.byId && LV.byId[s.project];
      const proj = s.project ? (p ? `<button class="linkb ellip" data-proj="${esc(p.name)}">${esc(p.name)}</button>` : `<span class="ellip">${esc(s.project)}</span>`) : '<span class="faint">n/a</span>';
      return `<div class="tr" title="${esc(s.commandLine || '')}"><span class="mono">${num(s.port)}</span><span class="nm"><span class="ellip">${pname(s)}</span>${s.isSelf ? who : s.isDev ? '<span class="sys-who dev">Dev</span>' : ''}</span>${proj}<span class="mono faint hs">${num(s.pid)}</span><span class="faint hs ellip">${esc(startedText(s.startedAt))}</span><span class="acts">${s.isSelf ? '' : stopBtn('s' + s.pid + ':' + s.port, s.pid, s.name, s.port)}</span></div>`;
    }).join('');
  }

  /* ---------- Make room: the smallest list of unloads that frees enough ---------- */
  const vramNums = () => { const g = S.sys && S.sys.gpu; return g && g.vramTotalGB ? { total: g.vramTotalGB, used: g.vramUsedGB, free: Math.max(0, g.vramTotalGB - g.vramUsedGB) } : null; };
  /* every model that unloads (largest first), then ComfyUI's free with its process VRAM */
  function candidates() {
    const out = [];
    for (const e of ((S.engines && S.engines.engines) || [])) for (const m of e.models || []) if (m.canUnload) out.push({ kind: 'unload', key: keyM(e.id, m.id), engine: e.id, id: m.id, label: m.label || m.id, mb: m.vramMB });
    out.sort((a, b) => (b.mb == null ? -1 : b.mb) - (a.mb == null ? -1 : a.mb));
    const cp = comfyPid(), row = cp == null ? null : ((S.sys && S.sys.gpuProcs) || []).find((p) => p.pid === cp);
    if (row) out.push({ kind: 'free', key: KEY_COMFY, engine: 'comfyui', label: 'ComfyUI', mb: row.vramMB, pid: cp });
    return out;
  }
  function makePlan(deficitMB) {
    const all = candidates(), known = all.filter((c) => c.mb != null), unknown = all.filter((c) => c.mb == null);
    const sel = [];
    let sum = 0;
    for (const c of known) { if (sum >= deficitMB) break; sel.push(c); sum += c.mb; }
    const enough = sum >= deficitMB;
    if (!enough) for (const c of unknown) sel.push(c);
    if (enough) { /* drop what is not needed, smallest first */
      for (const c of sel.slice().sort((a, b) => a.mb - b.mb)) { if (sum - c.mb >= deficitMB) { sel.splice(sel.indexOf(c), 1); sum -= c.mb; } }
    }
    return { items: sel, sumMB: sum, enough, none: all.length === 0 };
  }
  function paintRoom() {
    if (!el) return;
    const v = vramNums(), R = el.querySelector('[data-need]'), out = part('room'), val = part('needv');
    if (!R || !out) return;
    if (!v) { R.disabled = true; val.textContent = '--'; out.innerHTML = `<div class="faint">${S.err ? 'Server offline' : S.sys ? 'No GPU reading' : 'Reading'}</div>`; S.plan = null; return; }
    R.disabled = !!S.planBusy;
    const max = Math.max(0.5, Math.floor(v.total * 2) / 2);
    if (+R.max !== max) R.max = max;
    if (S.need > max) S.need = max;
    if (+R.value !== S.need) R.value = S.need;
    R.style.setProperty('--p', (S.need / max * 100) + '%');
    val.textContent = S.need;
    if (S.need <= v.free + 0.005 && !S.planBusy) { out.innerHTML = `<div class="sys-rl">${MC.st('done', 'Enough')}<span>${v.free.toFixed(1)} GB free now</span></div>`; S.plan = null; return; }
    const deficit = Math.max(0, S.need - v.free), p = makePlan(deficit * 1024);
    let html = `<div class="sys-rl">${MC.st('wait', 'Short')}<span>${v.free.toFixed(1)} GB free now, ${deficit.toFixed(1)} GB short</span></div>`;
    html += p.items.map((it) => `<div class="sys-pl"><span class="t">${it.kind === 'free' ? 'Free ' : 'Unload '}<b>${esc(it.label)}</b>${errHtml(it.key)}</span>${noteHtml(it.key)}<span class="mono faint">${it.mb == null ? 'size n/a' : gbOf(it.mb)}</span></div>`).join('');
    if (!p.enough) {
      const left = Math.max(0, deficit - p.sumMB / 1024), me = selfPid(), skip = new Set(p.items.map((i) => i.pid));
      const others = ((S.sys && S.sys.gpuProcs) || []).filter((x) => x.vramMB != null && x.pid !== me && !skip.has(x.pid) && !(x.models || []).length).sort((a, b) => b.vramMB - a.vramMB).slice(0, 3);
      html += `<div class="sys-rwarn">${p.none ? 'No model is loaded, so there is nothing to unload.' : `Unloading every model is not enough, ${left.toFixed(1)} GB still short.`}${others.length ? ' Biggest others: ' + others.map((o) => `<b>${esc(o.name || 'pid ' + o.pid)}</b> ${gbOf(o.vramMB)}`).join(', ') : ''}</div>`;
    }
    if (S.planBusy) html += '<div class="sys-rgo"><button class="btn primary" disabled>Unloading...</button></div>';
    else if (p.items.length) html += `<div class="sys-rgo"><button class="btn primary" data-rgo>${p.sumMB > 0 ? 'Free ' + gbOf(p.sumMB) : 'Unload ' + p.items.length}</button></div>`;
    out.innerHTML = html;
    S.plan = p;
  }
  async function runPlan() {
    if (S.planBusy || !S.plan || !S.plan.items.length) return;
    const items = S.plan.items.slice();
    S.planBusy = true; if (S.msg && S.msg.plan) showMsg(null);
    try {
      paintGpu();
      for (const it of items) {
        if (!(await runItem(it))) { showMsg(false, `Stopped at ${it.label || it.id || 'item'}: ${S.failWhy}`, true); break; }
      }
    } finally { S.planBusy = false; } /* the buttons always unlock, whatever failed */
    paintGpu();
    await loadAll();
  }

  /* ---------- the result line (stop, delete, a plan that stopped) ---------- */
  function showMsg(ok, text, plan) { S.msg = ok == null ? null : { ok, text, plan: !!plan }; paintMsg(); }
  function paintMsg() {
    const p = part('msg'); if (!p) return;
    p.hidden = !S.msg;
    p.innerHTML = S.msg ? `${MC.st(S.msg.ok ? 'done' : 'fail', S.msg.ok ? 'Done' : 'Refused')}<span class="grow">${esc(S.msg.text)}</span><button class="ibtn sm" data-msgx title="Close">${I('x', 'sm')}</button>` : '';
  }

  /* ---------- VRAM history chart ---------- */
  const H = { range: '1h', data: null, err: false, hover: null, geo: null };
  const SPAN = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };
  const hh = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  async function loadHist() {
    const r = H.range;
    try { const d = await api.get('/api/system/vram-history?range=' + r); if (r !== H.range) return; H.data = d; H.err = false; }
    catch (e) { if (r !== H.range) return; H.err = true; }
    drawHist();
  }
  const niceStep = (raw) => { for (const s of [1, 2, 4, 5, 8, 10, 16, 20, 25, 50, 100]) if (s >= raw) return s; return 100; };
  function drawHist() {
    if (!el) return;
    const cv = el.querySelector('canvas[data-hc]'), none = el.querySelector('[data-hnone]'), card = el.querySelector('[data-vcard]');
    if (!cv) return;
    const pts = (H.data && H.data.points) || [], isEmpty = pts.length < 2;
    none.hidden = !isEmpty; /* the canvas itself is never hidden: a canvas drawn right after being unhidden can stay blank */
    const [x, W, Hh] = fit(cv); x.clearRect(0, 0, W, Hh);
    if (isEmpty) { none.textContent = H.err && !H.data ? 'Server offline' : H.data ? 'Recording' : 'Reading history'; card.hidden = true; H.geo = null; return; }
    if (!W || !Hh) return;
    const k = parseFloat(css('--k')) || 1, mono = css('--mono'), font = css('--font');
    const cText = css('--text'), cGrid = css('--line'), cLab = css('--text-3'), cTot = css('--text-2'), cBg = css('--panel');
    const pl = 52 * k, pr = 12 * k, pt = 26 * k, pb = 26 * k, pw = W - pl - pr, ph = Hh - pt - pb;
    const t1 = Date.now(), t0 = Math.max(t1 - SPAN[H.range], pts[0][0]);
    const maxUsed = pts.reduce((m, p) => Math.max(m, p[1]), 0);
    const total = H.data.totalGB || Math.ceil(maxUsed), ymax = Math.max(total, maxUsed) || 1;
    const X = (t) => pl + (t - t0) / Math.max(1, t1 - t0) * pw, Y = (v) => pt + ph - v / ymax * ph;
    x.font = `${12 * k}px ${mono}`; x.textBaseline = 'middle';
    /* y axis */
    const step = niceStep(ymax / 4);
    x.textAlign = 'right';
    for (let v = 0; v < ymax - step * .4; v += step) {
      x.strokeStyle = cGrid; x.lineWidth = 1; x.beginPath(); x.moveTo(pl, Math.round(Y(v)) + .5); x.lineTo(W - pr, Math.round(Y(v)) + .5); x.stroke();
      x.fillStyle = cLab; x.fillText(v + ' GB', pl - 8, Y(v));
    }
    /* x axis */
    const mins = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].find((m) => pw / ((t1 - t0) / 60000 / m) >= 78 * k) || 720, stepMs = mins * 60000, off = new Date(t0).getTimezoneOffset() * 60000;
    x.textAlign = 'center'; x.textBaseline = 'top'; x.fillStyle = cLab;
    for (let t = Math.ceil((t0 - off) / stepMs) * stepMs + off; t <= t1; t += stepMs) {
      const px = X(t); if (px < pl + 14 || px > W - pr - 14) continue;
      x.strokeStyle = cGrid; x.beginPath(); x.moveTo(Math.round(px) + .5, pt); x.lineTo(Math.round(px) + .5, pt + ph + 4); x.stroke();
      x.fillText(hh(t), px, pt + ph + 8);
    }
    /* total, dashed */
    x.setLineDash([5, 4]); x.strokeStyle = cTot; x.lineWidth = 1; x.beginPath(); x.moveTo(pl, Math.round(Y(total)) + .5); x.lineTo(W - pr, Math.round(Y(total)) + .5); x.stroke(); x.setLineDash([]);
    x.textAlign = 'right'; x.textBaseline = 'bottom'; x.fillStyle = cTot; x.font = `600 ${12 * k}px ${font}`; x.fillText(total.toFixed(0) + ' GB total', W - pr, Y(total) - 4);
    /* area and line, broken where the server was not sampling */
    const gap = Math.max(45000, SPAN[H.range] / 360 * 3), segs = [];
    let cur = [];
    for (const p of pts) { if (cur.length && p[0] - cur[cur.length - 1][0] > gap) { segs.push(cur); cur = []; } cur.push(p); }
    segs.push(cur);
    x.lineJoin = 'round';
    for (const sg of segs) {
      if (sg.length < 2) { const p = sg[0]; x.fillStyle = cText; x.fillRect(X(p[0]) - 1, Y(p[1]) - 1, 3, 3); continue; }
      x.beginPath(); sg.forEach((p, i) => (i ? x.lineTo(X(p[0]), Y(p[1])) : x.moveTo(X(p[0]), Y(p[1]))));
      x.lineTo(X(sg[sg.length - 1][0]), Y(0)); x.lineTo(X(sg[0][0]), Y(0)); x.closePath(); x.globalAlpha = .13; x.fillStyle = cText; x.fill(); x.globalAlpha = 1;
      x.beginPath(); sg.forEach((p, i) => (i ? x.lineTo(X(p[0]), Y(p[1])) : x.moveTo(X(p[0]), Y(p[1])))); x.strokeStyle = cText; x.lineWidth = 1.6; x.stroke();
    }
    H.geo = { pl, pw, t0, t1 };
    /* crosshair and card */
    if (H.hover != null && pts[H.hover]) {
      const p = pts[H.hover], px = X(p[0]), py = Y(p[1]);
      x.globalAlpha = .55; x.strokeStyle = cText; x.lineWidth = 1; x.beginPath(); x.moveTo(Math.round(px) + .5, pt); x.lineTo(Math.round(px) + .5, pt + ph); x.stroke(); x.globalAlpha = 1;
      x.fillStyle = cText; x.strokeStyle = cBg; x.lineWidth = 2; x.beginPath(); x.arc(px, py, 4 * k, 0, 7); x.stroke(); x.fill();
      const d = new Date(p[0]), when = (H.range === '24h' ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' : '') + hh(p[0]) + ':' + String(d.getSeconds()).padStart(2, '0');
      card.innerHTML = `<b>${when}</b><div class="u">${p[1].toFixed(1)} GB of ${total.toFixed(0)} GB</div>` + (p[2] || []).slice(0, 3).map((q) => `<div class="pp"><span class="ellip">${esc(q[0] || 'unknown')}</span><span class="mono">${fmtMB(q[1])}</span></div>`).join('');
      card.hidden = false;
      const cw = card.offsetWidth; card.style.left = Math.max(0, Math.round(px + 14 + cw > W ? px - 14 - cw : px + 14)) + 'px';
    } else card.hidden = true;
  }
  function bindChart() {
    const cv = el.querySelector('canvas[data-hc]'), box = el.querySelector('.sys-chart');
    cv.addEventListener('pointermove', (ev) => {
      const pts = (H.data && H.data.points) || [], g = H.geo; if (!g || !pts.length) return;
      const r = cv.getBoundingClientRect(), t = g.t0 + (ev.clientX - r.left - g.pl) / g.pw * (g.t1 - g.t0);
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(pts[lo][0] - t)) lo--;
      if (lo !== H.hover) { H.hover = lo; drawHist(); }
    });
    cv.addEventListener('pointerleave', () => { H.hover = null; drawHist(); });
    cv.addEventListener('contextrestored', () => drawHist()); /* a lost canvas comes back blank */
    if (window.ResizeObserver) new ResizeObserver(() => { if (shown()) { drawHist(); paintHealth(); } }).observe(box);
  }
  const paintRange = () => { if (el) el.querySelectorAll('[data-hr]').forEach((b) => { const on = b.dataset.hr === H.range; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); };

  /* ---------- builds and scratch files (the temp folder) ---------- */
  const T = { data: null, err: null, busy: false, deleting: null };
  function tempHtml() {
    const d = T.data;
    if (!d) return T.err ? empty('Could not read the temp folder: ' + errText(T.err), true) : empty('Measuring');
    if (!d.configured) return empty('No temp folder is set. Add "tempRoot" to .data/config.json.');
    if (!d.exists) return empty('The folder does not exist yet');
    const rows = [`<div class="tr hd"><span>Item</span><span>Size</span><span class="hs">Files</span><span class="hs">Last change</span><span></span></div>`];
    for (const g of d.groups) {
      rows.push(`<div class="sys-grp"><b>${esc(g.name[0].toUpperCase() + g.name.slice(1))}</b><span class="grow"></span><span class="mono">${fmtBytes(g.bytes)}</span></div>`);
      if (!g.items.length) rows.push(empty('Empty'));
      for (const it of g.items) {
        const a = ageText(it.newest), kind = it.isLink ? 'link' : it.isDir ? 'folder' : 'file', busy = T.deleting === it.path;
        rows.push(`<div class="tr"><span class="nm" title="${esc(it.path)}"><span class="ellip">${esc(it.name)}</span><small class="faint">${kind}</small></span><span class="mono">${fmtBytes(it.bytes)}</span><span class="mono faint hs">${it.isDir ? num(it.files).toLocaleString('en-US') : ''}</span><span class="hs${a.old ? ' sys-old' : ' faint'}">${esc(a.t)}</span><span class="acts"><button class="btn sm pc-only" data-tdel="${esc(it.path)}" data-name="${esc(it.name)}" data-bytes="${num(it.bytes)}"${T.deleting ? ' disabled' : ''}>${busy ? 'Deleting' : 'Delete'}</button></span></div>`);
      }
    }
    return rows.length > 1 ? rows.join('') : empty('The temp folder is empty');
  }
  function paintTemp() {
    setPart('temp', tempHtml());
    const d = T.data, sub = part('tsub'), re = el && el.querySelector('[data-tre]');
    if (sub) sub.textContent = d && d.configured ? d.root + (d.refreshing ? ' · measuring again' : '') : '';
    setPart('tc', d && d.configured ? fmtBytes(d.bytes) : '');
    if (re) re.disabled = T.busy;
  }
  async function loadTemp(fresh) {
    if (T.busy) return;
    T.busy = true;
    if (fresh) T.data = null;
    paintTemp();
    try { T.data = await api.get('/api/temp' + (fresh ? '?fresh=1' : '')); T.err = null; } catch (e) { T.err = e; }
    T.busy = false;
    paintTemp();
    /* the server showed its last result and is measuring again: ask once more in a moment */
    clearTimeout(T.again);
    if (T.data && T.data.refreshing) T.again = setTimeout(() => loadTemp(false), 4000);
  }

  /* ---------- conversations and attachments (services/storage.js): by type, code conversations by project. Review lists one
     group, filtered by age, and moves the ticked items to the Recycle Bin or shrinks them. Pinned ones start unticked. ---------- */
  const K = { data: null, err: null, busy: false, loading: false, rev: null, age: 0, picked: new Set(), ask: false, result: '', est: null, parts: { toolPictures: true } };
  const K_AGES = [[0, 'Any age'], [30, 'Not used for 1 month'], [91, 'Not used for 3 months'], [182, 'Not used for 6 months'], [365, 'Not used for 1 year']];
  const kWhen = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'n/a'; };
  const kKey = (type, project) => type + '|' + (project || '');
  const kId = (x) => x.type + '\n' + x.id;
  const kSum = (its) => its.reduce((n, x) => n + num(x.bytes), 0);
  const kOldest = (its) => its.reduce((m, x) => ((!m || (x.lastAt && x.lastAt < m)) ? x.lastAt : m), null);
  function kGroups() {
    const d = K.data, out = [];
    for (const type of Object.keys(d.types)) {
      const its = d.items.filter((x) => x.type === type);
      if (!its.length) continue;
      const parts = [...new Set(its.map((x) => x.project || ''))].sort((a, b) => (a === 'No project' ? 1 : b === 'No project' ? -1 : a.localeCompare(b)));
      out.push({ type, label: d.types[type], items: its, parts: parts.map((pr) => ({ project: pr, items: its.filter((x) => (x.project || '') === pr) })) });
    }
    return out;
  }
  function storeHtml() {
    const d = K.data;
    if (!d) return K.err ? empty('Could not measure them: ' + errText(K.err), true) : empty('Measuring');
    const rows = [`<div class="tr hd"><span>What</span><span>Size</span><span class="hs">Count</span><span class="hs">Oldest use</span><span></span></div>`];
    for (const g of kGroups()) {
      rows.push(`<div class="sys-grp"><b>${esc(g.label)}</b><span class="grow"></span><span class="mono">${fmtBytes(kSum(g.items))}</span></div>`);
      for (const pt of g.parts) {
        const on = K.rev === kKey(g.type, pt.project);
        rows.push(`<div class="tr${on ? ' on' : ''}"><span class="nm ellip">${esc(pt.project || 'All')}</span><span class="mono">${fmtBytes(kSum(pt.items))}</span><span class="mono faint hs">${pt.items.length.toLocaleString('en-US')}</span><span class="faint hs">${esc(kWhen(kOldest(pt.items)))}</span><span class="acts"><button class="btn sm${on ? ' primary' : ''}" data-krev="${esc(kKey(g.type, pt.project))}" aria-expanded="${on}">${on ? 'Close' : 'Review'}</button></span></div>`);
      }
    }
    return rows.length > 1 ? rows.join('') : empty('Nothing is kept yet');
  }
  function kRevItems() {
    if (!K.data || !K.rev) return [];
    const [type, project] = K.rev.split('|'), cut = K.age ? Date.now() - K.age * 864e5 : Infinity;
    return K.data.items.filter((x) => x.type === type && (x.project || '') === project && (!K.age || !x.lastAt || Date.parse(x.lastAt) < cut))
      .sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
  }
  function revHtml() {
    const [type, project] = K.rev.split('|'), its = kRevItems(), picked = its.filter((x) => K.picked.has(kId(x))), bytes = kSum(picked);
    const ages = ['code', 'chat', 'pictures', 'documents', 'files', 'logs'].includes(type);
    const btns = K.ask === 'shrink'
      ? `<button class="btn sm primary" data-k="yes"${K.busy || !Object.values(K.parts).some(Boolean) ? ' disabled' : ''}>${K.busy ? 'Shrinking' : 'Shrink ' + picked.length}</button><button class="btn sm ghost" data-k="no"${K.busy ? ' disabled' : ''}>Cancel</button>`
      : (type === 'code' ? `<button class="btn sm pc-only" data-k="shrink"${picked.length && !K.busy ? '' : ' disabled'}>Shrink ${picked.length}</button>` : '')
        + `<button class="btn sm primary pc-only" data-k="del"${picked.length && !K.busy ? '' : ' disabled'}>${K.busy ? 'Moving' : `Move ${picked.length} to the Recycle Bin (${fmtBytes(bytes)})`}</button>`;
    return `<div class="sys-revh"><b>${esc(K.data.types[type] + (project ? ' · ' + project : ''))}</b>`
      + (ages ? `<button class="input dsel sys-age" data-k="age"><span class="grow ellip">${esc((K_AGES.find((a) => a[0] === K.age) || K_AGES[0])[1])}</span>${I('chev', 'sm')}</button>` : '')
      + `<button class="btn sm ghost" data-k="all">${picked.length === its.length && its.length ? 'Tick none' : 'Tick all'}</button><span class="grow"></span>${btns}</div>`
      + (K.ask === 'shrink' ? shrinkHtml(picked) : '')
      + (K.result ? `<div class="sys-res" role="status">${esc(K.result)}</div>` : '')
      + (its.length ? `<div class="sys-lst">${its.map((x) => `<label class="sys-it"><input type="checkbox" data-kit="${esc(kId(x))}"${K.picked.has(kId(x)) ? ' checked' : ''}${K.busy ? ' disabled' : ''}><span class="ellip">${esc(x.name)}${x.pinned || x.archived ? `<small class="faint">${[x.pinned ? 'pinned' : '', x.archived ? 'archived' : ''].filter(Boolean).join(', ')}</small>` : ''}</span><span class="mono faint">${fmtBytes(x.bytes)}</span><span class="faint">${esc(kWhen(x.lastAt))}</span></label>`).join('')}</div>`
        : empty('Nothing matches'));
  }
  /* what to take out of the picked conversations, each with what it saves (measured by the server, POST shrink-estimate) */
  function shrinkHtml(picked) {
    const e = K.est, now = kSum(picked), could = (e && e.could) || {};
    const parts = (e && e.parts) || { toolPictures: 'Pictures tools sent back (screenshots)' };
    const save = Object.keys(parts).reduce((n, k) => n + (K.parts[k] && e ? num(could[k]) : 0), 0);
    return `<div class="sys-shr" role="group" aria-label="What to take out"><div>Every message, answer and step stays. What you tick is taken out and replaced by a short note. The old files go to the Recycle Bin.</div>`
      + Object.entries(parts).map(([k, label]) => `<label class="sys-opt"><input type="checkbox" data-kpart="${esc(k)}"${K.parts[k] ? ' checked' : ''}${K.busy ? ' disabled' : ''}><span>${esc(label)}</span><span class="mono faint">${e ? (num(could[k]) ? 'about ' + fmtBytes(could[k]) : 'nothing') : 'measuring'}</span></label>`).join('')
      + `<div class="sys-tot">${e ? `Saves about <b class="mono">${fmtBytes(save)}</b> of ${fmtBytes(now)}${now ? ' (' + Math.round(100 * save / now) + '%)' : ''}` : 'Measuring'}</div></div>`;
  }
  function paintRev() { const p = part('rev'); if (!p) return; p.hidden = !(K.rev && K.data); p.innerHTML = K.rev && K.data ? revHtml() : ''; }
  function paintStore() {
    setPart('store', storeHtml());
    setPart('kc', K.data ? fmtBytes(kSum(K.data.items)) : '');
    const re = el && el.querySelector('[data-kre]'); if (re) re.disabled = K.loading;
    paintRev();
  }
  async function kMeasure() {
    const items = kRevItems().filter((x) => K.picked.has(kId(x))).map((x) => ({ type: x.type, id: x.id })), tok = K.estTok = (K.estTok || 0) + 1;
    K.est = null; paintRev();
    try { const e = await api.post('/api/storage/shrink-estimate', { items }); if (tok === K.estTok) { K.est = e; paintRev(); } }
    catch (err) { if (tok === K.estTok) { K.est = { parts: null, could: {} }; K.result = 'Could not measure them: ' + errText(err); paintRev(); } }
  }
  function kOpen(key) {
    K.rev = K.rev === key ? null : key; K.age = 0; K.ask = false; K.result = ''; K.picked = new Set();
    for (const x of kRevItems()) if (!x.pinned) K.picked.add(kId(x));
    paintStore();
  }
  async function loadStore(fresh) {
    if (K.busy || K.loading) return;
    K.loading = true;
    if (fresh) K.data = null;
    paintStore();
    try { K.data = await api.get('/api/storage' + (fresh ? '?fresh=1' : '')); K.err = null; } catch (e) { K.err = e; }
    K.loading = false;
    paintStore();
  }
  async function kGo() {
    const items = kRevItems().filter((x) => K.picked.has(kId(x))).map((x) => ({ type: x.type, id: x.id })), shrink = K.ask === 'shrink';
    K.busy = true; paintRev();
    try {
      const r = await api.post(shrink ? '/api/storage/shrink' : '/api/storage/delete', shrink ? { items, parts: K.parts, confirm: true } : { items, confirm: true });
      K.result = (shrink ? `Shrunk ${r.done}: ${fmtBytes(r.bytes)} saved. Empty the Recycle Bin to free the space.` : `Moved ${r.done} to the Recycle Bin (${fmtBytes(r.bytes)}).`)
        + (r.failed && r.failed.length ? ` Not moved: ${r.failed.length} (${r.failed.slice(0, 3).map((f) => (f.name || f.id) + ': ' + f.error).join('; ')}${r.failed.length > 3 ? '; ...' : ''}).` : '');
    } catch (err) { K.result = (shrink ? 'Could not shrink them: ' : 'Could not move them: ') + errText(err); }
    K.busy = false; K.ask = false; K.picked = new Set();
    const keep = K.result; await loadStore(true); K.result = keep; paintRev();
  }

  /* ---------- local model speed (services/localPerf.js): every answer of a local model, from llama-server's own timings,
     and the benchmark. A PC without a local model of its own shows the linked PC's. ---------- */
  const P = { data: null, err: null, model: null, range: '7d', kind: 'w', hover: null, geo: null, starting: false, again: null };
  const P_SPAN = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity };
  const tps = (v) => (v == null ? 'n/a' : (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' t/s');
  const kTok = (n) => { n = num(n); return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n); };
  const pModel = () => { const ms = (P.data && P.data.models) || []; return ms.find((m) => m.id === P.model) || ms[0] || null; };
  const setLine = (s) => (s ? [s.quant, s.ctx ? 'up to ' + kTok(s.ctx) + ' context' : null, 'KV cache ' + s.kv, s.draft ? 'Draft ' + s.draft : 'No draft model'].filter(Boolean).join(' · ') : '');
  const pWhen = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  /* the answers of the range: [time, write t/s, written, read t/s, read, context, draft %] */
  const pPts = (m) => { const t0 = Date.now() - P_SPAN[P.range]; return m.points.filter((p) => p[0] >= t0); };
  /* speed by tokens over a list of answers (a long answer counts more than a short one) */
  function pAvg(pts, i) { let tok = 0, s = 0; for (const p of pts) if (p[i] != null) { tok += p[i + 1]; s += p[i + 1] / p[i]; } return { tps: s ? tok / s : null, tok }; }
  function perfTiles(m) {
    const pts = pPts(m), w = pAvg(pts, 1), r = pAvg(pts, 3), d = pts.filter((p) => p[6] != null);
    const b = (m.bench || []).find((x) => x.kind !== 'real' && !x.error && x.tests.length), bw = b && b.tests.find((t) => t.id === 'w512');
    return tile('Writing speed', tps(w.tps), `${pts.length.toLocaleString('en-US')} answers · ${kTok(w.tok)} tokens`)
      + tile('Reading speed', tps(r.tps), `${kTok(r.tok)} tokens read`)
      + tile('Speculative decoding', m.settings && m.settings.draft ? 'On' : 'Off', d.length ? Math.round(d.reduce((n, p) => n + p[6], 0) / d.length) + '% of drafts accepted' : m.settings && m.settings.draft ? 'No answer yet' : 'No draft model')
      + tile('Last benchmark', bw ? tps(bw.writeTps) : 'None', b ? pWhen(b.startedAt) : 'Not run yet');
  }
  const verOf = (st) => (st ? st.label || ((st.quant || st.model || '') + (st.draft ? ' + MTP' : '')) : 'n/a');
  const BENCH_COLS = [['w512', 'Short prompt'], ['r4k', '4K prompt'], ['r16k', '16K prompt'], ['r32k', '32K prompt']];
  const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  /* real work: the translations and the replies, one at a time or several at once */
  function realHtml(m) {
    const runs = (m.bench || []).filter((r) => r.kind === 'real');
    if (!runs.length) return '';
    return `<div class="sect-h">Real work: 24 short prompts, 2 long replies, thinking off</div><div class="tbl sys-real"><div class="tr hd"><span>When</span><span>Version</span><span>How</span><span>Short prompts</span><span>Long replies</span><span>Drafts accepted</span></div>`
      + runs.map((r) => {
        const head = `<span>${esc(pWhen(r.startedAt))}</span><span class="ellip" title="${esc(setLine(r.settings))}">${esc(verOf(r.settings))}${r.vramMB ? `<small class="faint">${kTok(r.ctx)} · ${gbOf(r.vramMB)}</small>` : ''}</span><span>${r.slots > 1 ? r.slots + ' at once' : 'One at a time'}</span>`;
        if (r.error) return `<div class="tr">${head}<span class="sys-berr">${MC.st('fail', 'Stopped')}<span class="ellip" title="${esc(r.error)}">${esc(r.error)}</span></span></div>`;
        const t = r.groups.translate, w = r.groups.write, d = [t, w].filter((g) => g && g.draftRate != null);
        const cell = (g) => (g ? `<span class="mono" title="${g.outTok} tokens written">${secs(g.wallMs)}<small>${secs(g.avgMs)} wait each · ${tps(g.writeTps)}</small></span>` : '<span class="faint">n/a</span>');
        return `<div class="tr">${head}${cell(t)}${cell(w)}<span class="mono">${d.length ? d.map((g) => g.draftRate + '%').join(' · ') : '<span class="faint">No MTP</span>'}</span></div>`;
      }).join('') + '</div>';
  }
  function benchHtml(m) {
    const runs = (m.bench || []).filter((r) => r.kind !== 'real');
    if (!runs.length) return '';
    return `<div class="sect-h">Raw speed</div><div class="tbl sys-bench"><div class="tr hd"><span>When</span><span>Version</span>${BENCH_COLS.map(([, l]) => `<span>${l}</span>`).join('')}</div>`
      + runs.map((r) => {
        if (r.error) return `<div class="tr"><span>${esc(pWhen(r.startedAt))}</span><span class="ellip">${esc(verOf(r.settings))}</span><span class="sys-berr">${MC.st('fail', 'Stopped')}<span class="ellip" title="${esc(r.error)}">${esc(r.error)}</span></span></div>`;
        const cell = (id) => { const t = r.tests.find((x) => x.id === id); if (!t) return '<span class="faint">n/a</span>'; return id === 'w512' ? `<span class="mono">${tps(t.writeTps)}</span>` : `<span class="mono" title="Reading, then writing">${tps(t.readTps)}<small>${tps(t.writeTps)}</small></span>`; };
        const ctx = r.settings && r.settings.ctx;
        return `<div class="tr"><span>${esc(pWhen(r.startedAt))}</span><span class="ellip" title="${esc(setLine(r.settings))}${r.build ? ' · ' + esc(r.build) : ''}">${esc(verOf(r.settings))}${ctx ? `<small class="faint">${kTok(ctx)}${r.vramMB ? ' · ' + gbOf(r.vramMB) : ''}</small>` : ''}</span>${BENCH_COLS.map(([id]) => cell(id)).join('')}</div>`;
      }).join('') + '</div>';
  }
  function sessHtml(m) {
    const list = (m.sessions || []).slice(0, 10);
    if (!list.length) return '';
    return `<div class="sect-h">Each start of the model</div><div class="tbl sys-sess"><div class="tr hd"><span>Started</span><span class="hs">Settings</span><span class="hs">VRAM</span><span>Answers</span><span>Writing</span><span>Reading</span><span class="hs">Written</span></div>`
      + list.map((s) => `<div class="tr"><span>${esc(pWhen(s.at))}</span><span class="hs faint ellip">${esc(setLine(s.settings))}</span><span class="mono hs">${s.vram ? gbOf(s.vram.ownMB) : 'n/a'}</span><span class="mono">${num(s.answers).toLocaleString('en-US')}</span><span class="mono">${tps(s.writeTps)}</span><span class="mono">${tps(s.readTps)}</span><span class="mono hs">${kTok(s.written)}</span></div>`).join('') + '</div>';
  }
  function paintPerf() {
    if (!el) return;
    const card = el.querySelector('[data-perf]'); if (!card) return;
    const d = P.data, m = pModel(), bn = d && d.benching;
    card.hidden = !!(d && !d.models.length) && !P.err;
    setPart('pfor', d ? [m && m.label, d.machine].filter(Boolean).join(' on ') : '');
    const go = el.querySelector('[data-bench]');
    if (go) { go.disabled = !m || !!bn || P.starting; go.textContent = bn || P.starting ? 'Running' : 'Run benchmark'; }
    if (!d || !m) { setPart('ptiles', ''); setPart('pinfo', P.err ? empty('Could not read the speeds: ' + errText(P.err), true) : empty('Reading')); setPart('ptabs', ''); drawPerf(); return; }
    setPart('ptiles', perfTiles(m));
    setPart('pinfo', `<div class="sys-pset">${esc(setLine(m.settings))}</div>`
      + (m.ranWith ? `<div class="sys-pset faint">From its next start. It last ran with ${esc(setLine(m.ranWith))}</div>` : '')
      + (m.lastStart && m.lastStart.vram ? `<div class="sys-pset">Last start: ${kTok(m.lastStart.ctx)} context, ${gbOf(m.lastStart.vram.ownMB)} on the card, ${gbOf(m.lastStart.vram.afterMB)} of ${gbOf(m.targetMB)} in all</div>` : '')
      + (m.warn ? `<div class="sys-pwarn">${I('warn', 'sm')}<span>${esc(m.warn)}</span></div>` : '')
      + (bn ? `<div class="sys-rl">${MC.st('run', 'Benchmark')}<span>${bn.vof > 1 ? `Part ${bn.vstep} of ${bn.vof}, ` : ''}${esc(bn.version || '')}. ${esc(bn.label)}${bn.of ? ` (${bn.step} of ${bn.of})` : ''}</span></div>` : ''));
    setPart('ptabs', realHtml(m) + benchHtml(m) + sessHtml(m));
    el.querySelectorAll('[data-pr]').forEach((b) => b.classList.toggle('on', b.dataset.pr === P.range));
    el.querySelectorAll('[data-pk]').forEach((b) => b.classList.toggle('on', b.dataset.pk === P.kind));
    drawPerf();
  }
  async function loadPerf() {
    clearTimeout(P.again);
    try { P.data = await api.get('/api/local-models/perf'); P.err = null; } catch (e) { P.err = e; }
    paintPerf();
    /* while a benchmark runs (here or on the linked PC), its steps are read again every few seconds */
    if (P.data && P.data.benching && shown()) P.again = setTimeout(loadPerf, 3000);
  }
  /* one version, or all of them one after the other (every model file in the model's folder) */
  async function benchRun(m, ids, kind) {
    const vs = (m.versions || []).filter((v) => ids.includes(v.id)), names = vs.map((v) => v.label).join(', ') || m.label;
    const what = kind === 'raw' ? 'raw speed test' : 'real work test';
    if (!(await MC.askYes(`Run the ${what} of ${names}?`, `About ${kind === 'raw' ? 2 : 1} minute${kind === 'raw' ? 's' : ''} for each. ${m.label} stops for other work while it runs.`, 'Run'))) return;
    P.starting = true; paintPerf();
    try { await api.post('/api/local-models/bench', { model: m.id, versions: ids, kind }); } catch (e) { showMsg(false, 'The benchmark did not start: ' + errText(e)); }
    P.starting = false;
    await loadPerf();
  }
  function benchClick(b) {
    const m = pModel(); if (!m) return;
    const vs = m.versions || [];
    const gb = (v) => (v.bytes ? (v.bytes / 1e9).toFixed(1) + ' GB' : '') + (v.current ? ' · in use' : '');
    const part = (kind, h) => [{ h }, ...(vs.length > 1 ? [{ id: kind + '|*', label: 'All versions', sub: vs.length + ' in a row' }] : []), ...vs.map((v) => ({ id: kind + '|' + v.id, label: v.label, sub: gb(v) }))];
    MC.menu(b, [...part('real', 'Real work, one at a time and 4 at once'), { sep: true }, ...part('raw', 'Raw speed')], (id) => {
      const i = id.indexOf('|'), kind = id.slice(0, i), v = id.slice(i + 1);
      benchRun(m, v === '*' ? vs.map((x) => x.id) : [v], kind);
    }, { alignRight: true });
  }
  function drawPerf() {
    if (!el) return;
    const cv = el.querySelector('canvas[data-pc]'), none = el.querySelector('[data-pnone]'), card = el.querySelector('[data-pcard]');
    if (!cv) return;
    const m = pModel(), i = P.kind === 'w' ? 1 : 3, pts = m ? pPts(m).filter((p) => p[i] != null) : [];
    none.hidden = pts.length > 0;
    const [x, W, Hh] = fit(cv); x.clearRect(0, 0, W, Hh);
    if (!pts.length) { none.textContent = P.data ? 'No answer in this range' : 'Reading'; card.hidden = true; P.geo = null; return; }
    if (!W || !Hh) return;
    const k = parseFloat(css('--k')) || 1, mono = css('--mono');
    const cText = css('--text'), cGrid = css('--line'), cLab = css('--text-3'), cBg = css('--panel');
    const pl = 64 * k, pr = 12 * k, pt = 14 * k, pb = 26 * k, pw = W - pl - pr, ph = Hh - pt - pb;
    const t1 = Date.now(), t0 = P.range === 'all' ? pts[0][0] : t1 - P_SPAN[P.range];
    const ymax = Math.max(1, ...pts.map((p) => p[i])) * 1.15;
    const X = (t) => pl + (t - t0) / Math.max(1, t1 - t0) * pw, Y = (v) => pt + ph - v / ymax * ph;
    x.font = `${12 * k}px ${mono}`; x.textBaseline = 'middle'; x.textAlign = 'right';
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => s >= ymax / 4) || 5000;
    for (let v = 0; v <= ymax; v += step) {
      x.strokeStyle = cGrid; x.lineWidth = 1; x.beginPath(); x.moveTo(pl, Math.round(Y(v)) + .5); x.lineTo(W - pr, Math.round(Y(v)) + .5); x.stroke();
      x.fillStyle = cLab; x.fillText(v + ' t/s', pl - 8, Y(v));
    }
    /* x axis: hours on a day, dates beyond */
    const span = t1 - t0, day = span > 1.5 * 864e5;
    x.textAlign = 'center'; x.textBaseline = 'top';
    const ticks = 6;
    for (let j = 0; j <= ticks; j++) {
      const t = t0 + span * j / ticks, px = X(t); if (px < pl + 20 || px > W - pr - 20) continue;
      x.fillStyle = cLab; x.fillText(day ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : hh(t), px, pt + ph + 8);
    }
    /* one dot per answer, a bigger dot for a longer one, and the average of the last ten as a line */
    x.fillStyle = cText;
    for (const p of pts) { x.globalAlpha = .35; x.beginPath(); x.arc(X(p[0]), Y(p[i]), Math.min(4, 1.5 + Math.log10(Math.max(1, p[i + 1])) * .8) * k, 0, 7); x.fill(); }
    x.globalAlpha = 1; x.strokeStyle = cText; x.lineWidth = 1.8; x.lineJoin = 'round'; x.beginPath();
    pts.forEach((p, j) => { const w = pts.slice(Math.max(0, j - 9), j + 1), a = pAvg(w, i).tps; if (a == null) return; const px = X(p[0]), py = Y(a); if (j) x.lineTo(px, py); else x.moveTo(px, py); });
    x.stroke();
    P.geo = { pl, pw, t0, t1, pts };
    if (P.hover != null && pts[P.hover]) {
      const p = pts[P.hover], px = X(p[0]), py = Y(p[i]);
      x.fillStyle = cText; x.strokeStyle = cBg; x.lineWidth = 2; x.beginPath(); x.arc(px, py, 5 * k, 0, 7); x.stroke(); x.fill();
      card.innerHTML = `<b>${esc(pWhen(new Date(p[0]).toISOString()))}</b><div class="u">Writing ${tps(p[1])} · ${num(p[2])} tokens</div><div class="u">Reading ${tps(p[3])} · ${num(p[4])} tokens</div>${p[5] ? `<div class="u">Context ${kTok(p[5])}</div>` : ''}${p[6] != null ? `<div class="u">Drafts accepted ${p[6]}%</div>` : ''}`;
      card.hidden = false;
      const cw = card.offsetWidth; card.style.left = Math.max(0, Math.round(px + 14 + cw > W ? px - 14 - cw : px + 14)) + 'px';
    } else card.hidden = true;
  }
  function bindPerf() {
    const cv = el.querySelector('canvas[data-pc]'), box = el.querySelector('.sys-pchart');
    cv.addEventListener('pointermove', (ev) => {
      const g = P.geo; if (!g) return;
      const r = cv.getBoundingClientRect(), t = g.t0 + (ev.clientX - r.left - g.pl) / g.pw * (g.t1 - g.t0);
      let best = 0; g.pts.forEach((p, j) => { if (Math.abs(p[0] - t) < Math.abs(g.pts[best][0] - t)) best = j; });
      if (best !== P.hover) { P.hover = best; drawPerf(); }
    });
    cv.addEventListener('pointerleave', () => { P.hover = null; drawPerf(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (shown()) drawPerf(); }).observe(box);
  }

  /* ---------- data ---------- */
  async function loadSys() { try { S.sys = await api.get('/api/system'); S.err = null; } catch (e) { S.err = e; } }
  async function loadServers() { try { S.servers = await api.get('/api/servers' + (S.all ? '?all=1' : '')); } catch (e) { S.err = e; } }
  async function loadEngines() { try { S.engines = await api.get('/api/engines'); } catch (e) { /* keep the last list */ } }
  async function loadAll() { await Promise.all([loadSys(), loadServers(), loadEngines()]); paintAll(); }

  /* ---------- painting ---------- */
  function paintGpu() {
    if (el) {
      setPart('gpu', gpuHtml());
      setPart('pc', S.sys ? String((S.sys.gpuProcs || []).length) + ' processes' : '');
      paintRoom();
    }
    MC.emit('rerender', 'system');
  }
  function paintSys() {
    if (!el) return;
    setPart('tiles', tilesHtml());
    setPart('ram', ramHtml());
    setPart('rc', S.sys ? 'Top ' + (S.sys.topRam || []).length : '');
    paintHealth();
    redrawBar();
  }
  function paintSrv() {
    if (!el) return;
    setPart('srv', srvHtml());
    const list = S.servers ? S.servers.filter((s) => S.all || s.isDev || s.isSelf) : null;
    setPart('sc', list ? String(list.length) : '');
    const t = el.querySelector('[data-allp]'); if (t) { t.classList.toggle('on', S.all); t.setAttribute('aria-checked', S.all); }
  }
  function paintAll() { paintSys(); paintGpu(); paintSrv(); paintMsg(); }

  /* ---------- the page ---------- */
  const SKELETON = () => `<div class="sys-tiles tiles" data-p="tiles"></div>
    <div class="card sys-msg" data-p="msg" role="status" hidden></div>
    <div class="card c8"><h3>VRAM history<span class="grow"></span><span class="seg sys-seg" role="group" aria-label="Range">${['1h', '6h', '24h'].map((r) => `<button data-hr="${r}">${r}</button>`).join('')}</span></h3>
      <div class="sys-chart"><canvas data-hc></canvas><div class="none" data-hnone>Reading history</div><div class="sys-vcard" data-vcard hidden></div></div></div>
    <div class="card c4 sys-room"><h3>Make room<span class="grow"></span></h3>
      <div class="sys-need"><span>I need</span><b><span data-p="needv">--</span><small>GB</small></b></div>
      <input type="range" data-need min="0" max="24" step="0.5" value="${S.need}" aria-label="GB of VRAM needed">
      <div data-p="room"></div></div>
    <div class="card sys-perf" data-perf><h3>Local model speed<span class="faint" data-p="pfor"></span><span class="grow"></span>
      <span class="seg sys-seg" role="group" aria-label="Speed">${[['w', 'Writing'], ['r', 'Reading']].map(([k, l]) => `<button data-pk="${k}">${l}</button>`).join('')}</span>
      <span class="seg sys-seg" role="group" aria-label="Range">${['24h', '7d', '30d', 'all'].map((r) => `<button data-pr="${r}">${r === 'all' ? 'All' : r}</button>`).join('')}</span>
      <button class="btn sm" data-bench>Run benchmark</button></h3>
      <div class="tiles sys-ptl" data-p="ptiles"></div><div data-p="pinfo"></div>
      <div class="sys-chart sys-pchart"><canvas data-pc></canvas><div class="none" data-pnone>Reading</div><div class="sys-vcard" data-pcard hidden></div></div>
      <div data-p="ptabs"></div></div>
    <div class="card c6"><h3>VRAM by process<span class="grow"></span><span class="faint" data-p="pc"></span></h3><div class="tbl sys-proc" data-p="gpu"></div></div>
    <div class="card c6"><h3>RAM by process<span class="grow"></span><span class="faint" data-p="rc"></span></h3><div class="tbl sys-proc" data-p="ram"></div></div>
    <div class="card c8"><h3>Dev servers<span class="grow"></span><span class="faint" data-p="sc"></span><span class="sys-allp">Every port<span class="tog" data-allp role="switch" tabindex="0" aria-checked="false"></span></span></h3><div class="tbl sys-srv" data-p="srv"></div></div>
    <div class="card c4"><h3>GPU health<span class="grow"></span></h3>
      <div class="sys-gauges">${[['T', 'Temp'], ['L', 'Load'], ['M', 'VRAM']].map(([k, l]) => `<div class="sys-gauge"><canvas data-gc="${k}"></canvas><b data-g="${k}">--</b><span class="faint">${l}</span></div>`).join('')}</div>
      <div class="sys-kv"><span class="faint">GPU</span><span data-g="name">--</span><span class="faint">Driver</span><span class="mono" data-g="driver">--</span><span class="faint">CUDA</span><span class="mono" data-g="cuda">--</span></div></div>
    <div class="card"><h3>Builds and scratch files<span class="grow"></span><span class="faint mono" data-p="tsub"></span><span class="sys-sum mono" data-p="tc"></span>
      <button class="btn sm ghost pc-only" data-topen>${I('folder', 'sm')}Show in Explorer</button><button class="btn sm" data-tre>${I('refresh', 'sm')}Measure again</button></h3><div class="tbl sys-temp" data-p="temp"></div></div>
    <div class="card"><h3>Conversations and attachments<span class="grow"></span><span class="sys-sum mono" data-p="kc"></span><button class="btn sm" data-kre>${I('refresh', 'sm')}Measure again</button></h3>
      <div class="tbl sys-temp" data-p="store"></div><div class="sys-rev" data-p="rev" hidden></div></div>`;

  async function stopClick(b) {
    const pid = +b.dataset.pid, name = b.dataset.name, port = b.dataset.port, q = b.dataset.quiet;
    const body = (port ? `Port ${port}, pid ${pid}.` : `Pid ${pid}.`) + (q === 'free' ? ' Its loaded models will be lost, Free is the safe way.' : q ? ' Its models will be lost, Unload is the safe way.' : '');
    if (!(await MC.askYes(`Stop ${name}?`, body, 'Stop'))) return;
    S.stopping = b.dataset.stop; paintGpu(); paintSys(); paintSrv();
    try { await api.post('/api/processes/' + pid + '/kill', { confirm: true }); showMsg(true, `Stopped ${name}${port ? ' on port ' + port : ''} (pid ${pid}).`); }
    catch (e) { showMsg(false, errText(e)); }
    S.stopping = null;
    await loadAll();
  }
  async function tempDelete(b) {
    const path = b.dataset.tdel, name = b.dataset.name, bytes = +b.dataset.bytes;
    if (!(await MC.askYes(`Delete ${name}?`, `${fmtBytes(bytes)}. It cannot be undone.`, 'Delete'))) return;
    T.deleting = path; paintTemp();
    try { await api.post('/api/temp/delete', { path, confirm: true }); showMsg(true, `Deleted ${name}, ${fmtBytes(bytes)} freed.`); }
    catch (e) { showMsg(false, errText(e)); }
    T.deleting = null;
    await loadTemp(false);
  }

  function bind() {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button, [data-allp]'); if (!b || b.disabled) return;
      if (await unloadClick(b)) return;
      if (b.dataset.stop) { if (!S.stopping) stopClick(b); return; }
      if (b.dataset.tdel) { if (!T.deleting) tempDelete(b); return; }
      if (b.hasAttribute('data-rgo')) { runPlan(); return; }
      if (b.hasAttribute('data-bench')) { benchClick(b); return; }
      if (b.dataset.pr) { P.range = b.dataset.pr; P.hover = null; paintPerf(); return; }
      if (b.dataset.pk) { P.kind = b.dataset.pk; P.hover = null; paintPerf(); return; }
      if (b.hasAttribute('data-msgx')) { showMsg(null); return; }
      if (b.dataset.hr) { if (b.dataset.hr === H.range) return; H.range = b.dataset.hr; H.data = null; H.hover = null; paintRange(); drawHist(); loadHist(); return; }
      if (b.hasAttribute('data-allp')) { S.all = !S.all; S.servers = null; paintSrv(); await loadServers(); paintSrv(); return; }
      if (b.dataset.proj) { MC.setProject(b.dataset.proj); return; }
      if (b.hasAttribute('data-tre')) { loadTemp(true); return; }
      if (b.hasAttribute('data-topen')) { if (T.data && T.data.root) api.post('/api/path/reveal', { path: T.data.root }).catch((er) => showMsg(false, 'Could not open Explorer: ' + errText(er))); return; }
      if (b.hasAttribute('data-kre')) { loadStore(true); return; }
      if (b.dataset.krev) { kOpen(b.dataset.krev); return; }
      const k = b.dataset.k; if (!k) return;
      if (k === 'age') { MC.menu(b, K_AGES.map(([v, l]) => ({ id: v, label: l, on: v === K.age })), (v) => { K.age = +v; K.ask = false; K.picked = new Set(kRevItems().filter((x) => !x.pinned).map(kId)); paintRev(); }); return; }
      if (k === 'all') { const its = kRevItems(), all = its.every((x) => K.picked.has(kId(x))); K.picked = all ? new Set() : new Set(its.map(kId)); K.ask = false; paintRev(); return; }
      if (k === 'del') {
        const its = kRevItems().filter((x) => K.picked.has(kId(x)));
        K.result = ''; K.ask = true;
        if (await MC.askYes(`Move ${its.length} to the Recycle Bin?`, fmtBytes(kSum(its)), 'Move them')) await kGo(); else { K.ask = false; paintRev(); }
        return;
      }
      if (k === 'shrink') { K.ask = 'shrink'; K.result = ''; kMeasure(); return; }
      if (k === 'no') { K.ask = false; paintRev(); return; }
      if (k === 'yes') { kGo(); }
    });
    el.addEventListener('keydown', (e) => { const t = e.target.closest('[data-allp]'); if (t && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); t.click(); } });
    el.addEventListener('input', (e) => {
      if (!e.target.matches('[data-need]')) return;
      S.need = +e.target.value; if (S.msg && S.msg.plan) showMsg(null);
      try { localStorage.setItem('mc.need', S.need); } catch (er) { /* no storage */ }
      paintRoom();
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.kpart) { K.parts[t.dataset.kpart] = t.checked; paintRev(); return; }
      const k = t.dataset.kit; if (!k) return;
      if (t.checked) K.picked.add(k); else K.picked.delete(k);
      if (K.ask === 'shrink') kMeasure(); else { K.ask = false; paintRev(); }
    });
    bindChart();
    bindPerf();
  }

  /* the page shell calls this each time System is shown */
  MC.drawPage.system = (target) => {
    el = target;
    if (!el._sys) { el._sys = true; el.innerHTML = SKELETON(); bind(); }
    paintRange(); paintAll(); paintTemp(); paintStore(); drawHist(); paintPerf();
    loadAll(); loadHist(); loadTemp(false); loadStore(false); loadPerf();
  };
  MC.pageBar.system = () => ({ sub: barSub(), html: `<button class="ibtn" data-sysbar="refresh" title="Read again">${I('refresh')}</button>` });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sysbar]'); if (!b) return;
    if (b.dataset.sysbar === 'refresh') { loadAll(); loadHist(); loadTemp(false); loadStore(false); loadPerf(); }
  });

  /* ---------- live: the server sends the numbers every 5 s while a page is connected ---------- */
  let slow = false;
  MC.events.on('system.tick', async (d) => {
    if (d && d.cpu) { S.sys = d; S.err = null; }
    const page = shown();
    if (page) { paintSys(); paintGpu(); } else if (panelLive()) MC.emit('rerender', 'system');
    /* engines and the port list are not in the tick: refresh them here, never overlapping */
    S.ticks++;
    if (slow || S.stopping || !(page || panelLive())) return; slow = true;
    try { await loadEngines(); if (page && S.ticks % 3 === 0) await loadServers(); if (shown()) { paintSrv(); paintGpu(); } else MC.emit('rerender', 'system'); } finally { slow = false; }
  });
  MC.events.on('system.changed', () => { if (shown() || panelLive()) loadAll(); });
  setInterval(() => { if (shown()) { loadHist(); if (!(P.data && P.data.benching)) loadPerf(); } }, 30000);
  document.addEventListener('visibilitychange', () => { if (shown()) loadHist(); });
  MC.on('theme', () => { if (shown()) { drawHist(); paintHealth(); drawPerf(); } });
  MC.on('size', () => { if (shown()) { drawHist(); paintHealth(); drawPerf(); } });

  /* ---------- the Home panel: GPU and RAM ---------- */
  let panelLoad = false;
  M.system = {
    label: 'GPU and RAM', icon: 'cpu',
    render: () => {
      panel();
      if (!S.sys && !panelLoad) { panelLoad = true; loadAll().finally(() => { panelLoad = false; }); }
      else if (!S.engines && !panelLoad) { panelLoad = true; loadEngines().then(() => MC.emit('rerender', 'system')).finally(() => { panelLoad = false; }); }
      const d = S.sys;
      if (!d) return S.err ? `<div class="use">${empty('Could not read this PC: ' + errText(S.err), true)}</div>` : `<div class="use"><div class="lv-empty">${I('loader', 'sm')}Reading this PC</div></div>`;
      const g = d.gpu || {}, tot = g.vramTotalGB ? g.vramTotalGB * 1024 : 0, cp = comfyPid();
      const list = (d.gpuProcs || []).filter((p) => p.vramMB != null).sort((a, b) => b.vramMB - a.vramMB);
      const top = list.filter((p, i) => i < 6 || (p.models || []).length || p.pid === cp);
      const rows = top.map((p) => {
        const isComfy = cp != null && p.pid === cp;
        const head = `<div class="meter"><div class="row"><b class="ellip">${pname(p)}</b><span>${fmtMB(p.vramMB)}</span>${isComfy ? unloadBtn(KEY_COMFY, 'data-free="1"', 'Free', 'Freeing...') : ''}</div>${tot ? bar(p.vramMB / tot, p.vramMB / tot > .25) : ''}${isComfy ? errHtml(KEY_COMFY) : ''}</div>`;
        const mods = (p.models || []).map((m) => { const key = keyM(m.engine, m.id); return `<div class="row sys-pm"><span class="grow ellip" title="${esc(m.id)}">${esc(m.label || m.id)}</span><span class="faint mono">${m.vramMB != null ? fmtMB(m.vramMB) : ''}</span>${m.canUnload ? unloadBtn(key, `data-unl="1" data-eng="${esc(m.engine)}" data-model="${esc(m.id)}"`, 'Unload', 'Unloading...') : '<span class="faint">No safe unload</span>'}</div>${errHtml(key)}`; }).join('');
        return head + mods;
      }).join('');
      return `<div class="use"><div class="tiles sys-ptiles">${tilesHtml()}</div><div><div class="sect-h">VRAM by process<span class="grow"></span></div><div class="sys-pmeters">${rows || empty('No processes are using the GPU')}</div></div></div>`;
    },
    mount: (body) => { body.onclick = async (e) => { const b = e.target.closest('button'); if (b && !b.disabled) await unloadClick(b); }; },
  };
})();
