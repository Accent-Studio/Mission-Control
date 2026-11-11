/* Mission Control 2: the Connections page on real data, ported from today's Connections page (connections.html).
   AI services (which keys sit in the Windows vault, a test per service), local apps (ComfyUI), local models (this PC's and
   the linked PC's, with a test request), MCP servers from the Claude
   settings, the linked computer (both directions, and linking back), paired phones (the bridge, pairing with a QR code, rename and remove), and the hub (the link, its pairing, a phone
   paired with the hub, and what the sync is doing). Loads after panels.js, which gives MC.askText and MC.askYes. */
(() => {
  const { esc, icon: I } = MC;
  const api = MC.api, enc = encodeURIComponent;
  const errText = (e) => (e && e.data && e.data.error) || (e && e.message) || 'No answer';

  /* ST.conn: GET /api/connections; ST.local: the local apps; ST.dv: the devices; ST.hub: GET /api/hub-link */
  const ST = { conn: null, connErr: null, local: null, localErr: null, lm: null, lmErr: null, lmTests: {}, hub: null, hubErr: null, hubBusy: false, hubPhone: null, tests: {} };
  const dv = { view: null, failed: false, pair: null, opening: false, restarting: false, note: null, seq: 0 };
  let el = null, timer = 0, ticks = 0;

  const shown = () => !!(el && el.isConnected && el.offsetParent);
  /* the bridge, the hub and a few buttons only make sense at the PC (V1 hides them as .pc-only) */
  const atPc = () => { const h = document.documentElement; return !(MC.remote === true || MC.hub || h.hasAttribute('data-remote') || h.hasAttribute('data-hub')); };
  const abbr = (n) => { const w = String(n).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : String(n).slice(0, 2)).toUpperCase(); };
  const cmd = (s) => 'cmdkey /generic:' + (s.credentialTarget || 'MissionControl:' + s.id) + ' /user:api /pass';
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (isNaN(s)) return '';
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const dateOf = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const left = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60), r = s % 60; return m ? m + ' min' + (r ? ' ' + r + 's' : '') : r + 's'; };
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  async function copy(text, btn, label) {
    try { await navigator.clipboard.writeText(text); btn.lastChild.textContent = 'Copied'; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); btn.lastChild.textContent = 'Copied'; } catch (e2) { btn.lastChild.textContent = 'Copy failed'; }
      ta.remove();
    }
    setTimeout(() => { if (btn.isConnected) btn.lastChild.textContent = label; }, 1800);
  }
  const copyBtn = (attr, label) => `<button class="btn sm" ${attr}>${I('copy', 'sm')}<span>${label}</span></button>`;

  /* ---------- the QR code: vendor/qrcodegen.js, loaded the first time a code shows ---------- */
  let qrLib = null;
  const loadQr = () => qrLib || (qrLib = new Promise((ok, no) => {
    if (window.qrcodegen) { ok(); return; }
    const s = document.createElement('script'); s.src = '/vendor/qrcodegen.js';
    s.onload = () => ok(); s.onerror = () => { qrLib = null; no(new Error('The QR code library did not load')); };
    document.head.appendChild(s);
  }));
  function qrSvg(text) {
    if (!window.qrcodegen) return '';
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    const q = 2, n = qr.size, w = n + 2 * q; /* two light modules around the code, as few as scanners need */
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.getModule(x, y)) d += 'M' + (x + q) + ',' + (y + q) + 'h1v1h-1z';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${w}" height="${w}" fill="#e2e9f0"/><path d="${d}" fill="#0a1019"/></svg>`;
  }
  const qrBlock = (uri, code) => `<div class="cn-qr"><span class="cn-qrbox">${qrSvg(uri)}</span><div class="cn-code" aria-label="Pairing code">${esc(code)}</div></div>`;

  /* ---------- the page frame: each part draws into its own box, so a refresh of one leaves the others (and a field being typed) alone ---------- */
  function frame() {
    el.innerHTML = `<div class="sgroup">AI services</div><div class="svcs" data-cn="svc"></div>`
      + `<div class="sgroup">Local apps</div><div class="svcs" data-cn="local"></div>`
      + `<div class="sgroup">Local models</div><div class="svcs" data-cn="lm"></div>`
      + `<div class="sgroup">MCP servers</div><div class="card"><h3>Configured servers<span class="grow"></span><span class="faint" data-cn="mcpn"></span></h3><div data-cn="mcp"></div></div>`
      + `<div class="sgroup">Devices</div><div class="card"><h3>Linked computer<span class="grow"></span><span data-cn="pcst"></span></h3><div data-cn="pc"></div></div>`
      + `<div class="card"><h3>Paired phones<span class="grow"></span><span class="faint" data-cn="dvn"></span></h3><div data-cn="dv"></div></div>`
      + (atPc() ? `<div class="card"><h3>Hub<span class="grow"></span><span data-cn="hbst"></span></h3><div data-cn="hb"></div><div data-cn="hbsync"></div></div>` : '');
  }
  const box = (k) => el && el.querySelector(`[data-cn="${k}"]`);
  const set = (k, html) => { const b = box(k); if (b && b._html !== html) { b._html = html; b.innerHTML = html; } };
  const faint = (t) => `<div class="lv-empty">${esc(t)}</div>`;
  const loading = (t) => `<div class="lv-empty">${I('loader', 'sm')}${esc(t)}</div>`;
  const bad = (t) => `<div class="lv-err">${I('xc', 'sm')}${esc(t)}</div>`;

  /* ---------- AI services and MCP servers ---------- */
  function keyState(s) {
    if (s.keyStored) return MC.st('done', 'Key stored');
    if (ST.conn.keyCheck === 'unavailable') return MC.st('warn', 'Could not check');
    return MC.st('idle', 'No key');
  }
  function svcCard(s) {
    const c = cmd(s), t = ST.tests[s.id];
    const res = !t ? '' : t.busy ? `<div class="cn-res">${I('loader', 'sm')}Testing</div>`
      : t.err ? `<div class="cn-res bad">${I('xc', 'sm')}${esc(t.err)}</div>`
      : `<div class="cn-res ${t.ok ? 'ok' : 'warn'}">${I(t.ok ? 'tick' : 'warn', 'sm')}${t.ok ? 'Works.' : 'Not working.'} ${esc(t.reason || '')}</div>`;
    return `<div class="svc ${!s.keyStored && ST.conn.keyCheck !== 'unavailable' ? 'off' : ''}"><div class="row cn-top"><span class="code">${esc(abbr(s.name))}</span><span class="nm grow ellip">${esc(s.name)}</span>${keyState(s)}</div>`
      + `<div class="cn-key">${I('lock', 'sm')}<code>${esc(c)}</code>${copyBtn(`data-copy="${esc(c)}"`, 'Copy')}</div>${res}`
      + `<div class="row cn-btns"><button class="btn sm" data-test="${esc(s.id)}" ${t && t.busy ? 'disabled' : ''}>${I('pulse', 'sm')}Test</button>`
      + (/^https?:\/\//i.test(s.docsUrl || '') ? `<a class="btn sm ghost" href="${esc(s.docsUrl)}" target="_blank" rel="noopener">${I('ext', 'sm')}Docs</a>` : '') + `</div></div>`;
  }
  function paintConn() {
    if (!el) return;
    if (!ST.conn) {
      const off = ST.connErr ? bad('Server offline. Connections cannot be read right now.') : loading('Loading');
      set('svc', off); set('mcp', ST.connErr ? bad('Server offline.') : loading('Loading MCP servers')); set('mcpn', ''); return;
    }
    const svc = ST.conn.services || [], mcp = ST.conn.mcp || [];
    set('svc', svc.length ? svc.map(svcCard).join('') : faint('No services are listed.'));
    set('mcpn', String(mcp.length));
    set('mcp', mcp.length ? `<div class="tbl cn-mcp"><div class="tr hd"><span>#</span><span>Name</span><span>Type</span><span>Command or host</span><span>Scope</span><span>Project</span></div>`
      + mcp.map((m, i) => `<div class="tr"><span class="mono faint">${String(i + 1).padStart(2, '0')}</span><b class="ellip">${esc(m.name)}</b><span class="mono">${esc(m.type)}</span><span class="mono ellip" title="${esc(m.host || m.command || '')}">${esc(m.host || m.command || 'Unknown')}</span><span class="mono">${esc(m.scope)}</span><span class="mono cn-wrap">${esc(m.project || 'All projects')}</span></div>`).join('') + `</div>`
      : faint('No MCP servers found in your Claude settings.'));
  }
  async function loadConn() {
    try { ST.conn = await api.get('/api/connections'); ST.connErr = null; } catch (e) { ST.connErr = errText(e); }
    paintConn(); if (MC.D) MC.D.drawBar();
  }
  MC.pageBar.connections = () => {
    if (!ST.conn) return { sub: ST.connErr ? 'Server offline' : 'Loading' };
    const keys = (ST.conn.services || []).filter((s) => s.keyStored).length, live = (ST.conn.mcp || []).filter((m) => m.scope !== 'not registered').length;
    return { sub: `${live + keys} connected (${plural(live, 'MCP server')}, ${plural(keys, 'key')})` };
  };

  /* ---------- local apps: ComfyUI ---------- */
  function comfyCard(a) {
    const on = a.running;
    let facts = '';
    if (on) {
      const used = a.vramUsedGB, tot = a.vramTotalGB, frac = tot ? used / tot : 0;
      facts = `<div class="cn-facts"><div>Running on port <b>${esc(a.port)}</b>${a.process && a.process.name ? ` (${esc(a.process.name)}, pid ${esc(a.process.pid)})` : ''}</div>`
        + `<div>Version <b>${esc(a.version || 'Unknown')}</b>${a.python ? ` (Python ${esc(a.python)})` : ''}</div>`
        + `<div>VRAM <b>${tot ? esc(used.toFixed(1)) + ' of ' + esc(tot.toFixed(1)) + ' GB used' : 'Unknown'}</b></div>`
        + (tot ? `<div class="bar ${frac > .9 ? 'warn' : ''}"><i style="width:${Math.min(100, Math.round(frac * 100))}%"></i></div>` : '')
        + `<div>Queue <b>${a.queue ? esc(a.queue.running) + ' running, ' + esc(a.queue.pending) + ' pending' : 'Unknown'}</b></div></div>`;
    }
    const btn = !atPc() ? '' : on ? `<a class="btn sm" href="http://127.0.0.1:${esc(a.port)}/" target="_blank" rel="noopener">${I('ext', 'sm')}Open in browser</a>` : `<button class="btn sm" disabled>${I('ext', 'sm')}Open in browser</button>`;
    return `<div class="svc ${on ? '' : 'off'}"><div class="row cn-top"><span class="code">CU</span><span class="nm grow ellip">ComfyUI</span>${on ? MC.st('done', 'Running') : MC.st('idle', 'Not running')}</div>${facts}${btn ? `<div class="row cn-btns">${btn}</div>` : ''}</div>`;
  }
  function paintLocal() {
    if (!el) return;
    if (!ST.local) { set('local', ST.localErr ? bad('Server offline. Local apps cannot be read right now.') : loading('Loading local apps')); return; }
    const html = ST.local.map((a) => (a.id === 'comfyui' ? comfyCard(a) : '')).join('');
    set('local', html || faint('No local apps are listed.'));
  }
  async function loadLocal() {
    try { const d = await api.get('/api/connections/local'); ST.local = (d && d.apps) || []; ST.localErr = null; } catch (e) { ST.local = null; ST.localErr = errText(e); }
    paintLocal();
  }

  /* ---------- local models: this PC's and the linked PC's (GET /api/models/local), each with a test request ---------- */
  function lmCard(m, where, online, gpu) {
    const key = where + '/' + m.id, t = ST.lmTests[key];
    const state = !online ? MC.st('fail', 'PC off') : m.loaded ? MC.st('done', 'Loaded') : MC.st('idle', 'Ready');
    const vram = gpu && gpu.vramTotalGB ? gpu.vramUsedGB / gpu.vramTotalGB : 0;
    const facts = `<div class="cn-facts"><div>Runs on <b>${esc(where)}</b>${online ? '' : ' (not reachable now)'}</div>`
      + `<div>Model <b>${esc(m.id)}</b>${m.ctx ? `, context <b>${esc(Math.round(m.ctx / 1024))}K</b>` : ''}</div>`
      + (online ? `<div>${m.loaded ? 'In graphics memory now' : 'Not in graphics memory: loads on first use'}</div>` : '')
      + (gpu ? `<div>${esc(gpu.name || 'Graphics card')} <b>${gpu.vramTotalGB ? esc(Number(gpu.vramUsedGB).toFixed(1)) + ' of ' + esc(Number(gpu.vramTotalGB).toFixed(1)) + ' GB used' : ''}</b></div>`
        + (gpu.vramTotalGB ? `<div class="bar ${vram > .9 ? 'warn' : ''}"><i style="width:${Math.min(100, Math.round(vram * 100))}%"></i></div>` : '') : '') + `</div>`;
    const res = !t ? '' : t.busy ? `<div class="cn-res">${I('loader', 'sm')}Asking. The first request loads the model, which can take a few minutes.</div>`
      : t.err ? `<div class="cn-res bad">${I('xc', 'sm')}${esc(t.err)}</div>`
      : `<div class="cn-res ok">${I('tick', 'sm')}Answered in ${esc((t.ms / 1000).toFixed(1))} s: "${esc(String(t.text).slice(0, 80))}"</div>`;
    return `<div class="svc ${online ? '' : 'off'}"><div class="row cn-top"><span class="code">${esc(abbr(m.label))}</span><span class="nm grow ellip">${esc(m.label)}</span>${state}</div>${facts}${res}`
      + `<div class="row cn-btns"><button class="btn sm" data-lm="${esc(m.id)}" data-where="${esc(where)}" ${(t && t.busy) || !online ? 'disabled' : ''}>${I('pulse', 'sm')}Test</button></div></div>`;
  }
  function paintLm() {
    if (!el) return;
    const d = ST.lm;
    if (!d) { set('lm', ST.lmErr ? bad('Server offline. Local models cannot be read right now.') : loading('Loading local models')); return; }
    const cards = (d.here || []).map((m) => lmCard(m, d.machine + ' (this PC)', true, null));
    const l = d.linked;
    if (l) {
      for (const m of l.models || []) cards.push(lmCard(m, l.machine, l.online, l.gpu));
      if (l.error && !(l.models || []).length) cards.push(`<div class="svc off"><div class="row cn-top"><span class="code">${esc(abbr(l.machine || 'PC'))}</span><span class="nm grow ellip">${esc(l.machine || 'Linked PC')}</span>${l.online ? MC.st('warn', 'No models') : MC.st('fail', 'PC off')}</div><div class="cn-res warn">${I('warn', 'sm')}${esc(l.error)}</div></div>`);
    }
    set('lm', cards.join('') || faint('No local model on this PC, and no linked PC.'));
  }
  async function loadLm(fresh) {
    try { ST.lm = await api.get('/api/models/local' + (fresh ? '?fresh=1' : '')); ST.lmErr = null; } catch (e) { ST.lmErr = errText(e); }
    paintLm();
  }
  async function lmTest(b) {
    const key = b.dataset.where + '/' + b.dataset.lm;
    ST.lmTests[key] = { busy: true }; paintLm();
    try {
      const r = await api.post('/api/models/ask', { model: b.dataset.lm, prompt: 'Reply with the single word: ready', maxTokens: 16 });
      ST.lmTests[key] = { ms: r.ms, text: r.text || '(empty)' };
    } catch (e) { ST.lmTests[key] = { err: errText(e) }; }
    paintLm(); loadLm(true);
  }

  /* ---------- the linked computer: this PC's link to it, and its link back here (services/pcLink.js) ---------- */
  const pc = { st: null, err: null, busy: false, lock: null };
  const BACK = {
    linked: ['done', 'Online'], paired: ['idle', 'Set up, not online'], missing: ['warn', 'Not set up'], pairing: ['run', 'Pairing'],
    checking: ['run', 'Checking'], failed: ['fail', 'Failed'], other: ['warn', 'Linked to another computer'], old: ['warn', 'Older Mission Control'], unknown: ['idle', 'Not known'],
  };
  function paintPc() {
    if (!el) return;
    const s = pc.st;
    if (!s) { set('pcst', ''); set('pc', pc.err ? bad('Server offline. The link cannot be read right now.') : loading('Loading')); return; }
    if (!s.paired) {
      set('pcst', MC.st('idle', 'None'));
      set('pc', faint('This PC has no link to another computer. When your other computer links to this one, this PC links back to it by itself.'));
      return;
    }
    const name = s.paired.name, me = s.me || 'This PC', on = s.online;
    const b = s.back || { state: 'unknown' }, bs = BACK[b.state] || BACK.unknown;
    const out = on ? MC.st('done', 'Online') : MC.st(s.state === 'off' ? 'idle' : 'warn', s.state === 'connecting' || s.state === 'starting' ? 'Connecting' : 'Offline');
    const why = b.error || (b.state === 'other' ? `${name} is linked to ${b.name}.` : b.state === 'missing' ? `${name} cannot reach ${me} yet.` : '');
    const can = atPc() && on && !pc.busy && ['missing', 'failed', 'unknown'].includes(b.state);
    set('pcst', on && b.state === 'linked' ? MC.st('done', 'Both ways') : MC.st('warn', 'One way'));
    set('pc', `<div class="tbl cn-pc"><div class="tr hd"><span>Direction</span><span>Status</span><span></span></div>`
      + `<div class="tr"><b class="ellip">${esc(me)} to ${esc(name)}</b><span>${out}</span><span class="row cn-act">${atPc() && on ? `<button class="btn sm ghost" data-openpc>${I('ext', 'sm')}Open ${esc(name)}</button>` : `<span class="faint">${s.at ? 'Projects read ' + esc(ago(s.at)) : ''}</span>`}</span></div>`
      + `<div class="tr"><b class="ellip">${esc(name)} to ${esc(me)}</b><span>${MC.st(bs[0], bs[1])}</span><span class="row cn-act">${atPc() ? `<button class="btn sm${can ? ' primary' : ' ghost'}" data-pc="${can ? 'link' : 'check'}" ${pc.busy || !on ? 'disabled' : ''}>${I(can ? 'link' : 'refresh', 'sm')}${pc.busy ? 'Working' : can ? 'Link back' : 'Check'}</button>` : ''}</span></div></div>`
      + (why ? `<div class="row cn-note" role="status">${MC.st(b.state === 'failed' ? 'fail' : 'warn', why)}</div>` : '')
      + lockHtml(name, me, on, s.locked));
  }
  /* the PIN locks (server/services/pcLock.js): the one of the other PC, typed here; this PC's own, set here */
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function lockHtml(name, me, on, theirsLocked) {
    const L = pc.lock, btn = (k, label, ic, cls = 'ghost') => `<button class="btn sm ${cls}" data-pclk="${k}">${I(ic, 'sm')}${esc(label)}</button>`;
    const there = on ? (theirsLocked ? MC.st('warn', 'Locked') : MC.st('done', 'Open')) : MC.st('idle', 'Off');
    const mine = !L ? MC.st('idle', 'Reading') : !L.pin ? MC.st('idle', 'No PIN') : L.unlocked ? MC.st('done', `Open until ${hhmm(L.until)}${L.by ? ' for ' + L.by : ''}`) : L.outUntil ? MC.st('fail', `Wrong PINs: closed until ${hhmm(L.outUntil)}`) : MC.st('warn', 'Locked');
    return `<div class="tbl cn-pc" style="margin-top:calc(10px*var(--k))"><div class="tr hd"><span>PIN lock</span><span>Status</span><span></span></div>`
      + `<div class="tr"><b class="ellip">${esc(name)}</b><span>${there}</span><span class="row cn-act">${on ? (theirsLocked ? (atPc() ? btn('unlock', 'Unlock', 'lock', 'primary') : '') : btn('lockthere', 'Lock', 'lock')) : ''}</span></div>`
      + `<div class="tr"><b class="ellip">${esc(me)}</b><span>${mine}</span><span class="row cn-act">${L && L.pin && L.unlocked ? btn('lockhere', 'Lock now', 'lock') : ''}${atPc() ? btn('setpin', L && L.pin ? 'Change PIN' : 'Set PIN', 'shield') + (L && L.pin ? btn('nopin', 'Remove PIN', 'x') : '') : ''}</span></div>`
      + (L && L.pin ? `<div class="tr"><b class="ellip">Locks each day at</b><span>${atPc() ? `<input type="time" class="input" style="width:auto" data-pclkat value="${esc(L.lockAt || '03:00')}">` : esc(L.lockAt || '03:00')}</span><span></span></div>` : '')
      + `</div>`;
  }
  async function lockAct(k) {
    const name = (pc.st && pc.st.paired && pc.st.paired.name) || 'the other PC';
    try {
      if (k === 'unlock') { let r = null; if (await MC.pinBox(`${name}'s PIN`, async (pin) => { r = await api.post('/api/pc-link/unlock', { pin }); })) MC.toast(r && r.until ? `${name} is open until ${hhmm(r.until)}` : `${name} is open`, 'lock'); }
      if (k === 'lockthere') { const r = await api.post('/api/pc-link/lock', {}); MC.toast(r && r.pin ? `${name} is locked` : `${name} has no PIN`, 'lock'); }
      if (k === 'lockhere') { pc.lock = await api.post('/api/pc-lock/lock', {}); MC.toast('Locked', 'lock'); }
      if (k === 'setpin') {
        let first = null;
        const ok = await MC.pinBox('New PIN, 4 to 8 digits', async (pin) => { first = pin; }, true, 'Next');
        if (!ok || !(await MC.pinBox('The same PIN again', async (pin) => { if (pin !== first) throw new Error('Not the same PIN'); pc.lock = await api.put('/api/pc-lock/pin', { pin }); }, true, 'Save'))) return;
        MC.toast(`PIN set. ${name} types it once a day.`, 'lock');
      }
      if (k === 'nopin') { if (!(await MC.askYes('Remove the PIN?', `${name} then has the limited access again.`, 'Remove'))) return; pc.lock = await api.put('/api/pc-lock/pin', { pin: null }); }
    } catch (e) { MC.toast(errText(e), 'warn'); }
    loadPc();
  }
  async function lockAtSet(v) {
    try { pc.lock = await api.put('/api/pc-lock/time', { at: v }); MC.toast(`Locks each day at ${v}`, 'lock'); } catch (e) { MC.toast(errText(e), 'warn'); }
    paintPc();
  }
  MC.events.on('pc-lock', (s) => { if (s && typeof s === 'object') { pc.lock = s; if (shown()) paintPc(); } });
  async function loadPc() {
    try { pc.st = await api.get('/api/pc-link'); pc.err = null; } catch (e) { pc.err = errText(e); }
    try { pc.lock = await api.get('/api/pc-lock'); } catch (e) { /* the card shows Reading */ }
    paintPc();
  }
  async function pcAct(b) {
    pc.busy = true; paintPc();
    try { pc.st = await api.post('/api/pc-link/back', b.dataset.pc === 'check' ? { check: true } : {}); }
    catch (e) { if (pc.st) pc.st = { ...pc.st, back: { state: 'failed', error: errText(e) } }; }
    pc.busy = false; paintPc();
  }
  MC.events.on('pc-link', (s) => { if (s && typeof s === 'object' && 'paired' in s) { pc.st = s; if (shown()) paintPc(); } });

  /* ---------- devices: the bridge, pairing a phone, the list ---------- */
  const DV_ERR = { bridge_offline: 'The bridge is not running.', list_unreadable: 'The saved device list could not be read, so nothing was changed.', write_failed: 'The device list could not be saved, so nothing was changed.' };
  const dvErr = (e) => DV_ERR[e && e.message] || errText(e) || 'Something went wrong.';
  const openUntil = () => { if (dv.pair) return dv.pair.expiresAt; const p = dv.view && dv.view.pairing; return p ? new Date(p.expiresAt).getTime() : null; };
  /* a confirmation fades after a few seconds; a warning stays until the next action */
  function note(kind, text) { const n = dv.note = { kind, text }; if (kind === 'ok') setTimeout(() => { if (dv.note === n) { dv.note = null; paintDv(); } }, 8000); }
  function paintDv() {
    if (!el) return;
    const v = dv.view;
    if (!v) { set('dvn', ''); set('dv', dv.failed ? bad('Server offline. Devices cannot be read right now.') : loading('Loading devices')); return; }
    const on = !!(v.bridge && v.bridge.online), until = openUntil(), list = v.devices || [];
    set('dvn', String(list.length));
    const bridge = !atPc() ? '' : `<div class="row cn-bridge">${on ? MC.st('done', 'Bridge online') + (v.bridge.version ? `<span class="faint mono">${esc(v.bridge.version)}</span>` : '') : MC.st('fail', 'Bridge offline')}<span class="grow"></span>`
      + (on ? `<button class="btn sm" data-dv="restart" ${dv.restarting ? 'disabled' : ''} title="Phones drop for a few seconds, then reconnect">${I('refresh', 'sm')}${dv.restarting ? 'Restarting' : 'Restart bridge'}</button>` : '')
      + (until !== null ? '' : `<button class="btn sm primary" data-dv="pair" ${on && !dv.opening ? '' : 'disabled'} ${on ? '' : 'title="The bridge is not running"'}>${I('plus', 'sm')}Pair a phone</button>`) + `</div>`;
    const nt = dv.note ? `<div class="row cn-note" role="status">${MC.st(dv.note.kind === 'ok' ? 'done' : 'warn', dv.note.text)}</div>` : '';
    let pair = '';
    if (until !== null) {
      const t = `<div class="cn-left">Expires in <b role="timer" data-cn-left="dv">${esc(left(until - Date.now()))}</b></div>`;
      pair = dv.pair
        ? `<div class="cn-pair">${qrBlock(dv.pair.uri, dv.pair.code)}<div class="cn-side"><p>Open Mission Control on the phone and scan this code.</p><p>A paired phone can drive Claude on this PC and read your project files.</p>${t}<div class="row cn-btns">${copyBtn('data-dv="copy"', 'Copy pairing text')}<button class="btn sm ghost" data-dv="cancel">${I('x', 'sm')}Cancel</button></div></div></div>`
        : `<div class="cn-pair"><div class="cn-side"><p>A pairing code is open, but its QR code is only shown where it was made.</p>${t}<div class="row cn-btns"><button class="btn sm primary" data-dv="pair">${I('refresh', 'sm')}Make a new code</button><button class="btn sm ghost" data-dv="cancel">${I('x', 'sm')}Cancel</button></div></div></div>`;
    }
    const rows = list.length ? `<div class="tbl cn-dv"><div class="tr hd"><span>Name</span><span>Paired</span><span>Last seen</span><span>Status</span><span></span></div>`
      + list.map((d) => `<div class="tr"><b class="ellip" title="${d.computer ? 'A linked computer: it may sync this PC\'s shared projects and restart its server' : ''}">${d.computer ? I('pc', 'sm') + ' ' : ''}${esc(d.name)}</b><span class="mono">${esc(dateOf(d.pairedAt))}</span><span class="mono">${d.online ? '' : esc(ago(d.lastSeen))}</span><span>${d.online ? MC.st('done', 'Online') : MC.st('idle', 'Offline')}</span>`
        + `<span class="row cn-act">${atPc() ? `<button class="btn sm ghost" data-dv="computer" data-id="${esc(d.id)}" data-name="${esc(d.name)}" data-on="${d.computer ? '0' : '1'}" aria-pressed="${d.computer ? 'true' : 'false'}" title="${d.computer ? 'Turn off: it can no longer sync this PC' : 'Your other computer (its Mission Control paired here): it may push this PC\'s commits, pull, and restart its server from its Sync panel'}">${I(d.computer ? 'check' : 'pc', 'sm')}${d.computer ? 'Linked computer' : 'Make linked computer'}</button><button class="btn sm ghost" data-dv="rename" data-id="${esc(d.id)}" data-name="${esc(d.name)}">${I('type', 'sm')}Rename</button>` : ''}<button class="btn sm ghost" data-dv="remove" data-id="${esc(d.id)}" data-name="${esc(d.name)}">${I('trash', 'sm')}Remove</button></span></div>`).join('') + `</div>`
      : faint('No phones are paired.');
    set('dv', bridge + nt + pair + rows);
  }
  async function loadDv() {
    const mine = ++dv.seq;
    try {
      const v = await api.get('/api/devices');
      if (mine !== dv.seq) return;
      dv.view = v; dv.failed = false;
      if (dv.pair && !v.pairing) dv.pair = null; /* the server closed the code this page was showing (used, canceled, expired or burned) */
    } catch (e) { if (mine !== dv.seq) return; dv.failed = true; }
    paintDv();
  }
  function tickDv() {
    const until = openUntil(); if (until === null) return;
    const ms = until - Date.now();
    if (ms <= 0) {
      const had = !!dv.pair; dv.pair = null;
      if (dv.view) dv.view.pairing = null; /* the server's copy is just as expired: without this, the page ticks again forever */
      if (had) dv.note = { kind: 'warn', text: 'The pairing code expired.' };
      paintDv(); loadDv(); return;
    }
    const b = el && el.querySelector('[data-cn-left="dv"]'); if (b) b.textContent = left(ms);
  }
  async function dvAct(b) {
    const act = b.dataset.dv, id = b.dataset.id;
    if (act === 'pair') {
      dv.opening = true; dv.note = null; paintDv();
      try {
        const [r] = await Promise.all([api.post('/api/devices/pair', {}), loadQr().catch(() => {})]);
        dv.pair = { code: r.code, uri: r.uri, expiresAt: new Date(r.expiresAt).getTime() };
      } catch (e) { if (!(e.status === 409 && e.message === 'bridge_offline')) dv.note = { kind: 'warn', text: dvErr(e) }; }
      dv.opening = false; await loadDv();
    } else if (act === 'restart') {
      dv.restarting = true; dv.note = null; paintDv();
      try {
        await api.post('/api/devices/bridge/restart', {});
        note('ok', 'The bridge is restarting. Phones reconnect in a few seconds.');
        await new Promise((r) => setTimeout(r, 4000)); /* long enough for the bridge to be back, so the chip does not flash Offline last */
      } catch (e) { dv.note = { kind: 'warn', text: dvErr(e) }; }
      dv.restarting = false; await loadDv();
    } else if (act === 'cancel') {
      dv.pair = null; paintDv(); /* the QR goes at once, not after the server answers */
      try { await api.post('/api/devices/pair/cancel', {}); } catch (e) { dv.note = { kind: 'warn', text: dvErr(e) }; }
      await loadDv();
    } else if (act === 'copy') {
      if (dv.pair) copy(dv.pair.uri, b, 'Copy pairing text');
    } else if (act === 'rename') {
      const name = await MC.askText('Rename this phone', '', b.dataset.name);
      if (name == null || !name.trim() || name.trim() === b.dataset.name) return;
      try { await api.post(`/api/devices/${enc(id)}/rename`, { name: name.trim().slice(0, 40) }); dv.note = null; } catch (e) { dv.note = { kind: 'warn', text: 'Could not rename: ' + dvErr(e) }; }
      await loadDv();
    } else if (act === 'computer') {
      const on = b.dataset.on === '1';
      if (on && !(await MC.askYes(`Make ${b.dataset.name} a linked computer?`, 'Only for your own other computer. From its Sync panel it may push the commits this PC already has, pull new ones in the projects you both have, and restart this server. It never commits here and never touches an uncommitted file.', 'Allow'))) return;
      try { await api.post(`/api/devices/${enc(id)}/computer`, { on }); note('ok', on ? `${b.dataset.name} is a linked computer` : `${b.dataset.name} is no longer a linked computer`); } catch (e) { dv.note = { kind: 'warn', text: 'Not changed: ' + dvErr(e) }; }
      await loadDv();
    } else if (act === 'remove') {
      if (!(await MC.askYes(`Remove ${b.dataset.name}?`, 'It loses access at once.', 'Remove'))) return;
      try { await api.post(`/api/devices/${enc(id)}/remove`, {}); dv.note = null; } catch (e) { dv.note = { kind: 'warn', text: 'Could not remove: ' + dvErr(e) }; }
      await loadDv();
    }
  }
  MC.events.on('devices.changed', (ev) => {
    ev = ev || {};
    if (ev.reason === 'paired') { dv.pair = null; note('ok', (ev.name || 'A phone') + ' paired'); }
    else if (ev.reason === 'pairing' && dv.pair && (ev.state === 'expired' || ev.state === 'burned')) { dv.pair = null; dv.note = { kind: 'warn', text: ev.state === 'expired' ? 'The pairing code expired.' : 'The pairing code was closed after too many wrong tries.' }; }
    else if (ev.reason === 'removed' && dv.note && dv.note.kind === 'ok') dv.note = null;
    if (shown()) loadDv();
  });

  /* ---------- the hub: this PC's link to the always-on server the PCs share (services/hubLink.js) ---------- */
  const HB_STATE = { off: 'Off', starting: 'Starting', connecting: 'Connecting', online: 'Online', 'no longer paired': 'No longer paired' };
  const HB_WHAT = { sent: 'Sent', got: 'Picked up', copy: 'Made a copy', failed: 'Failed' };
  function paintHub() {
    if (!el || !box('hb')) return;
    const h = ST.hub;
    if (!h) { set('hbst', ''); set('hb', ST.hubErr ? bad('Could not read the link to the hub.') : loading('Loading')); set('hbsync', ''); return; }
    const st = String(h.state || 'off'), off = /^offline/.test(st), word = HB_STATE[st] || st;
    set('hbst', !h.paired ? MC.st('idle', 'Not paired') : off ? MC.st('fail', 'Offline') : MC.st(st === 'online' ? 'done' : st === 'no longer paired' ? 'warn' : 'run', word));
    if (!h.available) { set('hb', `<div class="lv-err">${I('warn', 'sm')}mc-link is not built. Run bridge\\build-bridge.bat.</div>`); set('hbsync', ''); return; }
    if (h.paired) {
      const p = ST.hubPhone, ms = p ? Date.parse(p.expiresAt) - Date.now() : 0;
      set('hb', `<div class="row cn-hub"><span class="grow">Linked to <b>${esc(h.paired.name)}</b>: ${esc(off ? 'offline (' + st.replace(/^offline:\s*/, '') + ')' : word.toLowerCase())}</span>`
        + `<button class="btn sm" data-hb="phone" ${ST.hubBusy ? 'disabled' : ''} title="So the phone can reach the chats when every PC is off">${I('plus', 'sm')}Pair a phone with the hub</button>`
        + `<button class="btn sm ghost" data-hb="forget" ${ST.hubBusy ? 'disabled' : ''}>${I('x', 'sm')}Forget the hub</button></div>`
        + (p && ms > 0 ? `<div class="cn-pair">${qrBlock(p.uri, p.code)}<div class="cn-side"><p>Open Mission Control on the phone. Choose Pair, then scan this code. The phone keeps this PC too: it opens the hub only when this PC is off.</p>`
          + `<div class="cn-left">Expires in <b role="timer" data-cn-left="hb">${esc(left(ms))}</b></div><div class="row cn-btns">${copyBtn('data-hb="copy"', 'Copy pairing text')}<button class="btn sm ghost" data-hb="done">${I('check', 'sm')}Done</button></div></div></div>` : ''));
    } else {
      /* the field being typed survives a repaint */
      const old = el.querySelector('[data-hb-text]'), val = old ? old.value : '';
      set('hb', `<div class="row cn-hub"><span class="input grow"><input data-hb-text placeholder="missioncontrol-pair:..." aria-label="Pairing text from the hub" spellcheck="false"></span><button class="btn sm primary" data-hb="pair" ${ST.hubBusy ? 'disabled' : ''}>${I('link', 'sm')}Pair</button></div>`);
      const nw = el.querySelector('[data-hb-text]'); if (nw && val && !nw.value) nw.value = val;
    }
    paintSync();
  }
  /* what the sync is doing (services/hubSync.js syncStatus): the round running now with its progress, what is on this PC and on
     the hub, the computers, and the last things sent and picked up */
  function paintSync() {
    const h = ST.hub, s = h && h.paired ? h.sync : null;
    if (!s || !s.linked) { set('hbsync', ''); return; }
    const errAt = s.lastError ? s.lastError.slice(0, 24) : null, errMsg = s.lastError ? s.lastError.slice(25) : '';
    const failing = errAt && (!s.lastOk || errAt > s.lastOk);
    let top;
    if (s.round) {
      const r = s.round, frac = r.bytes ? r.bytesDone / r.bytes : (r.total ? r.done / r.total : 1), pc = Math.min(100, Math.floor(frac * 100));
      top = `<div class="row cn-sst">${MC.st('run', 'Sending')}<span><b>${r.done}</b> of <b>${r.total}</b> conversations, <b>${esc(bytes(r.bytesDone))}</b> of <b>${esc(bytes(r.bytes))}</b> (${pc}%)${r.failed ? ', ' + r.failed + ' failed' : ''}</span></div>`
        + `<div class="bar cn-sbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pc}"><i style="width:${pc}%"></i></div>`
        + (r.current ? `<div class="cn-now">Now: <b>${esc(r.current)}</b></div>` : '');
    } else if (failing) top = `<div class="row cn-sst">${MC.st('fail', 'Problem')}<span>The hub did not answer. Mission Control tries again by itself.</span></div>`;
    else if (s.lastRound) {
      const l = s.lastRound;
      top = `<div class="row cn-sst">${l.failed ? MC.st('fail', l.failed + ' failed') : MC.st('done', 'Up to date')}<span>Last full check ${esc(ago(l.finishedAt))}${l.sent ? ': sent ' + l.sent + ' (' + esc(bytes(l.bytes)) + ')' : ': nothing new to send'}</span></div>`;
    } else top = `<div class="row cn-sst">${MC.st('idle', 'Waiting')}<span>Waiting for the hub</span></div>`;
    const kinds = (o) => (o ? o.chats + ' chats, ' + o.code + ' code conversations' : 'not known yet');
    const facts = [
      ['On this PC', s.local ? kinds(s.local) + (s.local.waiting ? '. Not sent yet: ' + s.local.waiting + ' (' + bytes(s.local.waitingBytes) + ')' : '. All sent') : 'not counted yet'],
      ['On the hub', s.hub ? kinds(s.hub) + ', ' + bytes(s.hub.bytes) : 'not known yet'],
      ['Hub answered', s.lastRing ? ago(s.lastRing) : 'not yet'],
      ['Computers', (s.machines || []).length ? s.machines.map((m) => m.name + (m.me ? ' (this PC)' : '') + ': ' + (m.online ? 'on' : 'off, seen ' + ago(m.lastSeen))).join('  /  ') : 'none yet'],
    ];
    if (failing) facts.push(['Last problem', ago(errAt) + ': ' + errMsg, 'bad']);
    const rec = (s.recent || []).slice(0, 12);
    set('hbsync', `<div class="cn-sync" role="status" aria-live="polite">${top}<dl class="cn-facts2">${facts.map((f) => `<dt>${esc(f[0])}</dt><dd${f[2] ? ' class="bad"' : ''}>${f[2] ? I('xc', 'sm') : ''}${esc(f[1])}</dd>`).join('')}</dl>`
      + (rec.length ? `<div class="tbl cn-rec"><div class="tr hd"><span>When</span><span>What</span><span>Conversation</span><span>Size</span></div>`
        + rec.map((x) => `<div class="tr"><span class="mono">${esc(ago(x.at))}</span><span>${x.what === 'failed' ? MC.st('fail', 'Failed') : esc(HB_WHAT[x.what] || x.what)}</span><span class="cn-wrap">${esc(x.title || x.id)}${x.error ? ` <span class="mono faint">(${esc(x.error)})</span>` : ''}</span><span class="mono">${x.bytes ? esc(bytes(x.bytes)) : ''}</span></div>`).join('') + `</div>` : '') + `</div>`);
  }
  async function loadHub() {
    if (!atPc()) return;
    try { ST.hub = await api.get('/api/hub-link'); ST.hubErr = null; } catch (e) { ST.hubErr = errText(e); }
    paintHub();
  }
  async function hbAct(b) {
    const act = b.dataset.hb;
    if (act === 'done') { ST.hubPhone = null; paintHub(); return; }
    if (act === 'copy') { if (ST.hubPhone) copy(ST.hubPhone.uri, b, 'Copy pairing text'); return; }
    if (act === 'phone') {
      ST.hubBusy = true; paintHub();
      try { const [r] = await Promise.all([api.post('/api/hub-link/pair-phone', {}), loadQr().catch(() => {})]); ST.hubPhone = r; }
      catch (e) { MC.toast('Could not make a pairing code: ' + errText(e), 'warn'); }
      ST.hubBusy = false; loadHub(); return;
    }
    if (act === 'forget' && !(await MC.askYes('Forget the hub?', 'This PC stops sending its conversations there. Pairing again needs a new code from the hub.', 'Forget'))) return;
    const inp = el.querySelector('[data-hb-text]'), text = act === 'pair' ? (inp ? inp.value : '').trim() : '';
    if (act === 'pair' && !text) { if (inp) inp.focus(); return; }
    ST.hubBusy = true; paintHub();
    try { if (act === 'pair') await api.post('/api/hub-link/pair', { text }); else await api.post('/api/hub-link/forget', {}); if (inp) inp.value = ''; }
    catch (e) { MC.toast(`Could not ${act === 'pair' ? 'pair' : 'forget the hub'}: ${errText(e)}`, 'warn'); }
    ST.hubBusy = false; loadHub();
  }
  MC.events.on('hub-link', () => { if (shown()) loadHub(); });
  MC.events.on('hub-sync', (s) => { if (ST.hub && ST.hub.paired && ST.hub.sync && s) { ST.hub.sync = s; if (shown()) paintSync(); } });

  /* ---------- the clock while the page shows: pairing countdowns each second, local apps every 5s, devices every 15s,
     the sync's "ago" times every 10s; it stops by itself once the page is hidden ---------- */
  function tick() {
    if (!shown()) { clearInterval(timer); timer = 0; return; }
    ticks++;
    tickDv();
    if (ST.hubPhone) {
      const ms = Date.parse(ST.hubPhone.expiresAt) - Date.now();
      if (ms <= 0) { ST.hubPhone = null; paintHub(); } else { const b = el.querySelector('[data-cn-left="hb"]'); if (b) b.textContent = left(ms); }
    }
    if (document.hidden) return;
    if (ticks % 5 === 0) loadLocal();
    if (ticks % 30 === 0) loadLm();
    if (ticks % 15 === 0) { loadDv(); loadPc(); }
    if (ticks % 10 === 0) paintSync();
  }

  function bind() {
    el.addEventListener('click', async (e) => {
      const cp = e.target.closest('[data-copy]'); if (cp) { copy(cp.dataset.copy, cp, 'Copy'); return; }
      const tb = e.target.closest('[data-test]'); if (tb) {
        const id = tb.dataset.test; ST.tests[id] = { busy: true }; paintConn();
        try { const r = await api.post(`/api/connections/${enc(id)}/test`, {}); ST.tests[id] = { ok: !!r.ok, reason: r.reason }; } catch (er) { ST.tests[id] = { err: errText(er) }; }
        paintConn(); return;
      }
      const lm = e.target.closest('[data-lm]'); if (lm && !lm.disabled) { lmTest(lm); return; }
      const d = e.target.closest('[data-dv]'); if (d && !d.disabled) { dvAct(d); return; }
      const pb = e.target.closest('[data-pc]'); if (pb && !pb.disabled) { pcAct(pb); return; }
      if (e.target.closest('[data-openpc]')) { MC.openOtherPc(); return; }
      const lk = e.target.closest('[data-pclk]'); if (lk) { lockAct(lk.dataset.pclk); return; }
      const h = e.target.closest('[data-hb]'); if (h && !h.disabled) hbAct(h);
    });
    el.addEventListener('change', (e) => { const t = e.target.closest('[data-pclkat]'); if (t && t.value) lockAtSet(t.value); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-hb-text]')) { e.preventDefault(); const b = el.querySelector('[data-hb="pair"]'); if (b) b.click(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && shown()) { loadLocal(); loadDv(); } });
  }

  /* the page shell calls this each time Connections is shown */
  MC.drawPage.connections = (target) => {
    el = target;
    if (!el._bound) { el._bound = true; bind(); frame(); loadQr().catch(() => {}); }
    paintConn(); paintLocal(); paintLm(); paintPc(); paintDv(); paintHub();
    loadConn(); loadLocal(); loadLm(true); loadPc(); loadDv(); loadHub();
    if (!timer) { ticks = 0; timer = setInterval(tick, 1000); }
  };
})();
