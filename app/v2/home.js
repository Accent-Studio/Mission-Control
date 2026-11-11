/* Mission Control 2: the Home panels on real data.
   Needs you (permission questions from every running conversation, and projects with work left: uncommitted, not pushed,
   build stale), Running, Projects (star system and cards), Timeline (time spent, from the usage index), Morning brief
   (today in numbers and what finished) and the Com Link (typed or spoken questions to the assistant, with its face).
   Loads after panels.js; it replaces the sample versions in modules.js. */
(() => {
  const { $, $$, esc, icon: I, state: S } = MC;
  const M = MC.modules, D = MC.data, api = MC.api, LV = MC.live, H = LV.helpers;
  const enc = encodeURIComponent;
  const { ago, hhmm, toMs, errText } = H;
  const rerender = (...mods) => mods.forEach((m) => MC.emit('rerender', m));
  const projOf = (pid, sid) => { const p = LV.byId[pid] || (LV.rows[sid] && LV.byId[LV.rows[sid].project]); return p ? p.name : null; };
  /* a conversation of the linked PC: the project its row names, as this PC's tree shows it (live.js remoteGroups) */
  const pcProjOf = (sid) => { const row = LV.rows[sid]; if (!row) return null; const p = Object.values(LV.byId).find((q) => q.machine && q.pname === (row.projectName || '')); return p ? p.name : null; };
  D.inbox = []; /* the sample list goes; loadNeeds fills it */
  const dur = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + ' m' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' m' : ''); };

  /* open a conversation: the open tab moves there; Ctrl click or the middle button opens a new tab */
  function openConv(name, sid, inNew) {
    if (!name) return;
    if (inNew && MC.D) { MC.D.newTab(name, { session: sid || null }); return; }
    MC.setProject(name); if (sid) MC.setSession(sid);
  }

  /* ---------- Needs you ---------- */
  const NEED = { perms: [], at: 0, busy: false, again: false };
  async function loadNeeds() {
    if (NEED.busy) { NEED.again = true; return; }
    NEED.busy = true;
    const out = [];
    await Promise.all((LV.runs || []).filter((r) => r.running).map(async (r) => {
      try { const list = await api.get(`/api/runs/${enc(r.runId)}/pending`); (Array.isArray(list) ? list : []).forEach((p) => out.push({ ...p, runId: r.runId, sid: r.sessionId, pid: r.projectId })); } catch (e) { /* the run ended */ }
    }).concat((LV.pcRuns || []).filter((r) => r.running && r.pending).map(async (r) => {
      /* the linked PC's: asked and answered there, through the link */
      try { const list = await api.get(`/api/pc/runs/${enc(r.runId)}/pending`); (Array.isArray(list) ? list : []).forEach((p) => out.push({ ...p, runId: r.runId, sid: r.sessionId, pc: true })); } catch (e) { /* the run ended, or the link is down */ }
    })));
    NEED.perms = out.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0)); NEED.at = Date.now(); NEED.busy = false;
    /* the rail badge, the bell and the tab marks read D.inbox */
    D.inbox = NEED.perms.map((p) => ({ proj: (p.pc ? pcProjOf(p.sid) : projOf(p.pid, p.sid)) || 'No project', what: p.tool === 'AskUserQuestion' ? ((p.questions && p.questions[0] && p.questions[0].question) || 'A question') : p.summary || p.tool, kind: p.tool === 'AskUserQuestion' ? 'question' : 'perm', sid: p.sid }));
    if (MC.D) { MC.D.drawTabs(); MC.D.drawRail && MC.D.drawRail(); MC.D.drawBar && MC.D.drawBar(); MC.D.drawTree && MC.D.drawTree(); }
    /* the browser tab says it too, so a question is seen from another tab or window */
    const n = NEED.perms.length, base = document.title.replace(/^\(\d+\) Needs you · /, '');
    document.title = n ? `(${n}) Needs you · ${base}` : base;
    rerender('inbox', 'brief');
    if (NEED.again) { NEED.again = false; loadNeeds(); }
  }
  let needT = 0;
  const needSoon = () => { clearTimeout(needT); needT = setTimeout(loadNeeds, 400); };
  MC.events.on('chat', (d) => { if (d && (d.permission || d.permissionDone != null || d.done)) needSoon(); });
  MC.events.on('pc.chat', (d) => { if (d && (d.permission || d.permissionDone != null || d.done)) { clearTimeout(needT); needT = setTimeout(loadNeeds, 900); } }); /* after live.js reads the linked PC's processes again */
  const projNeeds = () => LV.projects.filter((p) => p.needsYou && (p.needsReasons || []).length && !(S.work && /games/i.test(p.folder || '')));
  MC.needCount = () => NEED.perms.length + projNeeds().length + (MC.tasks && MC.tasks.nextUp ? MC.tasks.nextUp().you.length : 0);

  M.inbox = {
    label: 'Needs you', icon: 'inbox',
    render: () => {
      if (!NEED.at) { loadNeeds(); return '<div class="lv-empty">' + I('loader', 'sm') + 'Looking</div>'; }
      const perms = NEED.perms.map((p) => {
        const q = p.tool === 'AskUserQuestion', name = p.pc ? pcProjOf(p.sid) : projOf(p.pid, p.sid), row = LV.rows[p.sid];
        const what = q ? ((p.questions && p.questions[0] && p.questions[0].question) || 'A question') : p.summary || p.tool;
        return `<div class="need" data-run="${esc(p.runId)}" ${p.pc ? 'data-pc="1"' : ''} data-req="${esc(p.requestId)}" data-proj="${esc(name || '')}" data-sid="${esc(p.sid || '')}">${I(q ? 'chat' : 'lock')}
          <div class="grow"><div class="nw">${esc(what)}</div><div class="faint ellip">${esc(name || 'No project')}${row && row.title ? ' · ' + esc(row.title) : ''} · ${esc(ago(p.at))}</div>
          <div class="row nb">${q ? '<button class="btn sm primary" data-a="go">Answer</button>' : `<button class="btn sm primary" data-a="allow">${I('check', 'sm')}Allow</button><button class="btn sm ghost" data-a="deny">Deny</button><button class="btn sm ghost" data-a="go">Open</button>`}</div></div>${MC.st(q ? 'idle' : 'wait', q ? 'Question' : 'Permission')}</div>`;
      }).join('');
      const projs = projNeeds().map((p) => `<div class="need" data-proj="${esc(p.name)}"><span class="tint" style="background:${p.tint}">${esc(p.name[0])}</span><div class="grow"><div class="nw">${esc(p.name)}</div><div class="faint">${(p.needsReasons || []).map(esc).join(' · ')}</div></div><button class="btn sm ghost" data-a="proj">Open</button></div>`).join('');
      const tw = MC.tasks && MC.tasks.nextUp ? MC.tasks.nextUp().you : [];
      const tasks = tw.map((t) => `<div class="need" data-task="${esc(t.id)}">${I(t.blocked ? 'warn' : 'eye')}<div class="grow"><div class="nw">${esc(t.title)}</div><div class="faint ellip">${esc(t.id)} · ${t.blocked ? 'Blocked: ' + esc(t.blocked) : 'Claude finished it'}</div></div>${MC.st(t.blocked ? 'warn' : 'wait', t.blocked ? 'Blocked' : 'Review')}</div>`).join('');
      return `<div class="list needs">${perms}${tasks ? `<div class="sect-h">Tasks</div>${tasks}` : ''}${projs ? `<div class="sect-h">Projects</div>${projs}` : ''}${!perms && !projs && !tasks ? '<div class="empty">Nothing waits for you</div>' : ''}</div>`;
    },
    mount: (el) => {
      const go = (e) => {
        const tk = e.target.closest('[data-task]'); if (tk && MC.tasks && MC.tasks.openTask) { const t = MC.tasks.list().find((x) => x.id === tk.dataset.task); if (t) MC.tasks.openTask(t); return; }
        const b = e.target.closest('[data-a]'); if (!b) return; const n = b.closest('.need'), inNew = e.ctrlKey || e.metaKey || e.button === 1;
        if (b.dataset.a === 'go') { openConv(n.dataset.proj, n.dataset.sid, inNew); return; }
        if (b.dataset.a === 'proj') { openConv(n.dataset.proj, null, inNew); return; }
        b.disabled = true;
        api.post(`/api/${n.dataset.pc ? 'pc/' : ''}runs/${enc(n.dataset.run)}/permission`, { requestId: n.dataset.req, behavior: b.dataset.a })
          .then(() => { NEED.perms = NEED.perms.filter((p) => p.requestId !== n.dataset.req); rerender('inbox', 'brief'); })
          .catch((er) => { b.disabled = false; MC.toast('Not sent: ' + errText(er), 'warn'); needSoon(); });
      };
      el.onclick = go; el.onauxclick = (e) => { if (e.button === 1) go(e); };
    },
  };

  /* ---------- Running ---------- */
  M.running = {
    label: 'Running', icon: 'rocket', scope: true,
    render: (vp) => {
      const all = vp.state.scope === 'all' || !S.project;
      const ag = D.agents.filter((a) => all || a.proj === S.project);
      return `<div class="list">${ag.map((a) => `<div class="agent" data-sid="${esc(a.sid || '')}" data-proj="${esc(a.proj)}" data-run="${esc(a.runId || '')}"><span class="avatar av-claude">${I('sparkle', 'sm')}</span><div class="grow"><div class="row" style="gap:calc(8px*var(--k))"><b class="ellip">${esc(a.name)}</b>${all ? MC.pchip(a.proj) : ''}<span class="faint" style="font-size:calc(14px*var(--k))">${esc(a.model)}</span></div><div class="faint ellip" style="font-size:calc(15px*var(--k))">${esc(a.job)} · ${esc(a.for)}</div></div>${MC.st(a.state)}<button class="btn sm ghost" data-ag="open">Open</button><button class="ibtn sm" title="Stop" data-ag="stop">${I('stop', 'sm')}</button></div>`).join('') || `<div class="empty">Nothing runs${all ? '' : ' in this project'}</div>`}</div>`;
    },
    mount: (el) => {
      const go = async (e) => {
        const b = e.target.closest('[data-ag]'); if (!b) return; const a = b.closest('.agent');
        if (b.dataset.ag === 'open') { openConv(a.dataset.proj, a.dataset.sid, e.ctrlKey || e.metaKey || e.button === 1); return; }
        if (!a.dataset.run || !(await MC.askYes('Stop this conversation?', 'Its work so far is kept.', 'Stop'))) return;
        api.post(`/api/runs/${enc(a.dataset.run)}/stop`, {}).catch((er) => MC.toast('Not stopped: ' + errText(er), 'warn'));
      };
      el.onclick = go; el.onauxclick = (e) => { if (e.button === 1) go(e); };
    },
  };

  /* ---------- Projects: star system or cards ---------- */
  const allProjects = () => LV.projects.filter((p) => !(S.work && /games/i.test(p.folder || ''))).map((p) => ({ ...p, running: (LV.runs || []).filter((r) => r.running && (r.projectId === p.id)).length || (D.agents.filter((a) => a.proj === p.name).length), last: toMs(p.lastCommit && p.lastCommit.date) || 0 }));
  /* The star system, on the same data as the old Home: each planet is a project on the ring and phase saved in /api/layout
     (the old Home reads and writes the same file). Ring n sits at R0 + n*STEP from the sun, which is Mission Control itself.
     Orbits follow Kepler's third law: the innermost ring takes ORBIT_T0 seconds and the rest follow from their radius. A saved
     angle is the planet's phase at Unix time 0, so its angle at time t is angle + omega(ring)*t, the same in every tab and page.
     It is drawn flat, the orbit plane squashed to the panel's shape. */
  const SUN = 'mission-control', TAU = Math.PI * 2, R0 = 130, STEP = 64, MAXRING = 40, PR = 26, ORBIT_T0 = 45;
  const ringR = (n) => R0 + n * STEP, omegaOf = (n) => TAU / (ORBIT_T0 * Math.pow(ringR(n) / R0, 1.5));
  const normA = (a) => ((a % TAU) + TAU) % TAU, angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
  const clock = () => (performance.timeOrigin + performance.now()) / 1000;
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const LY = { L: new Map(), at: null, loaded: false, busy: false, err: '', seeded: false, miss: '' }; /* L: id -> {ring, angle} */
  const SRV = { list: [], at: 0, busy: false };
  const SCN = new Map(); /* panel id -> its scene */
  const scenes = () => [...SCN.values()];
  const syncAll = () => scenes().forEach((s) => s.sync());
  /* the nearest angle to a on a ring where the planet clears every other planet on that ring (map: id -> {ring, angle}) */
  function freeAngle(map, id, ring, a) {
    const gap = 2 * Math.asin(Math.min(1, (PR + 6) / ringR(ring))), others = [];
    map.forEach((v, k) => { if (k !== id && k !== SUN && v.ring === ring) others.push(v.angle); }); /* the sun's old orbit entry takes no room */
    const ok = (t) => others.every((o) => Math.abs(angDiff(t, o)) >= gap);
    if (ok(a)) return a;
    for (let k = 1; k <= 130; k++) { const d = k * .05; if (ok(a + d)) return a + d; if (ok(a - d)) return a - d; }
    return a;
  }
  const worldMap = (t) => { const m = new Map(); LY.L.forEach((v, k) => m.set(k, { ring: v.ring, angle: v.angle + omegaOf(v.ring) * t })); return m; };
  /* where a dragged planet would land: the ring nearest the pointer, never past one new ring beyond the outermost, and a free angle */
  function planDrop(id, wx, wz, t) {
    let top = -1; LY.L.forEach((v, k) => { if (k !== id && k !== SUN && v.ring > top) top = v.ring; });
    const ring = Math.max(0, Math.min(MAXRING, top + 1, Math.round((Math.hypot(wx, wz) - R0) / STEP)));
    return { ring, angle: freeAngle(worldMap(t), id, ring, Math.atan2(wz, wx)), t, top }; /* angle is where it lands at time t */
  }
  function applyLayout(d) { LY.L = new Map(((d && d.rings) || []).map((e) => [e.id, { ring: e.ring, angle: e.angle }])); LY.at = (d && d.updatedAt) || null; LY.loaded = true; LY.err = ''; }
  async function loadLayout() {
    if (LY.busy) return; LY.busy = true;
    try { applyLayout(await api.get('/api/layout')); maybeSeed(); } catch (e) { if (!LY.loaded) LY.err = errText(e); }
    LY.busy = false; syncAll();
  }
  function saveLayout(ids) {
    const rings = ids.filter((id) => LY.L.has(id)).map((id) => ({ id, ring: LY.L.get(id).ring, angle: LY.L.get(id).angle }));
    return api.put('/api/layout', { rings }).then((d) => { applyLayout(d); syncAll(); }).catch((e) => { MC.toast('The new orbit was not saved: ' + errText(e), 'warn'); loadLayout(); });
  }
  /* first run with nothing saved: how long ago each project was worked on becomes its ring, once, and is saved */
  function maybeSeed() {
    if (LY.seeded || !LY.loaded || !LV.projects.length) return;
    LY.seeded = true; if (LY.at !== null) return;
    const map = new Map(), ps = LV.projects.filter((p) => p.exists !== false).map((p, i) => { const t = p.lastCommit && Date.parse(p.lastCommit.date); return { id: p.id, days: t ? Math.min(40, Math.max(0, (Date.now() - t) / 864e5)) : 40, a: (i * 2.399 + .4) % TAU }; });
    ps.sort((a, b) => a.days - b.days).forEach((p) => { const ring = Math.max(0, Math.min(MAXRING, Math.round((130 + Math.log(1 + p.days * 2) / Math.log(43) * 420 - R0) / STEP))); map.set(p.id, { ring, angle: freeAngle(map, p.id, ring, p.a) }); });
    LY.L = map; saveLayout([...map.keys()]);
  }
  /* the servers give the moons; the planets do not wait for them */
  async function loadServers() {
    if (SRV.busy) return; SRV.busy = true;
    try { const l = await api.get('/api/servers'); SRV.list = Array.isArray(l) ? l : []; } catch (e) { /* no moons */ }
    SRV.busy = false; SRV.at = Date.now(); syncAll();
  }
  const portOf = (id) => { const s = SRV.list.find((x) => x.project === id); return s ? s.port : null; };
  /* Orbit clock: OT = wall time minus OC.off. While a planet or its card is pointed at, and for 3 s after, OT stands still, then
     its rate eases back to 1 over 1 s. Drops save phases against OT, so a planet lands where it was let go. 60 s after the last
     hover (or when the page is hidden) the offset eases back to 0, after which every tab agrees again. */
  const OC = { off: 0, T: clock(), hold: 0, lastHover: 0, prev: 0 };
  function stepOrbit(now) {
    const dt = OC.prev ? Math.max(0, (now - OC.prev) / 1000) : 0; OC.prev = now;
    if (scenes().some((s) => s.held())) { OC.hold = now + 3000; OC.lastHover = now; }
    const k = Math.min(1, Math.max(0, (now - OC.hold) / 1000)), rate = k * k * (3 - 2 * k); /* 0 while held, smoothstep back to 1 */
    OC.off += (1 - rate) * dt;
    if (OC.off > 0 && (document.hidden || now - OC.lastHover > 60000)) { OC.off *= Math.exp(-dt / 1.2); if (OC.off < 1e-4 || document.hidden) OC.off = 0; }
    OC.T = clock() - OC.off; return OC.T;
  }
  MC.events.on('layout.changed', (d) => { if (scenes().some((s) => s.dragging())) return; if (d && d.updatedAt && d.updatedAt === LY.at) return; if (LY.loaded) loadLayout(); });
  MC.events.on('system.changed', () => { if (SRV.at) loadServers(); });
  /* Escape puts a dragged planet back where it was, or closes the card */
  addEventListener('keydown', (e) => { if (e.key === 'Escape') scenes().forEach((s) => s.escape()); });

  /* a run job's short name for the card: "Run dev" is Dev (a name that would read "App" stays whole) */
  const shortJob = (l) => { const s = String(l || '').replace(/^(run|start|launch)\s+/i, '').trim(); return !s || /^app$/i.test(s) ? String(l || '') : s[0].toUpperCase() + s.slice(1); };
  const textW = (() => { const c = document.createElement('canvas').getContext('2d'), w = new Map(); return (t, font) => { const k = font + '|' + t; if (!w.has(k)) { c.font = font; w.set(k, c.measureText(t).width); } return w.get(k); }; })();
  const needsOf = (p) => (typeof p.needsYou === 'boolean' ? p.needsYou : (p.needsReasons || []).length > 0);
  const show = (e, on) => { e.style.display = on ? '' : 'none'; };
  const NEEDG = '<g class="ss-need"><circle/><text text-anchor="middle" dy=".36em">!</text></g>';
  const BODY = '<circle class="ss-chg"/><circle class="ss-core"/><ellipse class="ss-w1"/><ellipse class="ss-w2"/><circle class="ss-moon"/>' + NEEDG;
  let ssSeq = 0;
  /* one scene per panel: it outlives the panel's redraws, so a drag or an open card is not lost when the data changes */
  function makeScene() {
    const n = ++ssSeq, root = document.createElement('div'); root.className = 'ss';
    root.innerHTML = `<svg class="ss-svg"><defs><radialGradient id="ssg${n}" cx="50%" cy="50%" r="50%"><stop offset=".3" style="stop-color:var(--accent);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></radialGradient>
      <radialGradient id="ssc${n}" cx="40%" cy="38%" r="65%"><stop offset="0" stop-color="#fff"/><stop offset=".35" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:.75"/></radialGradient></defs>
      <g class="ss-rings"></g><g class="ss-bodies"><g class="ss-sun"><circle class="ss-glow" fill="url(#ssg${n})"/><circle class="ss-chg"/><circle class="ss-core" fill="url(#ssc${n})"/>${NEEDG}</g></g>
      <circle class="ss-drop"/><g class="ss-labs"><text class="ss-lab ss-sunlab"></text></g></svg><div class="ss-card" style="display:none"></div><div class="ss-msg lv-empty" style="display:none"></div>`;
    const svg = $('svg', root), rings = $('.ss-rings', svg), bodies = $('.ss-bodies', svg), labs = $('.ss-labs', svg), sunG = $('.ss-sun', svg), sunLab = $('.ss-sunlab', svg), drop = $('.ss-drop', svg), card = $('.ss-card', root), msg = $('.ss-msg', root);
    const sc = { root, list: [], P: [], sun: null, els: new Map(), anim: new Map(), labC: new Map(), labTick: 0, W: 0, H: 0, K: 1, font: '', geo: null, hits: [], mouse: null, hover: null, drag: null, vis: false, raf: 0, last: 0, order: '', card: { id: null, over: false, t: 0, html: '' } };
    const info = (p) => ({ id: p.id, name: p.name || p.id, need: needsOf(p), dirty: p.dirty || 0, port: portOf(p.id), on: p.name === S.project });
    sc.held = () => !!sc.hover || !!sc.drag || (!!sc.card.id && sc.card.over);
    sc.dragging = () => !!(sc.drag && sc.drag.mode === 'planet');
    sc.run = () => { if (!sc.raf) sc.raf = requestAnimationFrame(frame); };

    /* the data: which planets, and their marks (dark red with a "!" badge = needs you, a dashed ring = uncommitted changes, a moon = a server running) */
    sc.sync = (list) => {
      if (list) sc.list = list;
      maybeSeed();
      if (LY.loaded && !LY.busy) { const miss = sc.list.filter((p) => p.exists !== false && p.hidden !== true && !LY.L.has(p.id)).map((p) => p.id).join(); if (miss && miss !== LY.miss) { LY.miss = miss; loadLayout(); } }
      sc.P = sc.list.filter((p) => p.id !== SUN && p.exists !== false && LY.L.has(p.id)).map(info);
      const sp = sc.list.find((p) => p.id === SUN); sc.sun = sp ? info(sp) : null;
      const keep = new Set(sc.P.map((p) => p.id));
      sc.els.forEach((e, id) => { if (!keep.has(id)) { e.g.remove(); e.lab.remove(); sc.els.delete(id); sc.labC.delete(id); } });
      sc.P.forEach((p) => {
        let e = sc.els.get(p.id);
        if (!e) { const g = document.createElementNS(SVGNS, 'g'), lab = document.createElementNS(SVGNS, 'text'); g.setAttribute('class', 'ss-p'); g.dataset.id = p.id; g.innerHTML = BODY; lab.setAttribute('class', 'ss-lab'); bodies.appendChild(g); labs.appendChild(lab); e = { g, lab, chg: $('.ss-chg', g), moon: $('.ss-moon', g), badge: $('.ss-need', g), r: 0 }; sc.els.set(p.id, e); sc.order = ''; }
        e.g.classList.toggle('need', p.need); e.g.classList.toggle('on', p.on); e.lab.classList.toggle('need', p.need); e.lab.classList.toggle('on', p.on);
        show(e.chg, p.dirty > 0); show(e.moon, !!p.port); show(e.badge, p.need);
        if (e.lab.textContent !== p.name) { e.lab.textContent = p.name; sc.labC.delete(p.id); }
      });
      const su = sc.sun || {};
      sunG.classList.toggle('need', !!su.need); show($('.ss-chg', sunG), !!su.dirty); show($('.ss-need', sunG), !!su.need);
      show(sunLab, !!sc.sun); sunLab.textContent = su.name || ''; sunLab.classList.toggle('need', !!su.need);
      const m = LY.err ? 'Could not load the orbits: ' + LY.err : !LY.loaded ? 'Loading the orbits' : ''; show(msg, !!m); msg.innerHTML = m ? (LY.err ? '' : I('loader', 'sm')) + esc(m) : '';
      if (sc.card.id) fillCard(sc.card.id);
      sc.run();
    };

    /* ---- the card: beside the planet, it stays put so its buttons can be reached, and goes a moment after the pointer leaves ---- */
    function fillCard(id) {
      const p = sc.list.find((x) => x.id === id); if (!p) { hideCard(); return false; }
      const why = p.needsReasons || [], port = portOf(p.id), also = (p.attention || []).map((a) => a.label).join(', ');
      const sync = (p.ahead > 0 ? p.ahead + ' ahead' : '') + (p.ahead > 0 && p.behind > 0 ? ', ' : '') + (p.behind > 0 ? p.behind + ' behind' : '');
      const jobs = (p.jobs || []).filter((j) => j.visible !== false && j.kind === 'run-dev').sort((a, b) => (a.order || 0) - (b.order || 0));
      const app = (p.checks || []).find((c) => c.launch && c.launch.available && c.launch.installed);
      const html = `<div class="ss-ch"><span class="tint" style="background:${p.tint}">${esc((p.name || '?')[0])}</span><b class="ellip">${esc(p.name)}</b></div>${p.about ? `<div class="ss-desc">${esc(p.about)}</div>` : ''}<dl class="ss-kv">`
        + (why.length ? `<dt>Needs you</dt><dd class="ss-why">${esc(why.join(', '))}</dd>` : '')
        + `<dt>Branch</dt><dd>${esc(p.branch || 'none')}${sync ? ', ' + esc(sync) : ''}</dd><dt>Git</dt><dd>${p.dirty ? MC.st('wait', p.dirty + ' uncommitted') : MC.st('done', 'Clean')}</dd>`
        + `<dt>Build</dt><dd>${p.build === 'fresh' ? MC.st('done', 'Up to date') : p.build === 'stale' ? MC.st('warn', 'Old') : MC.st('idle', 'Unknown')}${also ? `<div class="faint">Also older: ${esc(also)}</div>` : ''}</dd>`
        + `<dt>Last work</dt><dd>${p.lastCommit ? `<span class="ss-lw" title="${esc(p.lastCommit.subject)}">${esc(ago(p.lastCommit.date))}, ${esc(p.lastCommit.subject)}</span>` : 'No commits'}</dd>${port ? `<dt>Server</dt><dd class="mono">:${esc(port)}</dd>` : ''}</dl>`
        + `<div class="ss-acts">${jobs.map((j) => `<button class="btn sm" data-job="${esc(j.id)}" data-label="${esc(j.label)}" title="${esc(j.label)}">${I(j.outward ? 'share' : 'play', 'sm')}${esc(shortJob(j.label))}</button>`).join('')}${app && !MC.phone ? `<button class="btn sm" data-app="${esc(app.key)}" title="${esc(app.launch.label || 'Open the app')}">${I('ext', 'sm')}App</button>` : ''}<span class="grow"></span><button class="btn sm primary" data-open>Open</button></div>`;
      if (html !== sc.card.html) { sc.card.html = html; card.innerHTML = html; }
      return true;
    }
    function showCard(h) {
      clearTimeout(sc.card.t);
      if (sc.card.id === h.id && card.style.display !== 'none') return; /* already open for it: it stays where it is */
      sc.card.id = h.id; sc.card.html = ''; if (!fillCard(h.id)) return;
      show(card, true);
      const K = sc.K, cw = card.offsetWidth, ch = card.offsetHeight;
      let x = h.x + h.r + 12 * K; if (x + cw > sc.W - 8) x = h.x - h.r - 12 * K - cw;
      x = Math.max(8, Math.min(x, sc.W - cw - 8)); const y = Math.max(8, Math.min(h.y - 40 * K, sc.H - ch - 8));
      card.style.left = Math.round(x) + 'px'; card.style.top = Math.round(y) + 'px';
    }
    function hideCard() { clearTimeout(sc.card.t); sc.card.id = null; sc.card.over = false; if (card.contains(document.activeElement)) document.activeElement.blur(); show(card, false); }
    const hideSoon = () => { clearTimeout(sc.card.t); sc.card.t = setTimeout(() => { if (!sc.card.over) hideCard(); }, 260); };
    card.addEventListener('mouseenter', () => { sc.card.over = true; clearTimeout(sc.card.t); });
    card.addEventListener('mouseleave', () => { sc.card.over = false; hideSoon(); });
    card.addEventListener('click', async (e) => {
      const p = sc.list.find((x) => x.id === sc.card.id); if (!p) return;
      if (e.target.closest('[data-open]')) { openConv(p.name, null, e.ctrlKey || e.metaKey); return; }
      const j = e.target.closest('[data-job]'); if (j) { j.disabled = true; await MC.runJob(p.id, j.dataset.job, j.dataset.label); j.disabled = false; return; }
      const a = e.target.closest('[data-app]'); if (a) { a.disabled = true; try { await api.post(`/api/projects/${enc(p.id)}/checks/${enc(a.dataset.app)}/launch`, {}); MC.toast('Opened', 'ext'); } catch (er) { MC.toast('Could not open it: ' + errText(er), 'warn'); } a.disabled = false; }
    });
    card.addEventListener('auxclick', (e) => { const p = sc.list.find((x) => x.id === sc.card.id); if (p && e.button === 1 && e.target.closest('[data-open]')) openConv(p.name, null, true); });
    sc.escape = () => { if (sc.dragging()) { sc.drag = null; root.classList.remove('dragging'); sc.run(); } else if (sc.card.id) hideCard(); };

    /* ---- the pointer: point at a planet for its card (every planet pauses), click to open it, drag it to another orbit ---- */
    const at = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hitAt = (x, y) => { for (let i = sc.hits.length - 1; i >= 0; i--) { const h = sc.hits[i]; if (Math.hypot(x - h.x, y - h.y) < h.hr) return h; } return null; };
    const toWorld = (x, y) => { const g = sc.geo; return g ? [(x - g.cx) / g.s, (y - g.cy) / (g.s * g.flat)] : null; };
    const nameOf = (id) => (sc.list.find((p) => p.id === id) || {}).name;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !LY.loaded) return;
      const [x, y] = at(e), h = hitAt(x, y); if (!h) return;
      sc.drag = { x: e.clientX, y: e.clientY, moved: 0, id: h.sun ? null : h.id, hit: h.id, off: [x - h.x, y - h.y], mode: null }; /* the sun opens on a click but never moves */
      sc.hover = h.id; sc.mouse = [x, y]; svg.setPointerCapture(e.pointerId); e.preventDefault(); sc.run();
    });
    svg.addEventListener('pointermove', (e) => {
      const [x, y] = at(e); sc.mouse = [x, y]; sc.run();
      const d = sc.drag; if (!d) return;
      d.moved = Math.max(d.moved, Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y));
      if (d.moved < 5) return; /* nothing moves until 5 px, then the planet follows the pointer */
      if (sc.card.id) hideCard();
      if (d.id && d.mode !== 'planet') { d.mode = 'planet'; root.classList.add('dragging'); }
      if (d.mode === 'planet') d.free = toWorld(x - d.off[0], y - d.off[1]);
    });
    const endDrag = (e) => {
      const d = sc.drag; sc.drag = null; root.classList.remove('dragging'); if (!d || e.type !== 'pointerup') return;
      if (d.mode === 'planet') { if (d.plan) { LY.L.set(d.id, { ring: d.plan.ring, angle: normA(d.plan.angle - omegaOf(d.plan.ring) * d.plan.t) }); saveLayout([d.id]); } } /* the phase that puts it where it was dropped */
      else if (d.moved < 5 && nameOf(d.hit)) openConv(nameOf(d.hit), null, e.ctrlKey || e.metaKey);
    };
    svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
    svg.addEventListener('pointerleave', () => { if (!sc.drag) sc.mouse = null; });
    svg.addEventListener('auxclick', (e) => { if (e.button !== 1) return; const [x, y] = at(e), h = hitAt(x, y); if (h && nameOf(h.id)) openConv(nameOf(h.id), null, true); });
    new ResizeObserver(() => {
      sc.W = root.clientWidth; sc.H = root.clientHeight; svg.setAttribute('viewBox', `0 0 ${sc.W || 1} ${sc.H || 1}`);
      const cs = getComputedStyle(root); sc.K = parseFloat(cs.getPropertyValue('--k')) || 1; sc.font = `500 ${14 * sc.K}px ${cs.fontFamily}`; sc.labC.clear(); sc.run();
    }).observe(root);
    /* the drawing runs only while the panel is on screen: a hidden panel or tab does no work */
    new IntersectionObserver((es) => { sc.vis = es[es.length - 1].isIntersecting; if (sc.vis) sc.run(); }).observe(root);
    const badge = (g, r, K) => { g.setAttribute('transform', `translate(${(r * .78).toFixed(1)},${(-r * .78).toFixed(1)})`); g.firstChild.setAttribute('r', 6.5 * K); };

    function frame(now) {
      sc.raf = 0;
      if (!root.isConnected || !sc.vis || !root.getClientRects().length) { sc.last = 0; return; }
      const dt = sc.last ? Math.min(.05, Math.max(0, (now - sc.last) / 1000)) : 0; sc.last = now;
      sc.raf = requestAnimationFrame(frame);
      const W = sc.W, H = sc.H, K = sc.K; if (!W || !H) return;
      const still = S.work || RM.matches, tn = still ? OC.T : stepOrbit(now);
      let maxUsed = 5; sc.P.forEach((p) => { const r = LY.L.get(p.id).ring; if (r > maxUsed) maxUsed = r; });
      /* the scale leaves room for one more ring outside, where a planet can be dropped */
      const m = 16 * K, Rm = ringR(maxUsed + 1) + PR, flat = Math.max(.34, Math.min(.62, (H - 2 * m) / Math.max(1, W - 2 * m)));
      const s = Math.max(.01, Math.min((W / 2 - m) / Rm, (H / 2 - m) / (Rm * flat))), cx = W / 2, cy = H / 2;
      sc.geo = { cx, cy, s, flat };
      const pr = Math.max(7 * K, Math.min(13 * K, PR * s * 1.1)), sr = Math.max(13 * K, 54 * s * .8);
      const pd = sc.dragging() ? sc.drag : null;
      if (pd && pd.free) pd.plan = planDrop(pd.id, pd.free[0], pd.free[1], tn);
      /* planets orbit: angle = saved phase + omega*time; a moved planet glides to its new place */
      sc.P.forEach((p) => {
        const l = LY.L.get(p.id), tr = ringR(l.ring), tru = l.angle + omegaOf(l.ring) * tn, sig = l.ring + ':' + l.angle;
        let a = sc.anim.get(p.id); if (!a) { a = { moon: Math.random() * 6 }; sc.anim.set(p.id, a); }
        if (pd && pd.id === p.id && pd.free) { a.cr = Math.hypot(pd.free[0], pd.free[1]); a.ca = Math.atan2(pd.free[1], pd.free[0]); a.dg = true; }
        else if (a.cr === undefined || still) { a.cr = tr; a.ca = tru; a.lag = 0; a.sig = sig; a.dg = false; }
        else {
          if (a.dg || a.sig !== sig) { a.lag = angDiff(tru, a.ca); a.dg = false; a.sig = sig; }
          else { a.lag = angDiff(a.lag, 0) * Math.exp(-dt * 2.5); if (Math.abs(a.lag) < 1e-4) a.lag = 0; }
          a.ca = tru - a.lag; a.cr += (tr - a.cr) * (1 - Math.exp(-dt * 15)); if (Math.abs(tr - a.cr) < .1) a.cr = tr;
        }
        if (!still) a.moon += 1.2 * dt;
      });
      /* the orbits: while arranging, every ring a planet may land on shows and the target ring is brighter */
      const slots = pd && pd.plan ? pd.plan.top + 1 : -1, nR = Math.max(maxUsed, slots) + 1;
      const occ = new Set(sc.P.map((p) => LY.L.get(p.id).ring)), hring = sc.hover && sc.hover !== SUN && LY.L.has(sc.hover) ? LY.L.get(sc.hover).ring : -1;
      while (rings.childElementCount < nR) rings.appendChild(document.createElementNS(SVGNS, 'ellipse'));
      [...rings.children].forEach((el, i) => {
        if (i >= nR) { show(el, false); el._k = ''; return; }
        const cls = 'ss-orb ' + (pd && pd.plan && i <= slots ? (i === pd.plan.ring ? 'tgt' : 'slot') : occ.has(i) ? (i === hring && !pd ? 'hov' : 'used') : '');
        const k = `${cls}|${cx}|${cy}|${s}|${flat}`; if (el._k === k) return; el._k = k; show(el, true);
        el.setAttribute('class', cls); el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('rx', (ringR(i) * s).toFixed(1)); el.setAttribute('ry', (ringR(i) * s * flat).toFixed(1));
      });
      /* bodies: the sun in the middle, the planets in front of it drawn over it, the planet in your hand on top */
      const hot = (id) => sc.hover === id || (sc.card.over && sc.card.id === id);
      const list = sc.P.map((p) => { const a = sc.anim.get(p.id); return { id: p.id, p, x: cx + Math.cos(a.ca) * a.cr * s, y: cy + Math.sin(a.ca) * a.cr * s * flat, r: pr, hr: Math.max(pr + 6 * K, 14 * K), e: sc.els.get(p.id), a }; });
      if (sc.sun) list.push({ id: SUN, p: sc.sun, x: cx, y: cy, r: sr, hr: sr + 6 * K, sun: true });
      list.sort((a, b) => a.y - b.y);
      if (pd) { const i = list.findIndex((b) => b.id === pd.id); if (i >= 0) list.push(list.splice(i, 1)[0]); }
      const order = list.map((b) => b.id).join();
      if (order !== sc.order) { sc.order = order; list.forEach((b) => bodies.appendChild(b.sun ? sunG : b.e.g)); }
      show(sunG, !!sc.sun);
      list.forEach((b) => {
        if (b.sun) {
          if (sunG._r !== sr) { sunG._r = sr; $('.ss-glow', sunG).setAttribute('r', sr * 1.9); $('.ss-core', sunG).setAttribute('r', sr * .62); $('.ss-chg', sunG).setAttribute('r', sr * .95); badge($('.ss-need', sunG), sr * .62, K); }
          sunG.setAttribute('transform', `translate(${cx.toFixed(1)},${cy.toFixed(1)})`); sunG.classList.toggle('hot', hot(SUN)); sunLab.classList.toggle('hot', hot(SUN)); return;
        }
        const e = b.e;
        if (e.r !== pr) { e.r = pr; const q = (sel) => $(sel, e.g); q('.ss-core').setAttribute('r', pr); q('.ss-w1').setAttribute('rx', pr); q('.ss-w1').setAttribute('ry', pr * .38); q('.ss-w2').setAttribute('rx', pr * .45); q('.ss-w2').setAttribute('ry', pr); e.chg.setAttribute('r', pr * 1.55); e.moon.setAttribute('r', Math.max(2.2, 2.6 * K)); badge(e.badge, pr, K); }
        e.g.setAttribute('transform', `translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`);
        if (b.p.port) { e.moon.setAttribute('cx', (Math.cos(b.a.moon) * pr * 2.1).toFixed(1)); e.moon.setAttribute('cy', (Math.sin(b.a.moon) * pr * 2.1 * Math.max(.45, flat)).toFixed(1)); }
        e.g.classList.toggle('hot', hot(b.id)); e.g.classList.toggle('held', !!(pd && pd.id === b.id)); e.lab.classList.toggle('hot', hot(b.id));
      });
      sc.hits = list;
      if (pd && pd.plan) { /* a dashed circle where the planet will land */
        const r = ringR(pd.plan.ring) * s; show(drop, true); drop.setAttribute('cx', (cx + Math.cos(pd.plan.angle) * r).toFixed(1)); drop.setAttribute('cy', (cy + Math.sin(pd.plan.angle) * r * flat).toFixed(1)); drop.setAttribute('r', pr + 3 * K);
      } else show(drop, false);
      /* labels, placed greedily every few frames: each tries a few spots and takes the first that clears the earlier ones */
      const relay = sc.labTick++ % 4 === 0, used = [], fs = 14 * K, over = (a, c) => a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0;
      const labsOf = list.filter((b) => !b.sun).sort((a, b) => (b.p.need - a.p.need) || (LY.L.get(a.id).ring - LY.L.get(b.id).ring));
      if (sc.sun) labsOf.unshift(list.find((b) => b.sun));
      labsOf.forEach((b) => {
        const el = b.sun ? sunLab : b.e.lab, tw = textW(b.p.name, sc.font), g = b.r + (b.p.need ? 11 : 6) * K, box = ([lx, ly, al]) => { const x0 = al === 'start' ? lx : lx - tw; return { x0: x0 - 2, x1: x0 + tw + 2, y0: ly - fs * .8, y1: ly + fs * .3 }; };
        let c = sc.labC.get(b.id);
        if (relay || !c) {
          const cand = b.sun ? [[b.x - tw / 2, b.y + b.r + fs * 1.1, 'start']] : [[b.x + g, b.y + fs * .35, 'start'], [b.x - g, b.y + fs * .35, 'end'], [b.x + g * .8, b.y + b.r + fs, 'start'], [b.x - g * .8, b.y + b.r + fs, 'end'], [b.x + g * .8, b.y - b.r - fs * .4, 'start'], [b.x - g * .8, b.y - b.r - fs * .4, 'end'], [b.x - tw / 2, b.y + b.r + fs * 1.3, 'start'], [b.x - tw / 2, b.y - b.r - fs * .8, 'start']];
          let pos = null, best = 1e9; /* inside the panel, the spot that covers the fewest earlier labels */
          cand.forEach((k) => { const bx = box(k); if (bx.x0 < 4 || bx.x1 > W - 4 || bx.y0 < 4 || bx.y1 > H - 4) return; const hits = used.filter((u) => over(bx, u)).length; if (hits < best) { best = hits; pos = k; } });
          if (!pos) { /* no spot fits: kept inside the panel */
            pos = cand[0].slice(); if (pos[2] === 'start' && pos[0] + tw > W - 4) { pos[0] = b.x - g; pos[2] = 'end'; }
            pos[0] = pos[2] === 'start' ? Math.max(4, pos[0]) : Math.min(W - 4, Math.max(4 + tw, pos[0])); pos[1] = Math.max(fs, Math.min(H - 4, pos[1]));
          }
          c = { dx: pos[0] - b.x, dy: pos[1] - b.y, al: pos[2] }; sc.labC.set(b.id, c);
        }
        const pos = [b.x + c.dx, b.y + c.dy, c.al]; used.push(box(pos));
        el.setAttribute('x', pos[0].toFixed(1)); el.setAttribute('y', pos[1].toFixed(1)); if (el._al !== c.al) { el._al = c.al; el.setAttribute('text-anchor', c.al); }
      });
      /* what the pointer is on */
      if (!sc.drag) {
        const h = sc.mouse ? hitAt(sc.mouse[0], sc.mouse[1]) : null;
        if (h) { sc.hover = h.id; root.classList.add('hov'); showCard(h); }
        else if (sc.hover) { sc.hover = null; root.classList.remove('hov'); hideSoon(); } /* time to reach the card before it goes */
      }
    }
    return sc;
  }

  M.projects = {
    label: 'Projects', icon: 'orbit', views: [['solar', 'orbit', 'Star system'], ['cards', 'grid', 'Cards']], workView: 'cards',
    render: (vp) => {
      const ps = allProjects().sort((a, b) => b.last - a.last);
      if ((vp.state.view || 'solar') === 'cards') return `<div class="pcards">${ps.map((p) => `<div class="pcard ${p.name === S.project ? 'on' : ''}" data-proj="${esc(p.name)}"><div class="row"><span class="tint" style="background:${p.tint}">${esc(p.name[0])}</span><div class="grow"><div class="pn ellip">${esc(p.name)}</div><div class="faint ellip" style="font-size:calc(14px*var(--k))">${esc(p.lastCommit ? p.lastCommit.subject || '' : p.about || '')}</div></div></div>
        <div class="row" style="gap:calc(8px*var(--k));flex-wrap:wrap">${p.running ? MC.st('run', p.running + ' running') : MC.st('idle', 'Idle')}${(p.needsReasons || []).length ? MC.st('warn', p.needsReasons[0]) : ''}<span class="grow"></span><span class="faint" style="font-size:calc(14px*var(--k))">${p.last ? esc(ago(new Date(p.last).toISOString())) : ''}</span></div></div>`).join('')}</div>`;
      return '<div class="solar ss-host"></div>';
    },
    mount: (el, vp) => {
      const go = (e) => { const p = e.target.closest('[data-proj]'); if (!p) return; openConv(p.dataset.proj, null, e.ctrlKey || e.metaKey || e.button === 1); };
      el.onclick = go; el.onauxclick = (e) => { if (e.button === 1) go(e); };
      const host = $('.ss-host', el); if (!host) return;
      SCN.forEach((s, k) => { if (k !== vp.id && !s.root.isConnected) SCN.delete(k); }); /* closed panels */
      let sc = SCN.get(vp.id); if (!sc) { sc = makeScene(); SCN.set(vp.id, sc); }
      host.appendChild(sc.root); sc.sync(allProjects());
      if (!LY.loaded && !LY.busy) loadLayout();
      if (!SRV.at) loadServers();
    },
  };

  /* ---------- Timeline: time spent, from the usage index (today and the last 7 days) ---------- */
  const TL = { day: null, week: null, at: 0, busy: false, err: '' };
  const day0 = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  async function loadTimeline() {
    if (TL.busy) return; TL.busy = true;
    try { const now = Date.now(); [TL.day, TL.week] = await Promise.all([api.get(`/api/usage/stats?from=${day0()}&to=${now + 60000}`), api.get(`/api/usage/stats?from=${day0() - 6 * 86400000}&to=${now + 60000}`)]); TL.err = ''; }
    catch (e) { TL.err = errText(e); }
    TL.busy = false; TL.at = Date.now(); rerender('timeline');
  }
  M.timeline = {
    label: 'Timeline', icon: 'gantt', tabs: ['Day', 'Week'], scope: true,
    render: (vp) => {
      if (!TL.at || Date.now() - TL.at > 5 * 60000) loadTimeline();
      if (!TL.day) return TL.err ? `<div class="lv-err">${esc(TL.err)}</div>` : '<div class="lv-empty">' + I('loader', 'sm') + 'Adding up</div>';
      const all = vp.state.scope === 'all' || !S.project, pid = (LV.byName[S.project] || {}).id;
      const pOf = (s) => (all ? null : (s.projects || []).find((p) => p.id === pid));
      const dayMs = all ? TL.day.total.activeMs : (pOf(TL.day) || {}).activeMs || 0, weekMs = all ? TL.week.total.activeMs : (pOf(TL.week) || {}).activeMs || 0;
      const topW = (TL.week.projects || []).filter((p) => p.activeMs).sort((a, b) => b.activeMs - a.activeMs);
      /* hours of the account (the index keeps hours for the whole account only) */
      const hrs = (s, from) => (s.hours || []).filter((h) => h.h * 3600e3 >= from).map((h) => ({ t: h.h * 3600e3, a: h.a || 0 }));
      const tiles = `<div class="tiles"><div class="tile"><div class="tl">Today</div><div class="tv">${dur(dayMs)}</div><div class="ts">${all ? 'every project' : esc(S.project)}</div></div><div class="tile"><div class="tl">7 days</div><div class="tv">${dur(weekMs)}</div><div class="ts">${esc(new Date(day0() - 6 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} to today</div></div>${all && topW[0] ? `<div class="tile"><div class="tl">Most time</div><div class="tv ellip">${esc(topW[0].name || 'No project')}</div><div class="ts">${Math.round(topW[0].activeMs / Math.max(1, weekMs) * 100)}% of 7 days</div></div>` : ''}</div>`;
      const bars = (vals, labels, now) => { const max = Math.max(1, ...vals); return `<div class="tbars">${vals.map((v, i) => `<span class="cb ${i === now ? 'now' : ''}" title="${esc(labels[i])}: ${dur(v)}"><i style="height:${Math.max(v > 0 ? 3 : 0, v / max * 100)}%"></i></span>`).join('')}</div><div class="tbl2">${labels.map((l, i) => `<span>${i % (labels.length > 12 ? 3 : 1) ? '' : esc(l)}</span>`).join('')}</div>`; };
      const list = (s) => { const ps = (s.projects || []).filter((p) => p.activeMs).sort((a, b) => b.activeMs - a.activeMs); const max = Math.max(1, ...ps.map((p) => p.activeMs)); return ps.map((p) => `<div class="tpr" data-proj="${esc(p.name || '')}">${p.name ? MC.pchip(p.name) : '<span class="faint">No project</span>'}<span class="bar"><i style="width:${p.activeMs / max * 100}%"></i></span><b class="mono">${dur(p.activeMs)}</b></div>`).join('') || '<div class="faint">Nothing yet</div>'; };
      const convs = (s) => (s.conversations || []).filter((c) => (c.projects || []).includes(pid) && c.activeMs).sort((a, b) => b.activeMs - a.activeMs).slice(0, 12).map((c) => `<div class="tpr" data-proj="${esc(S.project)}" data-sid="${esc(c.id)}"><span class="ellip">${esc(c.title || 'Untitled')}</span><span class="grow"></span><b class="mono">${dur(c.activeMs)}</b></div>`).join('') || '<div class="faint">Nothing yet</div>';
      /* the day as a chart: a bar per conversation (or per project, for every project) from its first to its last hour */
      const gantt = () => {
        const t0 = day0(), hr = (iso) => (toMs(iso) - t0) / 3600e3, pos = (h) => Math.max(0, Math.min(100, h / 24 * 100));
        const cs = (TL.day.conversations || []).filter((c) => c.activeMs && c.first && (all || (c.projects || []).includes(pid)));
        let lanes;
        if (all) {
          const by = {};
          cs.forEach((c) => { const id = (c.projects || [])[0] || ''; const l = by[id] || (by[id] = { id, ms: 0, sp: [] }); l.ms += c.activeMs; l.sp.push([hr(c.first), hr(c.last) + 1]); });
          lanes = Object.values(by).sort((a, b) => b.ms - a.ms).slice(0, 10).map((l) => { const nm = (LV.byId[l.id] || {}).name; return { lab: nm ? MC.pchip(nm) : '<span class="faint">No project</span>', col: nm ? MC.projectInfo(nm).tint : 'var(--idle)', sp: l.sp, tot: dur(l.ms), proj: nm || '' }; });
        } else {
          lanes = cs.sort((a, b) => b.activeMs - a.activeMs).slice(0, 10).map((c) => { const run = (LV.runs || []).some((r) => r.running && r.sessionId === c.id); return { lab: `${I(run ? 'loader' : 'tick', 'sm')}<span class="ellip">${esc(c.title || 'Untitled')}</span>`, col: run ? 'var(--run)' : 'var(--ok)', sp: [[hr(c.first), hr(c.last) + 1]], tot: dur(c.activeMs) + (run ? ', running' : ''), proj: S.project, sid: c.id }; });
        }
        if (!lanes.length) return '';
        const now = (Date.now() - t0) / 3600e3, ticks = [0, 6, 12, 18].map((h) => `<span style="left:${pos(h)}%">${h}:00</span>`).join('');
        return `<div class="tlg tlg-real"><div class="tlr hd"><div class="lab faint">${all ? 'Project' : 'Conversation'}</div><div class="trk ticks">${ticks}</div><div class="tot faint">Time</div></div>${lanes.map((l) => `<div class="tlr tpr" data-proj="${esc(l.proj)}"${l.sid ? ` data-sid="${esc(l.sid)}"` : ''}><div class="lab">${l.lab}</div><div class="trk">${l.sp.map(([a, b]) => `<span class="sp" style="left:${pos(a)}%;width:${Math.max(.6, pos(b) - pos(a))}%;background:${l.col}"></span>`).join('')}<span class="nowl" style="left:${pos(now)}%"></span></div><div class="tot">${l.tot}</div></div>`).join('')}</div>`;
      };
      /* the week as a bar per day, in the colors of the projects (each conversation counts on the day of its last hour) */
      const weekRows = (days) => {
        const per = days.map(() => ({}));
        (TL.week.conversations || []).filter((c) => c.activeMs && c.last && (all || (c.projects || []).includes(pid))).forEach((c) => {
          const t = toMs(c.last), i = days.findIndex((d, k) => t >= d && (k === 6 || t < days[k + 1])); if (i < 0) return;
          const id = (c.projects || [])[0] || ''; per[i][id] = (per[i][id] || 0) + c.activeMs;
        });
        const max = Math.max(1, ...per.map((o) => Object.values(o).reduce((a, b) => a + b, 0)));
        return `<div class="wks">${days.map((d, i) => { const ps = Object.entries(per[i]).sort((a, b) => b[1] - a[1]), sum = ps.reduce((a, p) => a + p[1], 0);
          return `<div class="wk"><span class="wd">${esc(new Date(d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }))}</span><span class="wbar">${ps.map(([id, ms]) => { const nm = (LV.byId[id] || {}).name || 'No project'; return `<i style="width:${ms / max * 100}%;background:${nm === 'No project' ? 'var(--idle)' : MC.projectInfo(nm).tint}" title="${esc(nm)}: ${dur(ms)}"></i>`; }).join('')}</span><span class="wt">${sum ? dur(sum) : 'none'}</span></div>`; }).join('')}</div>`;
      };
      if (vp.tab === 'Week') {
        const days = Array.from({ length: 7 }, (_, i) => day0() - (6 - i) * 86400000);
        return `<div class="tlm">${tiles}<div class="sect-h">Each day</div>${weekRows(days)}<div class="sect-h">${all ? 'Projects' : 'Conversations'}</div>${all ? list(TL.week) : convs(TL.week)}</div>`;
      }
      const v = Array(24).fill(0); hrs(TL.day, day0()).forEach((h) => { v[new Date(h.t).getHours()] += h.a; });
      const g = gantt();
      return `<div class="tlm">${tiles}${g || `<div class="sect-h">${all ? 'Projects' : 'Conversations'}</div>${all ? list(TL.day) : convs(TL.day)}`}${all ? `<div class="sect-h">Each hour</div>${bars(v, v.map((_, i) => i + ':00'), new Date().getHours())}` : ''}</div>`;
    },
    mount: (el) => { el.onclick = (e) => { const r = e.target.closest('.tpr[data-proj]'); if (r && r.dataset.proj) openConv(r.dataset.proj, r.dataset.sid, e.ctrlKey || e.metaKey); }; },
  };

  /* ---------- Morning brief: today in numbers, and what finished ---------- */
  const JB = { list: null, at: 0 };
  async function loadJobs() { try { const d = await api.get('/api/jobs'); JB.list = (d && d.runs) || []; } catch (e) { JB.list = JB.list || []; } JB.at = Date.now(); rerender('brief'); }
  MC.events.on('job', (d) => { if (d && d.done) loadJobs(); });
  M.brief = {
    label: 'Morning brief', icon: 'sun',
    render: () => {
      if (!JB.at || Date.now() - JB.at > 60000) loadJobs();
      if (!NEED.at) loadNeeds();
      const t0 = day0(), runs = (LV.runs || []).filter((r) => !r.running && toMs(r.endedAt) >= t0), jobs = (JB.list || []).filter((j) => j.endedAt && toMs(j.endedAt) >= t0);
      const work = D.agents.filter((a) => a.state === 'run').length, wait = D.agents.filter((a) => a.state === 'wait').length;
      const q = NEED.perms.filter((p) => p.tool === 'AskUserQuestion').length, pm = NEED.perms.length - q, pn = projNeeds().length;
      const u = LV.usage && LV.usage.fiveHour;
      const fail = (s) => /fail|error/.test(s || '');
      const done = runs.map((r) => ({ t: toMs(r.endedAt), icon: 'chat', what: (LV.rows[r.sessionId] && LV.rows[r.sessionId].title) || r.promptPreview || 'Conversation', proj: projOf(r.projectId, r.sessionId), sid: r.sessionId, bad: fail(r.state), st: r.state }))
        .concat(jobs.map((j) => ({ t: toMs(j.endedAt), icon: 'play', what: j.label || j.jobId, proj: (LV.byId[j.projectId] || {}).name, bad: fail(j.state) || (j.code != null && j.code !== 0), st: j.state }))).sort((a, b) => b.t - a.t);
      const parts = (...xs) => xs.filter((x) => x[0]).map((x) => x[0] + ' ' + x[1] + (x[0] === 1 ? '' : 's')).join(', ') || 'none';
      return `<div class="brief"><div class="kpis"><div class="kpi warn"><span>Needs you</span><b>${NEED.perms.length + pn}</b><i>${I('clock', 'sm')}${esc(parts([pm, 'permission'], [q, 'question'], [pn, 'project']))}</i></div><div class="kpi run"><span>Running</span><b>${D.agents.length}</b><i>${I('loader', 'sm')}${work} working, ${wait} waiting</i></div><div class="kpi ok"><span>Finished today</span><b>${done.length}</b><i>${I('tick', 'sm')}${esc(parts([runs.length, 'conversation'], [jobs.length, 'job']))}</i></div><div class="kpi"><span>Session</span><b>${u ? Math.round(u.pct) + '%' : '--'}</b><i>${I('clock', 'sm')}${u && u.resetsAt ? 'resets ' + esc(hhmm(toMs(u.resetsAt))) : ''}</i></div></div>
        <div class="sect-h">Finished today</div>${done.slice(0, 12).map((x) => `<div class="li bdone" ${x.sid ? `data-sid="${esc(x.sid)}" data-proj="${esc(x.proj || '')}"` : ''}>${I(x.icon, 'sm')}<span class="grow ellip">${esc(x.what)}</span>${x.proj ? MC.pchip(x.proj) : ''}${x.bad ? MC.st('fail', x.st === 'stopped' ? 'Stopped' : 'Failed') : ''}<span class="faint mono">${esc(hhmm(x.t))}</span></div>`).join('') || '<div class="faint">Nothing yet</div>'}</div>`;
    },
    mount: (el) => { el.onclick = (e) => { const r = e.target.closest('.bdone[data-sid]'); if (r && r.dataset.proj) openConv(r.dataset.proj, r.dataset.sid, e.ctrlKey || e.metaKey); }; },
  };

  /* ---------- Com Link: questions to the assistant, typed or spoken, answered (and read aloud when spoken) ---------- */
  const CL = { prefs: null, haiku: null, status: 'idle', run: null, sessionId: null, q: '', a: '', err: '', voice: false, dict: null, link: 'idle', avail: false, listen: false, live: '', archiveRun: null };
  async function clPrefs() {
    try { CL.prefs = await api.get('/api/voice/prefs'); } catch (e) { CL.prefs = CL.prefs || {}; }
    try { const o = await api.get('/api/chat/options'); const h = ((o && o.models) || []).find((m) => /haiku/i.test(m.id + ' ' + (m.label || '')) && !m.disabled); CL.haiku = h ? h.id : null; } catch (e) { /* the server picks */ }
    rerender('comlink');
  }
  const textOf = (ev) => (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) ? ev.message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '');
  async function clSend(text, voice) {
    text = String(text || '').trim(); if (!text) return;
    if (!CL.prefs) await clPrefs();
    const P = CL.prefs || {};
    CL.q = text; CL.a = ''; CL.err = ''; CL.voice = !!voice;
    if (CL.run && (CL.status === 'thinking')) { api.post('/api/chat', { prompt: text, runId: CL.run }).catch((e) => { CL.err = errText(e); rerender('comlink'); }); rerender('comlink'); return; }
    CL.status = 'thinking'; rerender('comlink');
    const body = { prompt: text, source: 'comlink', model: P.comlinkModel || CL.haiku || undefined, effort: P.comlinkEffort || 'medium', mode: P.comlinkMode || 'auto' };
    if (P.comlinkPersona !== false) body.persona = 'comlink';
    if (CL.sessionId) body.sessionId = CL.sessionId;
    if (!body.model) delete body.model;
    try { const r = await api.post('/api/chat', body); CL.run = r && r.runId; }
    catch (e) { CL.status = 'idle'; CL.err = 'Not sent: ' + errText(e); rerender('comlink'); }
  }
  MC.events.on('chat', (d) => {
    if (d && CL.archiveRun && d.runId === CL.archiveRun) {
      const sid = d.sessionId || (d.event && typeof d.event.session_id === 'string' && d.event.session_id);
      if (sid) { CL.archiveRun = null; api.post(`/api/sessions/${enc(sid)}/archive`, { archived: true }).catch(() => {}); } else if (d.done) CL.archiveRun = null;
    }
    if (!d || !CL.run || d.runId !== CL.run || d.sent) return;
    const t = textOf(d.event); if (t) { CL.a += (CL.a ? '\n' : '') + t; paintLog(); }
    if (d.event && typeof d.event.session_id === 'string') CL.sessionId = d.event.session_id;
    if (d.turnDone || d.done) {
      if (d.sessionId) CL.sessionId = d.sessionId;
      if (d.turnDone && d.ok === false) CL.err = 'Claude reported an error';
      if (d.done && d.state === 'stopped') CL.err = 'Stopped';
      CL.status = 'idle';
      if (CL.voice && CL.a && !CL.err) MC.speakReply(CL.a, 'cl:' + CL.run + ':' + CL.a.length, true);
      rerender('comlink');
    }
  });
  /* ---- listening: the mic or the wake word starts a dictation with live words and no automatic stop ----
     The send phrase ("send it") sends what was said, the cancel phrase ("cancel that") drops it, the rewrite phrase ("start over")
     drops the words and listens again, the end phrase ("end conversation") ends the conversation: a reply under way stops, the
     conversation is archived and the next question starts a new one. A phrase counts once the words stay the same for 400 ms.
     While listening the mic button sends what is there. Nothing said for the "Stop listening after" time closes the mic. */
  const CLW = MC.PhraseWatch ? new MC.PhraseWatch({ phrases: () => MC.phrases(true), onAct: (kind, rest) => clAct(kind, rest) }) : null;
  function clBegin(id) {
    CL.listen = true; CL.dict = id == null ? null : String(id); CL.live = ''; CL.err = ''; if (CLW) CLW.reset();
    clearTimeout(CL.quietT); CL.quietT = setTimeout(() => { if (CL.listen && !CL.live.trim()) clCancel(); }, Math.max(5, +MC.vprefs.listenSilenceSec || 30) * 1000);
    MC.sound.play('listen'); rerender('comlink');
  }
  function clOver() { clearTimeout(CL.quietT); clearTimeout(CL.lostT); if (CL.dict) MC.wakeDone(CL.dict); CL.listen = false; CL.dict = null; CL.live = ''; if (CLW) CLW.reset(); }
  function clCancel() { clOver(); MC.discardDictation(); MC.sound.play('cancel'); rerender('comlink'); }
  function clEnd() {
    clOver(); MC.discardDictation();
    if (CL.run && CL.status === 'thinking') api.post(`/api/runs/${enc(CL.run)}/stop`, {}).catch(() => {});
    if (CL.sessionId) api.post(`/api/sessions/${enc(CL.sessionId)}/archive`, { archived: true }).catch(() => {}); else if (CL.run) CL.archiveRun = CL.run;
    if (CL.link === 'speaking') MC.stopSpeaking();
    CL.sessionId = null; CL.run = null; CL.status = 'idle'; CL.q = ''; CL.a = ''; CL.err = '';
    MC.sound.play('cancel'); rerender('comlink');
  }
  async function clRewrite() {
    clOver(); await MC.discardDictation(); rerender('comlink');
    for (let t0 = Date.now(); CL.link !== 'idle' && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 60));
    try { const r = await api.post('/api/voice/start', { partials: true, autostop: 'none', cleanup: false }); if (r && r.id != null) { clBegin(r.id); return; } } catch (e) { /* below */ }
    CL.err = 'Could not start listening again'; MC.sound.play('cancel'); rerender('comlink');
  }
  function clSendSpoken(text) { clOver(); MC.discardDictation(); MC.sound.play('send'); clSend(text, true); }
  function clAct(kind, rest) {
    if (!CL.listen) return;
    if (kind === 'cancel') return clCancel();
    if (kind === 'end') return clEnd();
    if (kind === 'rewrite') return clRewrite();
    if (!String(rest || '').trim()) return clCancel();
    clSendSpoken(rest);
  }
  /* the mic button while listening: what was said goes now */
  function clSendNow() { const d = MC.detectPhrase(CL.live, true); if (d) return clAct(d.kind, d.rest); const t = CL.live.trim(); if (!t) return clCancel(); clSendSpoken(t); }
  function clPartial(text) { CL.live = text; $$('.cl-partial').forEach((p) => { p.textContent = text; }); if (CLW) CLW.push(text); }
  /* the dictation ended by itself (or by BlitzVoice's hotkey): the same phrases apply to its text */
  function clFinal(text, err) {
    if (!CL.listen) return;
    if (err) { clOver(); CL.err = err === 'timeout' ? 'The dictation timed out, so nothing was sent' : 'BlitzVoice could not write that out'; MC.sound.play('cancel'); rerender('comlink'); return; }
    const d = MC.detectPhrase(text, true); if (d && d.kind !== 'send') return clAct(d.kind, d.rest);
    const t = String(d ? d.rest : text).trim(); clOver();
    if (!t) { MC.sound.play('cancel'); rerender('comlink'); return; }
    MC.sound.play('send'); clSend(t, true);
  }
  async function clMic() {
    if (CL.link === 'speaking') { MC.stopSpeaking(); return; }
    if (CL.listen) { clSendNow(); return; }
    if (!CL.avail) { MC.toast('The Com Link needs BlitzVoice running, with its Mission Control link on', 'mic'); return; }
    if (CL.link !== 'idle') return;
    try { const r = await api.post('/api/voice/start', { partials: true, autostop: 'none', cleanup: false }); if (r && r.id != null) clBegin(r.id); } catch (e) { MC.toast('The mic did not start: ' + errText(e), 'warn'); }
  }
  /* Stop: the answer being written, or the voice reading it */
  function clStop() { if (CL.link === 'speaking') MC.stopSpeaking(); if (CL.run && CL.status === 'thinking') api.post(`/api/runs/${enc(CL.run)}/stop`, {}).catch((e) => MC.toast('Could not stop: ' + errText(e), 'warn')); }
  MC.voiceSinks.comlink = {
    wake: (id) => { if (!CL.listen) clBegin(id); },
    partial: (id, text) => { if (!CL.listen) clBegin(id); if (CL.dict == null) CL.dict = id; if (id === CL.dict) clPartial(text); },
    final: (id, text, err) => { if (!CL.listen) { CL.listen = true; CL.dict = id; } if (id === CL.dict) clFinal(text, err); },
  };
  MC.events.on('voice', (d) => {
    if (!d) return;
    if (d.kind === 'status') CL.avail = !!d.available;
    if (d.kind === 'state') {
      CL.link = d.state || 'idle'; rerender('comlink');
      /* the dictation ended some other way and no text came: stop waiting for it */
      clearTimeout(CL.lostT); if (CL.listen && CL.link === 'idle') CL.lostT = setTimeout(() => { if (CL.listen && CL.link === 'idle') { clOver(); MC.sound.play('cancel'); rerender('comlink'); } }, 2500);
    }
    if (d.kind === 'partial' && !d.wake && CL.dict && String(d.id) === CL.dict) clPartial(String(d.text || ''));
    if (d.kind === 'transcript' && !d.wake && CL.dict && String(d.id) === CL.dict) clFinal(String(d.text || '').replace(/\s+/g, ' ').trim(), d.error ? String(d.error) : '');
  });
  function paintLog() { $$('.cl-log').forEach((l) => { l.innerHTML = logHtml(); }); }
  const logHtml = () => (CL.q ? `<div><b>You</b> ${esc(CL.q)}</div>` : '') + (CL.a ? `<div class="cl-a"><b>${esc((CL.prefs && CL.prefs.comlinkName) || 'Com Link')}</b> ${esc(CL.a.length > 600 ? CL.a.slice(0, 600) + '...' : CL.a)}</div>` : '') + (CL.err ? `<div class="lv-err">${esc(CL.err)}</div>` : '') + (CL.listen ? `<div class="cl-partial faint">${esc(CL.live)}</div>` : '');
  /* the face: the red HAL eye or Clawd (face.js draws them), as on the old pages; work mode shows the plain mic */
  const faceState = () => (CL.link === 'recording' || CL.listen ? 'listening' : CL.link === 'speaking' ? 'speaking' : CL.status === 'thinking' || CL.link === 'transcribing' ? 'thinking' : 'idle');
  M.comlink = {
    label: 'Com Link', icon: 'hal', views: [['hal', 'hal', 'HAL eye'], ['clawd', 'sparkle', 'Clawd'], ['plain', 'mic', 'Plain']], workView: 'plain',
    render: (vp) => {
      if (!CL.prefs) clPrefs();
      const look = vp.state.view || (CL.prefs && CL.prefs.comlinkLook) || 'hal', fs = faceState();
      MC.setFace && MC.setFace(fs);
      const lab = { listening: 'Listening', speaking: 'Talking', thinking: CL.link === 'transcribing' ? 'Writing it out' : 'Thinking', idle: 'Standing by' }[fs];
      const name = (CL.prefs && CL.prefs.comlinkName) || 'Com Link';
      const run = D.agents.filter((a) => a.state === 'run').slice(0, 3);
      return `<div class="cl cs-${fs}"><div class="cl-face">${look === 'plain' ? `<div class="face plain">${I('mic', 'lg')}<span class="wave">${'<i></i>'.repeat(5)}</span></div>` : `<canvas class="cl-eye" data-eye="big" data-look="${look === 'clawd' ? 'clawd' : 'hal'}"></canvas>`}</div><div class="cl-state h">${esc(lab)}</div>
        <div class="cl-log">${logHtml()}</div>
        ${run.length ? `<div class="cl-run"><div class="sect-h">Running now</div>${run.map((a) => `<div class="row clr" data-sid="${esc(a.sid || '')}" data-proj="${esc(a.proj)}"><span class="dot run pulse"></span><span class="ellip grow">${esc(a.proj)}: ${esc(a.job)}</span><span class="faint">${esc(a.for)}</span></div>`).join('')}</div>` : '<div class="cl-run"></div>'}
        <div class="cl-in input"><input placeholder="Ask ${esc(name)}">${CL.status === 'thinking' || CL.link === 'speaking' ? `<button class="cl-stop" title="Stop">${I('stop', 'sm')}</button>` : ''}<button class="cl-mic ${CL.listen ? 'on' : ''}" title="${CL.listen ? 'Send what you said' : CL.link === 'speaking' ? 'Stop talking' : 'Talk'}">${I(CL.listen ? 'send' : CL.link === 'speaking' ? 'stop' : 'mic')}</button></div></div>`;
    },
    mount: (el) => {
      const mic = $('.cl-mic', el); if (mic) mic.onclick = clMic;
      const stop = $('.cl-stop', el); if (stop) stop.onclick = clStop;
      const i = $('.cl-in input', el); if (i) i.onkeydown = (e) => { if (e.key === 'Enter' && i.value.trim()) { const t = i.value; i.value = ''; clSend(t, false); } };
      const run = $('.cl-run', el); if (run) run.onclick = (e) => { const r = e.target.closest('[data-sid]'); if (r) openConv(r.dataset.proj, r.dataset.sid, e.ctrlKey || e.metaKey); };
    },
  };
  api.get('/api/voice').then((v) => { CL.avail = !!(v && v.available); CL.link = (v && (v.link || v.state)) || 'idle'; }).catch(() => {});

  /* fresh numbers when the runs or the projects change */
  LV.ready && LV.ready.then(() => { loadNeeds(); setInterval(() => { if (document.visibilityState === 'visible') loadNeeds(); }, 30000); });
})();
