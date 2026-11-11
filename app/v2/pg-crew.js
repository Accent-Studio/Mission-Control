/* Mission Control 2: the crew, without the ship. What works in the project now: each Claude conversation that is busy, what it
   does (its last tool, in plain words), and its helpers (subagents) with their task, kind, model and time.
   Ported from the project page's Running panel (project.html). Loads after panels.js. */
(() => {
  const { $$, esc, icon: I, state: S } = MC;
  const M = MC.modules, api = MC.api, H = MC.live.helpers;
  const enc = encodeURIComponent;
  const realPid = () => { const id = H.pidOf(); return id && !H.isRootId(id) && !H.isChatId(id) ? id : null; };
  const plain = (t) => String(t == null ? '' : t).replace(/\*\*|__|`/g, '').replace(/^\s*#+\s*/, '').trim();

  /* ---------- what the words say ---------- */
  const TOOLSAY = { Read: 'Reading', Grep: 'Searching', Glob: 'Searching', Edit: 'Editing', Write: 'Writing', Bash: 'Running', WebSearch: 'Looking up', WebFetch: 'Looking up', Agent: 'Sending helpers', Task: 'Sending helpers' };
  const modelName = (m) => { const s = String(m || ''), k = s.match(/(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)-(\d+))?/i); if (!k) return s; return k[1][0].toUpperCase() + k[1].slice(1).toLowerCase() + (k[2] ? ` ${k[2]}.${k[3]}` : ''); };
  /* what a helper is, by its type first and then by the words of its description (the same rule the ship uses for its rooms) */
  const KIND_RE = {
    model3d: /\b(3d|blender|mesh|render|rendering|model(?:ing|ling)?|sculpt|rig|geometry|three\.?js)\b/i,
    art: /\b(image|images|icon|logo|art|design|draw|drawing|paint|illustrat\w*|sprite|texture|mockup|palette|animation|visual|ui|css|style|theme|layout|polish|cosmetic|shader|svg|font|screenshot art)\b/i,
    code: /\b(fix|edit|implement\w*|write|add|refactor|code|patch|change|update|create|wire|port|migrate|rename|remove|delete|move|rewrite|script|endpoint|server|api|function)\b/i,
    test: /\b(test|tests|testing|build|builds|compile|lint|audit|verify|validat\w*|qa|review|regression|benchmark|install|release|screenshots?)\b/i,
  };
  function kindOf(g) {
    const ty = String(g.type || '').toLowerCase(), ds = String(g.description || '');
    if (/^(explore|plan|claude-code-guide)$|research|scout/.test(ty)) return 'Researcher';
    if (/statusline|coder|developer|engineer|implement/.test(ty)) return 'Coder';
    if (/test|qa|review|audit|verif/.test(ty)) return 'Tester';
    if (/design|art|image|frontend|ui/.test(ty)) return KIND_RE.model3d.test(ds) ? '3D modeler' : 'Artist';
    if (KIND_RE.model3d.test(ds)) return '3D modeler';
    if (KIND_RE.art.test(ds)) return 'Artist';
    if (KIND_RE.code.test(ds)) return 'Coder';
    if (KIND_RE.test.test(ds)) return 'Tester';
    return 'Researcher';
  }
  /* what a conversation is doing now: its last tool call, else the last thing it said */
  const doingNow = (s) => { const t = s.lastTool; if (t && t.name) return (TOOLSAY[t.name] || 'Using ' + String(t.name).replace(/^mcp__/, '').replace(/_+/g, ' ')) + (t.hint ? ' ' + t.hint : ''); return s.text || ''; };
  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), p = (n) => String(n).padStart(2, '0'); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + ' min ' + p(s % 60) + 's'; return Math.floor(s / 3600) + 'h ' + p(Math.floor(s % 3600 / 60)) + ' min'; };
  const dur = (since) => (since ? `<span class="faint mono cr-dur" data-since="${since}">${fmtDur(Date.now() - since)}</span>` : '');

  /* ---------- the data: GET /api/projects/:id/crew every 3 s while a Crew panel shows (backing off to 30 s after failures,
     nothing while the page is hidden), nudged early by the chat stream ---------- */
  const C = {}; /* project id -> { list, fails, err, busy, at, sig, turn: session id -> when its stretch of work began (0 unknown) } */
  const crewOf = (pid) => C[pid] || (C[pid] = { list: null, fails: 0, err: '', busy: false, at: 0, sig: '', turn: new Map() });
  const wait = (c) => Math.min(30000, 3000 * Math.pow(2, Math.max(0, c.fails - 1)));
  /* repaint only when something changed, so a hovered or focused row stays put */
  const paint = (c) => { const sig = JSON.stringify([c.list, c.fails > 0, [...c.turn]]); if (sig !== c.sig) { c.sig = sig; MC.emit('rerender', 'crew'); } };
  async function poll(pid) {
    const c = crewOf(pid); if (c.busy) return; c.busy = true;
    try {
      const d = await api.get(`/api/projects/${enc(pid)}/crew`);
      if (!d || !Array.isArray(d.sessions)) throw new Error('unexpected answer');
      c.list = d.sessions; c.fails = 0; c.err = '';
      const ids = new Set(c.list.filter((s) => s.id).map((s) => s.id));
      [...c.turn.keys()].forEach((k) => { if (!ids.has(k)) c.turn.delete(k); });
      ids.forEach((k) => { if (!c.turn.has(k)) loadTurnStart(c, k); });
    } catch (e) { c.fails++; c.err = H.errText(e); /* keep the last picture */ }
    c.busy = false; c.at = Date.now(); paint(c);
  }
  /* your last message, or the open turn's own start: a long run has more than 40 tool calls since your message */
  async function loadTurnStart(c, sid) {
    c.turn.set(sid, 0);
    try {
      const s = await api.get(`/api/sessions/${enc(sid)}?limit=40`);
      const msgs = s.messages || [], m = msgs.filter((x) => x.role === 'user' && x.at).pop(), tm = msgs.filter((x) => x.turn && x.turn.startedAt).pop();
      /* while a process answers, the saved part stops where the turn began, so the turn's own start (s.live) is the one to count from */
      const liveAt = MC.liveTurn ? MC.liveTurn.startedAt(s) : null;
      const at = liveAt !== null ? liveAt : Math.max(m ? Date.parse(m.at) || 0 : 0, tm ? Date.parse(tm.turn.startedAt) || 0 : 0);
      if (c.turn.has(sid)) c.turn.set(sid, at);
    } catch (e) { /* no start time: the row shows no duration */ }
    paint(c);
  }
  /* the projects a Crew panel shows on screen now */
  const shown = () => [...new Set($$('.crew[data-pid]').filter((e) => e.getClientRects().length).map((e) => e.dataset.pid))];
  setInterval(() => {
    if (document.hidden) return;
    const now = Date.now();
    shown().forEach((pid) => { const c = crewOf(pid); if (!c.busy && now - c.at >= wait(c)) poll(pid); });
    $$('.crew [data-since]').forEach((e) => { e.textContent = fmtDur(now - Number(e.dataset.since)); });
  }, 1000);
  /* chat news that can change the list: a run ending, a helper sent out, a tool answered (a helper may be done) */
  let kickAt = 0;
  MC.events.on('chat', (d) => {
    if (!d || document.hidden || Date.now() - kickAt < 1500) return;
    const c = d.event && d.event.message && Array.isArray(d.event.message.content) ? d.event.message.content : [];
    if (d.done || c.some((b) => b && (b.type === 'tool_result' || (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'))))) { kickAt = Date.now(); setTimeout(() => shown().forEach(poll), 700); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) shown().forEach(poll); });

  /* ---------- the panel ---------- */
  function runRow(c, s) {
    const title = plain(s.title) || 'Untitled conversation', model = modelName(s.model), doing = doingNow(s), agents = s.agents || [];
    const since = s.id ? c.turn.get(s.id) : Date.parse(s.lastAt); /* a run with no conversation yet counts from its start */
    return `<div class="cr-run"><div class="cr-h"><span class="avatar av-claude">${I('sparkle', 'sm')}</span><div class="grow cr-main">
        <div class="cr-t">${s.id ? `<button class="cr-open ellip" data-sid="${esc(s.id)}" title="${esc(title)}">${esc(title)}</button>` : `<b class="ellip" title="${esc(title)}">${esc(title)}</b>`}${model ? `<span class="faint">${esc(model)}</span>` : ''}${dur(since)}</div>
        ${doing ? `<div class="cr-d ellip" title="${esc(doing)}">${I(s.lastTool && s.lastTool.name ? 'terminal' : 'chat', 'sm')}<span class="ellip">${esc(doing)}</span></div>` : ''}</div></div>
      ${agents.length ? `<div class="cr-g"><div class="cr-gh">Helpers<span class="faint">${agents.length}</span></div>${agents.map((g) => {
        const gm = modelName(g.model), gs = Date.parse(g.startedAt);
        return `<div class="cr-a"><span class="grow ellip" title="${esc(g.description || 'Working')}">${esc(g.description || 'Working')}</span><span class="cr-k" title="${esc(g.type || '')}">${esc(kindOf(g))}</span>${gm ? `<span class="faint">${esc(gm)}</span>` : ''}${gs ? dur(gs) : ''}${g.background ? MC.st('idle', 'Background') : ''}</div>`;
      }).join('')}</div>` : ''}</div>`;
  }
  M.crew = {
    label: 'Crew', icon: 'user',
    render: (vp) => {
      const pid = realPid(); if (!pid) return `<div class="empty">${I('folder', 'lg')}<b>The crew belongs to a project</b><span>${esc(S.project || 'This tab')} is not a project. Open a project tab to see it.</span></div>`;
      const c = crewOf(pid); if (!c.at && !c.busy) setTimeout(() => poll(pid));
      const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
      let body;
      if (!c.list) body = c.fails ? `<div class="lv-err">${I('xc', 'sm')}Could not read what is running: ${esc(c.err)} <button class="btn sm" data-retry>Try again</button></div>` : `<div class="lv-empty">${I('loader', 'sm')}Loading</div>`;
      else if (!c.list.length) body = `<div class="empty">${I('user', 'lg')}<b>Nothing running</b></div>`;
      else {
        const helpers = c.list.reduce((n, s) => n + (s.agents || []).length, 0);
        body = `<div class="sect-h">Running now<span class="grow"></span><span class="note">${plural(c.list.length, 'conversation', 'conversations')}${helpers ? ', ' + plural(helpers, 'helper', 'helpers') : ''}</span></div>`
          + (c.fails ? `<div class="lv-err">${I('warn', 'sm')}Could not read it again: ${esc(c.err)}</div>` : '')
          + c.list.map((s) => runRow(c, s)).join('');
      }
      return `<div class="crew" data-pid="${esc(pid)}">${body}</div>`;
    },
    mount: (el, vp) => {
      const pid = realPid(), proj = vp.state.project || MC.curProject();
      const go = (e) => {
        if (e.target.closest('[data-retry]')) { if (pid) poll(pid); return; }
        const o = e.target.closest('[data-sid]'); if (!o) return;
        /* the conversation opens here; Ctrl click or the middle button opens it in a new tab */
        if ((e.ctrlKey || e.metaKey || e.button === 1) && MC.D && MC.D.newTab) { MC.D.newTab(proj, { session: o.dataset.sid }); return; }
        if (proj && proj !== S.project) MC.setProject(proj);
        MC.setSession(o.dataset.sid); MC.emit('open', 'convo');
      };
      el.onclick = go; el.onauxclick = (e) => { if (e.button === 1) go(e); };
    },
  };
})();
