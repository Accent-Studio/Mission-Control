/* Mission Control 2: the project panels on real data, ported from today's project page (project.html) and Usage page.
   Overview (status, checks, jobs and their logs), Changes and commits, Documents, Gallery, Project settings, Usage.
   Loads after live.js, which gives MC.live and its helpers. */
(() => {
  const { $$, esc, icon: I, state: S } = MC;
  const M = MC.modules, api = MC.api, LV = MC.live, H = LV.helpers;
  const enc = encodeURIComponent;
  const { ago, hhmm, toMs, errText } = H;

  /* ---------- small dialogs (a desktop app has no prompt() or confirm()) ---------- */
  function dialog(title, body, field, okLabel) {
    return new Promise((done) => {
      const d = document.createElement('div'); d.className = 'mdlg';
      d.innerHTML = `<div class="mbox" role="dialog" aria-modal="true"><div class="mt2">${esc(title)}</div>${body ? `<div class="mb2">${esc(body)}</div>` : ''}${field != null ? `<div class="input"><input value="${esc(field)}"></div>` : ''}<div class="row"><span class="grow"></span><button class="btn sm ghost" data-x>Cancel</button><button class="btn sm primary" data-ok>${esc(okLabel || 'OK')}</button></div></div>`;
      document.body.appendChild(d);
      const inp = d.querySelector('input');
      const end = (v) => { d.remove(); done(v); };
      (inp || d.querySelector('[data-ok]')).focus(); if (inp) inp.select();
      d.onclick = (e) => { if (e.target === d || e.target.closest('[data-x]')) end(null); if (e.target.closest('[data-ok]')) end(inp ? inp.value : true); };
      d.onkeydown = (e) => { if (e.key === 'Escape') end(null); if (e.key === 'Enter') { e.preventDefault(); end(inp ? inp.value : true); } };
    });
  }
  MC.askText = (title, body, value, okLabel) => dialog(title, body, value == null ? '' : value, okLabel || 'Save');
  MC.askYes = (title, body, okLabel) => dialog(title, body, null, okLabel).then((v) => !!v);

  /* ---------- the open project ---------- */
  const realPid = () => { const id = H.pidOf(); return id && !H.isRootId(id) && !H.isChatId(id) && !H.hubKey(id) ? id : null; };
  /* another PC's project (m:<PC id>:<name>) has only its conversations here: its files, git and jobs are on that PC */
  const otherPc = () => { const id = H.pidOf(); return id && H.hubKey(id) ? ((LV.byId[id] && ((MC.data.places || []).find((p) => p.id === 'm:' + LV.byId[id].machine) || {}).name) || 'another PC') : null; };
  const noProj = (what) => otherPc() ? `<div class="empty">${I('pc', 'lg')}<b>${esc(what)} are on ${esc(otherPc())}</b><span>${esc(S.project)} is a project on ${esc(otherPc())}. Here you can read and continue its conversations; its files, git and jobs open on that PC.</span></div>` : `<div class="empty">${I('folder', 'lg')}<b>${esc(what)} belong to a project</b><span>${esc(S.project || 'This tab')} is not a project. Open a project tab to see them.</span></div>`;
  /* where the open project's documents and pictures come from: this PC, or for a project of the linked PC its notes on the
     hub (server/services/library.js). key: the project; base: the API path its library and files hang from */
  const libSrc = () => {
    const pid = realPid(); if (pid) return { key: pid, base: '/api/projects/' + enc(pid) };
    const lp = H.pidOf() && H.linkProj(H.pidOf()); return lp ? { key: lp.id, base: '/api/pc/projects/' + enc(lp.rid), pc: true } : null;
  };
  const loading = (what) => `<div class="lv-empty">${I('loader', 'sm')}${esc(what)}</div>`;
  const failed = (what, err) => `<div class="lv-err">${I('xc', 'sm')}${esc(what)}: ${esc(err)} <button class="btn sm" data-retry>Try again</button></div>`;
  /* one cached answer per key; get() starts a load when there is none or it is older than maxAge, and repaints the modules after */
  function cache(load, mods, maxAge = 30000) {
    const C = {};
    const get = (key, force) => {
      const x = C[key] || (C[key] = {});
      if (!x.busy && (force || !x.at || Date.now() - x.at > maxAge)) {
        x.busy = true;
        load(key).then((v) => { x.v = v; x.err = null; }, (e) => { x.err = errText(e); }).then(() => { x.busy = false; x.at = Date.now(); mods.forEach((m) => MC.emit('rerender', m)); });
      }
      return x;
    };
    get.drop = (key) => { if (key) delete C[key]; else Object.keys(C).forEach((k) => delete C[k]); };
    return get;
  }
  const detail = cache((pid) => api.get('/api/projects/' + enc(pid)), ['overview', 'git', 'settings']);
  const jobsAll = cache(() => api.get('/api/jobs'), ['overview'], 15000);
  const changes = cache((pid) => api.get(`/api/projects/${enc(pid)}/git/changes`), ['git'], 15000);
  const commitFiles = cache((k) => { const [pid, hash] = k.split('|'); return api.get(`/api/projects/${enc(pid)}/git/commits/${enc(hash)}`); }, ['git'], 3600e3);
  const diffs = cache((k) => { const [pid, path, hash] = k.split('|'); return api.get(`/api/projects/${enc(pid)}/git/diff?path=${enc(path)}${hash ? '&commit=' + enc(hash) : ''}`); }, ['git'], 15000);
  const library = cache((k) => { const [base, kind] = k.split('|'); return api.get(`${base}/library?kind=${kind}`); }, ['docs', 'gallery'], 60000);
  const docText = cache((k) => { const [base, root, ...p] = k.split('|'); return fetch(fileUrl(base, p.join('|'), root), { headers: { 'X-MC': '1' } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }); }, ['docs'], 60000);
  const convImgs = cache((sid) => api.get(`/api/sessions/${enc(sid)}/images?tools=1`), ['gallery'], 60000);
  const imgCounts = cache((ids) => api.get('/api/sessions/image-counts?ids=' + ids), ['gallery'], 60000);
  const stats = cache((k) => { const to = Date.now(), from = to - 30 * 86400000; return api.get(`/api/usage/stats?from=${from}&to=${to}`); }, ['usage'], 60000);
  const fileUrl = (base, path, root) => `${base}/file?path=${enc(path)}&root=${enc(root || 'p')}`;
  MC.events.on('projects.changed', () => { detail.drop(); changes.drop(); MC.emit('rerender', 'overview'); MC.emit('rerender', 'git'); });
  MC.events.on('usage', (u) => { if (u && u.fiveHour !== undefined) { LV.usage = u; MC.emit('rerender', 'usage'); paintMinis(); MC.D && MC.D.drawSbar && MC.D.drawSbar(); } });

  /* ---------- jobs: run, stop, watch the log ---------- */
  const LOGS = {}; /* runId -> lines */
  const runsOf = (pid) => ((jobsAll('all').v || {}).runs || []).filter((r) => r.projectId === pid);
  const lastRun = (pid, jobId) => runsOf(pid).filter((r) => r.jobId === jobId).sort((a, b) => (toMs(b.startedAt) || 0) - (toMs(a.startedAt) || 0))[0];
  async function runJob(pid, jobId, label, confirm) {
    try {
      const r = await api.post(`/api/projects/${enc(pid)}/jobs/${enc(jobId)}/run`, confirm ? { confirm } : {});
      MC.toast(r.mode === 'window' ? `${label} opened in its own window` : `${label} started`, 'play');
      if (r.runId && r.mode !== 'window') { LOGS[r.runId] = []; openLog = r.runId; }
      jobsAll.drop(); MC.emit('rerender', 'overview');
    } catch (e) {
      const d = e.data || {};
      if (e.status === 409 && d.needsConfirm) { const n = await MC.askText(d.error || 'This goes outside your PC', `Type ${d.confirmName} to go ahead.`, ''); if (n && n.trim() === d.confirmName) runJob(pid, jobId, label, n.trim()); return; }
      MC.toast(`${label}: ${d.error || errText(e)}`, 'warn');
    }
  }
  MC.runJob = (pid, jobId, label) => runJob(pid, jobId, label);
  let openLog = null;
  async function showLog(runId) {
    openLog = openLog === runId ? null : runId;
    if (openLog && !LOGS[runId]) { try { const d = await api.get(`/api/jobs/${enc(runId)}/log?tail=400`); LOGS[runId] = (d.lines || []).map(clean); } catch (e) { LOGS[runId] = ['Could not read the log: ' + errText(e)]; } }
    MC.emit('rerender', 'overview');
  }
  const clean = (l) => String(l == null ? '' : l).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  MC.events.on('job', (d) => {
    if (!d || !d.runId) return;
    if (d.done) { jobsAll.drop(); detail.drop(d.projectId); MC.emit('rerender', 'overview'); MC.toast(`${d.jobId}: ${d.state === 'done' || d.code === 0 ? 'done' : d.state || 'ended'}`, d.code === 0 ? 'check' : 'warn'); return; }
    if (d.line == null) return;
    const L = LOGS[d.runId] || (LOGS[d.runId] = []); L.push(clean(d.line)); if (L.length > 800) L.splice(0, L.length - 800);
    $$(`[data-log="${CSS.escape(d.runId)}"]`).forEach((pre) => { const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30; pre.textContent = L.join('\n'); if (stick) pre.scrollTop = pre.scrollHeight; });
  });

  /* ---------- Sync: the branch in step with its remote, in whichever direction it needs (services/sync.js) ---------- */
  const SYNC = {}; /* projectId -> its last state, false before its first sync */
  const syncOf = (pid) => {
    if (!(pid in SYNC)) { SYNC[pid] = undefined; api.get(`/api/projects/${enc(pid)}/sync`).then((d) => { if (SYNC[pid] === undefined) { SYNC[pid] = (d && d.state) || false; MC.emit('rerender', 'overview'); } }, () => {}); }
    return SYNC[pid] || null;
  };
  MC.events.on('sync', (d) => {
    if (!d || !d.projectId) return;
    SYNC[d.projectId] = d; MC.emit('rerender', 'overview');
    if (!d.busy) { detail.drop(d.projectId); changes.drop(d.projectId); H.loadRuns(); }
    if (d.phase === 'needs' && !(MC.syncShared && MC.syncShared(d.projectId))) MC.toast(`Sync needs you: ${String(d.detail || '').slice(0, 90)}`, 'warn'); /* a shared one says so in the Sync panel's own toast */
  });
  const SYNC_SHOWN_MS = 30 * 60e3; /* a finished sync's line stays this long */
  const syncRow = (s) => {
    if (!s || s.dismissed) return '';
    if (s.busy) return `<div class="ovr">${MC.st('run', s.label)}<span class="grow ellip" title="${esc(s.detail || '')}">${esc(s.detail || '')}</span></div>`;
    const notes = (s.notes || []).map((n) => `<div class="ovr">${I('note', 'sm')}<span class="grow faint">${esc(n)}</span></div>`).join('');
    if (s.phase === 'done') {
      if (Date.now() - (toMs(s.endedAt) || 0) > SYNC_SHOWN_MS) return '';
      return `<div class="ovr">${MC.st('done', 'Synced')}<span class="grow ellip">${esc(s.detail || '')} <span class="faint">${esc(ago(s.endedAt))}</span></span><button class="ibtn sm" data-syncx title="Hide this line">${I('x', 'sm')}</button></div>${notes}`;
    }
    const act = s.kind === 'public' ? `<button class="btn sm" data-syncreview title="Haiku checks every file for private details and waits for your yes">${I('lock', 'sm')}Review and push</button>`
      : s.sessionId ? `<button class="btn sm primary" data-syncopen="${esc(s.sessionId)}">${I('chat', 'sm')}Open conversation</button>`
      : `<button class="btn sm" data-syncask title="A new conversation, told what stopped the sync. Nothing is pushed without your yes">${I('chat', 'sm')}Ask Claude</button>`;
    return `<div class="ovr">${MC.st('wait', 'Needs you')}<span class="grow" style="white-space:normal">${esc(s.detail || '')}</span>${act}</div>${notes}`;
  };

  /* ---------- Overview: the project's state, what needs doing, and its buttons ---------- */
  const CHECK = { fresh: ['done', 'Up to date'], stale: ['warn', 'Old'], missing: ['fail', 'Missing'] };
  M.overview = {
    label: 'Overview', icon: 'layout',
    render: (vp) => {
      const pid = realPid(); if (!pid) return noProj('Overviews');
      const x = detail(pid), d = x.v;
      if (!d) return x.err ? failed('Could not load the project', x.err) : loading('Loading the project');
      jobsAll('all');
      const p = MC.projectInfo();
      const busy = (jobId) => { const r = lastRun(pid, jobId); return r && r.state === 'running' ? r : null; };
      const runBtn = (jobId, label, primary) => { const r = busy(jobId); return r ? `<button class="btn sm" data-stopjob="${esc(r.runId)}">${I('stop', 'sm')}Stop</button>` : `<button class="btn sm ${primary ? 'primary' : ''}" data-job="${esc(jobId)}" data-label="${esc(label)}">${I('play', 'sm')}${esc(label)}</button>`; };
      const note = (jobId) => { const r = lastRun(pid, jobId); if (!r) return ''; const st = r.state === 'running' ? 'running' : r.state === 'failed' ? 'last run failed' : r.state === 'done' ? 'ran ' + ago(r.endedAt || r.startedAt) : r.state; return r.hasLog || r.state === 'running' ? `<button class="linkb" data-showlog="${esc(r.runId)}">${esc(st)}, log</button>` : `<span class="faint">${esc(st)}</span>`; };
      const fixJobs = new Set((d.checks || []).map((c) => c.fix && c.fix.jobId).filter(Boolean));
      const pushJob = (d.jobs || []).find((j) => j.builtin === 'git-push');
      const rows = [], sy = d.isRepo ? syncOf(pid) : null;
      const sr = syncRow(sy); if (sr) rows.push(sr);
      const shared = MC.syncShared ? MC.syncShared(pid) : null;
      if (shared) {
        const others = shared.rows.filter((r) => r.which !== 'here');
        rows.push(`<div class="ovr">${MC.st(shared.todo ? 'wait' : 'done', shared.todo ? 'Out of step' : 'In step')}<span class="grow">Also on ${esc(others.map((r) => r.name).join(' and '))}${shared.todo ? ': ' + esc(shared.rows.filter((r) => r.status === 'todo' || r.status === 'stuck').map((r) => `${r.name}, ${r.words.toLowerCase()}`).join('; ')) : ''}</span><button class="btn sm ${shared.todo ? 'primary' : ''}" data-opensync>${I('swap', 'sm')}Open Sync</button></div>`);
      }
      if (d.dirty > 0) rows.push(`<div class="ovr">${MC.st('wait', 'Changes')}<span class="grow">${d.dirty} file${d.dirty > 1 ? 's' : ''} not committed</span><button class="btn sm" data-open="git">${I('git', 'sm')}See them</button></div>`);
      (d.checks || []).filter((c) => c.state !== 'none').forEach((c) => {
        const st = CHECK[c.state] || ['idle', c.state];
        rows.push(`<div class="ovr">${MC.st(st[0], c.label)}<span class="grow ellip" title="${esc(c.detail || '')}">${esc(c.line || c.detail || '')}${c.required ? '' : ' <span class="faint">(not required)</span>'}</span>${c.fix && !c.waitsFor && c.state !== 'fresh' ? note(c.fix.jobId) + runBtn(c.fix.jobId, c.fix.label) : ''}${c.launch && c.launch.available ? `<button class="btn sm ghost" data-launch="${esc(c.key)}">${I('ext', 'sm')}${esc(c.launch.label || 'Open')}</button>` : ''}</div>`);
      });
      if (d.ahead > 0) rows.push(`<div class="ovr">${MC.st('idle', 'Push')}<span class="grow">${d.ahead} commit${d.ahead > 1 ? 's' : ''} not pushed${d.remote ? ' to ' + esc(d.remote) : ''}</span>${pushJob ? note(pushJob.id) + runBtn(pushJob.id, 'Push') : ''}</div>`);
      const jobs = (d.jobs || []).filter((j) => j.visible !== false && !fixJobs.has(j.id) && j.builtin !== 'git-push').sort((a, b) => (a.order || 0) - (b.order || 0));
      const log = openLog && runsOf(pid).some((r) => r.runId === openLog) ? `<div class="sect-h">Log<span class="grow"></span><button class="ibtn sm" data-showlog="${esc(openLog)}" title="Close the log">${I('x', 'sm')}</button></div><pre class="joblog" data-log="${esc(openLog)}">${esc((LOGS[openLog] || ['Loading']).join('\n'))}</pre>` : '';
      const ab = d.ahead == null ? 'no remote' : d.ahead || d.behind ? `${d.ahead} ahead, ${d.behind} behind` : 'in step with ' + (d.remote || 'the remote');
      return `<div class="ov"><div class="row" style="gap:calc(15px*var(--k))"><span class="tint" style="width:calc(46px*var(--k));height:calc(46px*var(--k));font-size:calc(21px*var(--k));background:${p.tint}">${esc(d.name[0])}</span><div class="grow" style="min-width:0"><div class="h ellip" style="font-size:calc(23px*var(--k))">${esc(d.name)}</div><div class="faint ellip" style="font-size:calc(15px*var(--k))">${esc(d.about || d.folder)}</div></div>
          <button class="btn sm" data-reveal title="Open the folder in Explorer">${I('folder', 'sm')}Folder</button><button class="ibtn sm" data-refresh title="Look again">${I('refresh', 'sm')}</button></div>
        <div class="tiles"><div class="tile"><div class="tl">Branch</div><div class="tv ellip" style="font-size:calc(20px*var(--k))">${esc(d.branch || 'none')}</div><div class="ts">${esc(ab)}</div></div><div class="tile"><div class="tl">Not committed</div><div class="tv">${d.dirty || 0}</div><div class="ts">files</div></div><div class="tile"><div class="tl">Last commit</div><div class="tv" style="font-size:calc(20px*var(--k))">${d.lastCommit ? esc(ago(d.lastCommit.date)) : 'none'}</div><div class="ts ellip" title="${esc(d.lastCommit ? d.lastCommit.subject : '')}">${d.lastCommit ? esc(d.lastCommit.subject) : ''}</div></div><div class="tile"><div class="tl">Build</div><div class="tv" style="font-size:calc(20px*var(--k))">${esc({ fresh: 'Up to date', stale: 'Old', unknown: 'Unknown' }[d.build] || d.build || 'none')}</div><div class="ts">${d.mainCheck ? 'by the ' + esc(d.mainCheck) + ' check' : ''}</div></div></div>
        ${!d.exists ? `<div class="lv-err">${I('warn', 'sm')}The project folder is missing: ${esc(d.folder)}</div>` : ''}
        <div><div class="sect-h">Status<span class="grow"></span></div>${rows.length ? `<div class="ovrows">${rows.join('')}</div>` : `<div class="lv-empty">${I('check', 'sm')}Nothing to do. Everything is committed and up to date.</div>`}</div>
        ${jobs.length ? `<div><div class="sect-h">Jobs<span class="grow"></span><button class="linkb" data-open="settings">Manage</button></div><div class="ovrows">${jobs.map((j) => `<div class="ovr">${I(j.outward ? 'share' : 'play', 'sm')}<b class="grow ellip">${esc(j.label)}</b>${note(j.id)}${runBtn(j.id, 'Run')}</div>`).join('')}</div></div>` : ''}
        ${log}
        ${(d.commits || []).length ? `<div><div class="sect-h">Recent commits<span class="grow"></span><button class="linkb" data-open="git" data-tab="History">All</button></div>${d.commits.slice(0, 5).map((c) => `<div class="cm"><span class="h">${esc(c.hash.slice(0, 7))}</span><span class="grow ellip">${esc(c.subject)}</span><span class="w">${esc(ago(c.date))}</span></div>`).join('')}</div>` : ''}</div>`;
    },
    mount: (el, vp) => {
      const pre = el.querySelector('.joblog'); if (pre) pre.scrollTop = pre.scrollHeight;
      el.onclick = async (e) => {
        const pid = realPid(); if (!pid) return; const t = e.target;
        if (t.closest('[data-retry]') || t.closest('[data-refresh]')) { detail(pid, true); jobsAll('all', true); return; }
        if (t.closest('[data-reveal]')) { const d = detail(pid).v; api.post('/api/path/reveal', { path: d.folder }).catch((er) => MC.toast('Could not open the folder: ' + errText(er), 'warn')); return; }
        const o = t.closest('[data-open]'); if (o) { MC.emit('open', o.dataset.open); return; }
        if (t.closest('[data-opensync]')) { if (MC.syncPanel) MC.syncPanel(); return; }
        const so = t.closest('[data-syncopen]'); if (so) { MC.openInTalk(so.dataset.syncopen); return; }
        if (t.closest('[data-syncreview]')) { MC.reviewPush(); return; }
        if (t.closest('[data-syncx]')) { if (SYNC[pid]) SYNC[pid].dismissed = true; MC.emit('rerender', 'overview'); return; }
        const sa = t.closest('[data-syncask]'); if (sa) {
          sa.disabled = true;
          try { const r = await api.post(`/api/projects/${enc(pid)}/sync/ask`, {}); H.loadRuns(); if (r && r.sessionId) MC.openInTalk(r.sessionId); else MC.toast(`Started. It is in ${S.project}'s conversations.`, 'chat'); }
          catch (er) { MC.toast('Could not start it: ' + errText(er), 'warn'); sa.disabled = false; }
          return;
        }
        const j = t.closest('[data-job]'); if (j) { j.disabled = true; runJob(pid, j.dataset.job, j.dataset.label); return; }
        const s = t.closest('[data-stopjob]'); if (s) { s.disabled = true; api.post(`/api/jobs/${enc(s.dataset.stopjob)}/stop`, {}).catch((er) => MC.toast('Could not stop: ' + errText(er), 'warn')); return; }
        const l = t.closest('[data-showlog]'); if (l) { showLog(l.dataset.showlog); return; }
        const la = t.closest('[data-launch]'); if (la) { try { await api.post(`/api/projects/${enc(pid)}/checks/${enc(la.dataset.launch)}/launch`, {}); MC.toast('Opened', 'ext'); } catch (er) { MC.toast('Could not open it: ' + errText(er), 'warn'); } }
      };
    },
  };

  /* ---------- Changes and commits ---------- */
  const STATE = { new: ['A', 'New'], changed: ['M', 'Changed'], deleted: ['D', 'Deleted'], renamed: ['R', 'Renamed'], conflict: ['!', 'Conflict'] };
  const fileRows = (files, hash, sel) => files.map((f) => { const s = STATE[f.state] || ['?', f.state]; return `<div class="cm file ${sel === f.path ? 'on' : ''}" data-file="${esc(f.path)}" data-hash="${esc(hash || '')}" title="${esc(s[1] + (f.from ? ', from ' + f.from : ''))}"><span class="fl st-${esc(f.state)}">${s[0]}</span><span class="grow mono ellip">${esc(f.path)}</span><span class="d">${f.add == null ? 'binary' : `<span class="plus">+${f.add}</span> <span class="minus">−${f.del}</span>`}</span></div>`; }).join('');
  const diffHtml = (d) => `<div class="diff">${String(d.diff || '').split('\n').slice(0, 4000).map((l) => `<div class="${/^@@/.test(l) ? 'hh' : /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'r' : 'c'}">${esc(l) || ' '}</div>`).join('')}${d.cut ? '<div class="hh">The rest is cut: the file is too big to show.</div>' : ''}</div>`;
  M.git = {
    label: 'Changes and commits', icon: 'git', tabs: ['Changes', 'History'],
    render: (vp) => {
      const pid = realPid(); if (!pid) return noProj('Changes and commits');
      const x = detail(pid), d = x.v;
      if (!d) return x.err ? failed('Could not load the project', x.err) : loading('Loading the project');
      if (!d.isRepo) return `<div class="empty">${I('git', 'lg')}<b>Not a git repository</b><span>${esc(d.folder)}</span></div>`;
      const sel = vp.state.file, selHash = vp.state.fileHash || '';
      const diffPart = () => { if (!sel) return ''; const df = diffs(`${pid}|${sel}|${selHash}`); return `<div class="sect-h mono ellip">${esc(sel)}<span class="grow"></span><button class="ibtn sm" data-closediff title="Close">${I('x', 'sm')}</button></div>${df.v && !df.busy ? diffHtml(df.v) : df.err ? `<div class="lv-err">${esc(df.err)}</div>` : loading('Loading the diff')}`; };
      if (vp.tab === 'History') {
        const cm = vp.state.cm;
        return `<div class="git">${(d.commits || []).map((c) => { const open = c.hash === cm, f = open ? commitFiles(`${pid}|${c.hash}`) : null; return `<div class="cm ${open ? 'on' : ''}" data-cm="${esc(c.hash)}"><span class="h">${esc(c.hash.slice(0, 7))}</span><span class="grow ellip" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="w">${esc(ago(c.date))}</span></div>${open ? `<div class="cmfiles">${f.v ? fileRows(f.v.files || [], c.hash, sel) + (f.v.total > (f.v.files || []).length ? `<div class="faint">and ${f.v.total - f.v.files.length} more</div>` : '') : f.err ? esc(f.err) : loading('Loading')}</div>` : ''}`; }).join('') || '<div class="lv-empty">No commits yet</div>'}
          ${diffPart()}</div>`;
      }
      const ch = changes(pid), files = (ch.v && ch.v.files) || [];
      const ahead = d.ahead > 0 ? `<span class="st st-idle">${I('send')}${d.ahead} not pushed</span>` : '';
      return `<div class="git"><div class="row">${files.length ? `<span class="st st-wait">${I('warn')}${ch.v.total || files.length} changed</span>` : `<span class="st st-done">${I('check')}All committed</span>`}${ahead}<span class="grow"></span><button class="ibtn sm" data-refresh title="Look again">${I('refresh', 'sm')}</button></div>
        ${ch.err ? `<div class="lv-err">${esc(ch.err)}</div>` : !ch.v ? loading('Reading the changes') : fileRows(files, '', sel)}
        ${files.length ? `<div class="commitbox"><div class="input grow"><input data-msg placeholder="What changed, for the commit message" value="${esc(vp.state.msg || '')}" maxlength="2000"></div><button class="btn sm primary" data-commit>${I('check', 'sm')}Commit</button></div><div class="faint" style="font-size:calc(13px*var(--k))">Commits every change in the folder on this PC. Nothing is pushed.</div>` : ''}
        ${diffPart()}</div>`;
    },
    mount: (el, vp) => {
      const msg = el.querySelector('[data-msg]'); if (msg) msg.oninput = () => (vp.state.msg = msg.value);
      if (msg) msg.onkeydown = (e) => { if (e.key === 'Enter') el.querySelector('[data-commit]').click(); };
      el.onclick = async (e) => {
        const pid = realPid(); if (!pid) return; const t = e.target;
        if (t.closest('[data-retry]') || t.closest('[data-refresh]')) { detail(pid, true); changes(pid, true); return; }
        const f = t.closest('[data-file]'); if (f) { const same = vp.state.file === f.dataset.file && (vp.state.fileHash || '') === f.dataset.hash; vp.state.file = same ? null : f.dataset.file; vp.state.fileHash = f.dataset.hash; vp.rerender(); return; }
        if (t.closest('[data-closediff]')) { vp.state.file = null; vp.rerender(); return; }
        const c = t.closest('[data-cm]'); if (c) { vp.state.cm = vp.state.cm === c.dataset.cm ? null : c.dataset.cm; vp.rerender(); return; }
        const b = t.closest('[data-commit]'); if (b) {
          const m = (vp.state.msg || '').trim(); if (!m) { MC.toast('Write what changed first', 'note'); return; }
          b.disabled = true;
          try { const r = await api.post(`/api/projects/${enc(pid)}/git/commit`, { message: m }); MC.toast(r.summary || 'Committed', 'check'); vp.state.msg = ''; }
          catch (er) { MC.toast('Not committed: ' + errText(er), 'warn'); b.disabled = false; }
          detail(pid, true); changes(pid, true); diffs.drop();
        }
      };
    },
  };

  /* ---------- Documents and Gallery: folder trees (as on the old project page) ----------
     One root per place (the project folder, each notes folder); a root starts open, a folder closed. state.open keeps what
     was opened or closed, per panel. */
  /* dirs: the folders of a notes folder as the server lists them, so an empty one shows too */
  function libTree(files, root, dirs) {
    const top = { path: '', dirs: new Map(), files: [], count: 0 };
    const node = (parts, count) => {
      let n = top; if (count) top.count++;
      parts.forEach((seg, i) => { if (!n.dirs.has(seg)) n.dirs.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], count: 0 }); n = n.dirs.get(seg); if (count) n.count++; });
      return n;
    };
    for (const d of dirs || []) if (d.root === root) node(d.path.split('/'), false);
    for (const f of files) {
      if (f.root !== root) continue;
      const parts = f.path.split('/'); parts.pop();
      node(parts, true).files.push(f);
    }
    return top;
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const isOpen = (vp, k, depth) => { const o = vp.state.open || {}; return k in o ? o[k] : depth === 0; };
  /* a folder is its chevron and its name (no folder icon); a file has the icon of its kind (fileRow) */
  const dirRow = (k, name, n, depth, open, attrs = '') => `<button class="tdir ${depth ? '' : 'troot'}" style="--d:${depth}" data-tk="${esc(k)}" aria-expanded="${open}"${attrs}>${I(open ? 'chev' : 'chevR', 'sm')}<span class="grow ellip">${esc(depth ? niceName(name) : name)}</span><span class="faint">${n || ''}</span></button>`;
  /* leaf(files, root, node, depth): the html of one folder's own files. opts.keep(root): list that root even when it is
     empty (a notes folder, where a first note can be made); opts.attrs(root, path): more attributes of a folder row */
  function treeHtml(vp, L, leaf, opts = {}) {
    const attrs = (root, p) => (opts.attrs ? opts.attrs(root, p) : '');
    const walk = (root, node, depth) => [...node.dirs.values()].sort((a, b) => byName(a.name, b.name)).map((d) => {
      const k = root + ':' + d.path, op = isOpen(vp, k, depth + 1);
      return dirRow(k, d.name, d.count, depth + 1, op, attrs(root, d.path)) + (op ? walk(root, d, depth + 1) + (d.files.length ? leaf(d.files, root, d, depth + 2) : '') : '');
    }).join('');
    return (L.roots || []).map((r) => {
      const t = libTree(L.files || [], r.id, L.dirs); if (!t.count && !(opts.keep && opts.keep(r.id))) return '';
      const k = r.id + ':', op = isOpen(vp, k, 0);
      return dirRow(k, r.label, t.count, 0, op, attrs(r.id, '')) + (op ? walk(r.id, t, 0) + (t.files.length ? leaf(t.files, r.id, t, 1) : '') + (!t.count && !t.dirs.size ? `<div class="lv-empty" style="padding-left:calc(26px*var(--k))">Empty. Right-click it, or use ${I('plus', 'sm')} above, to make a note.</div>` : '') : '');
    }).join('');
  }
  const flipDir = (vp, el) => { const o = (vp.state.open = vp.state.open || {}); o[el.dataset.tk] = el.getAttribute('aria-expanded') !== 'true'; vp.rerender(); };
  /* By folder or newest first (a search always lists what it finds, newest first) */
  const modeSeg = (vp) => `<span class="seg ico" data-lmode><button data-val="tree" class="${vp.state.mode !== 'recent' ? 'on' : ''}" title="By folder">${I('folder', 'sm')}</button><button data-val="recent" class="${vp.state.mode === 'recent' ? 'on' : ''}" title="Newest first">${I('clock', 'sm')}</button></span>`;
  const treeMode = (vp) => vp.state.mode !== 'recent' && !(vp.state.q || '').trim();

  /* A name written all in capitals (README, SETUP-WITH-AN-AGENT) shows as Readme, Setup-With-An-Agent; the file keeps
     its name. Anything with a lower case letter is shown as it is. */
  const niceName = (n) => (/[a-z]/.test(n) || !/[A-Z]{2}/.test(n) ? n : n.toLowerCase().replace(/(^|[\s\-_.])([a-z])/g, (m, sep, c) => sep + c.toUpperCase()));
  const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|jsonc|css|scss|py|sh|bat|cmd|ps1|rs|go|c|cc|cpp|h|hpp|cs|java|kt|swift|rb|php|lua|gd|sql|yml|yaml|toml|ini|cfg|conf|xml|env)$/i;
  const fileIcon = (p) => (/\.(png|jpe?g|webp|gif|svg)$/i.test(p) ? 'image' : /\.html?$/i.test(p) ? 'globe' : CODE_EXT.test(p) ? 'code' : 'doc');
  /* how a file reads in the list: its name without .md, all-caps names softened */
  const shownName = (p) => niceName(p.split('/').pop().replace(/\.(md|markdown)$/i, ''));

  /* ---------- Documents ---------- */
  /* the kind of a file that is not markdown, from its extension: TXT, HTML, JS ... */
  const extTag = (p) => { const m = /\.([a-z0-9]{1,6})$/i.exec(p.split('/').pop()); return m && !/^(md|markdown)$/i.test(m[1]) ? m[1].toUpperCase() : ''; };
  /* Edit mode: a note of a notes folder (never the project folder) as raw text, saved a moment after the last key. The server
     puts it where it lives: on disk here, on the linked PC while it is on, else in the hub's copy (server/services/library.js).
     It sends the hash the note had when it opened (X-MC-Hash); a note changed elsewhere since then comes back to choose. */
  const ED = {}; /* base|root|path -> { text, hash, st: load | saved | dirty | saving | err | conflict, where, err, theirs, sel } */
  const SAVE_MS = 1200;
  const edKey = (src, sel) => `${src.base}|${sel.root}|${sel.path}`;
  const editable = (sel) => sel && sel.root !== 'p';
  function edLoad(k, url) {
    const e = ED[k] = { st: 'load' };
    fetch(url, { headers: { 'X-MC': '1' }, cache: 'no-store' }).then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (text.slice(0, 8000).includes('\u0000')) throw new Error('This file is not text');
      Object.assign(e, { st: 'saved', text, hash: r.headers.get('X-MC-Hash'), where: null });
    }).catch((err) => Object.assign(e, { st: 'err', err: errText(err), text: null })).then(() => MC.emit('rerender', 'docs'));
  }
  const edLabel = (e) => e.st === 'saving' ? 'Saving' : e.st === 'dirty' ? 'Not saved yet' : e.st === 'err' ? 'Not saved: ' + e.err : e.st === 'conflict' ? 'Changed somewhere else' : !e.where ? 'No changes' : e.where === 'pc' ? `Saved on ${e.owner || 'the other PC'}` : e.where === 'hub' ? 'Saved on the hub' : 'Saved';
  const edIcon = (e) => I(e.st === 'saving' ? 'loader' : e.st === 'err' || e.st === 'conflict' ? 'warn' : e.st === 'dirty' ? 'clock' : 'check', 'sm');
  /* only the label changes while typing: a repaint would move the cursor */
  function edPaint(k) {
    const e = ED[k]; if (!e) return;
    document.querySelectorAll('[data-dsave]').forEach((el) => { if (el.dataset.dsave === k) { el.className = 'dsave ' + e.st; el.innerHTML = edIcon(e) + esc(edLabel(e)); } });
  }
  async function edSave(k, url, force) {
    const e = ED[k]; if (!e || e.text == null) return;
    clearTimeout(e.t); e.t = 0;
    if (e.busy) { e.again = true; return; }
    if (e.st !== 'dirty' && !force) return;
    const text = e.text; e.busy = true; e.st = 'saving'; edPaint(k);
    try {
      const r = await api.put(url, { text, base: force ? force : e.hash });
      e.hash = r.hash; e.where = r.saved; e.owner = r.owner; e.st = e.text === text ? 'saved' : 'dirty'; e.theirs = null;
      docText.drop(k);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.conflict) { e.st = 'conflict'; e.theirs = { text: err.data.text, hash: err.data.hash }; MC.emit('rerender', 'docs'); }
      else { e.st = 'err'; e.err = errText(err); }
    }
    e.busy = false; edPaint(k);
    if (e.st === 'dirty' || e.again) { e.again = false; if (e.st === 'dirty') e.t = setTimeout(() => edSave(k, url), SAVE_MS); }
  }
  /* a page closed while a save waits: send it anyway */
  window.addEventListener('pagehide', () => Object.entries(ED).forEach(([k, e]) => { if (e.st === 'dirty' && e.url) fetch(e.url, { method: 'PUT', keepalive: true, headers: { 'X-MC': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: e.text, base: e.hash }) }).catch(() => {}); }));
  const edFlush = (vp) => { const src = libSrc(), sel = vp.state.doc; if (!src || !editable(sel)) return; const k = edKey(src, sel), e = ED[k]; if (e && e.st === 'dirty') edSave(k, e.url); };
  /* ---------- Documents: file actions in a notes folder (server/lib/noteOps.js) ----------
     A new note or folder (the + button, or a right-click), rename, duplicate, delete (to the trash), and moving by drag and
     drop: in one notes folder, or between notes folders of this PC. The project folder stays read only. The list changes at
     once; a notes folder of this PC is listed again from disk right after, another PC's (read from the hub) a minute later,
     once its sync has taken the change up. */
  const under = (p, base) => !base || p === base || p.startsWith(base + '/');
  const swap = (p, from, to) => (from ? to + p.slice(from.length) : (to ? to + '/' : '') + p);
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const leafOf = (p) => p.split('/').pop();
  const rootOf = (L, id) => (L && (L.roots || []).find((r) => r.id === id)) || null;
  const canEdit = (L, id) => { const r = rootOf(L, id); return !!r && id !== 'p' && !r.readOnly; };
  /* where a move may go: the same notes folder, or another notes folder of this PC */
  const canDrop = (L, from, to) => canEdit(L, to) && (from === to || (!rootOf(L, from).remote && !rootOf(L, to).remote));
  const rootName = (L, id) => { const r = rootOf(L, id); return r ? r.label.replace(/^Notes: /, '') : ''; };
  const placeName = (L, root, dir) => (dir ? leafOf(dir) : rootName(L, root));
  /* the list as it is after an action, before the server lists it again */
  const relist = {
    add(L, root, p, dir) { L.dirs = L.dirs || []; if (dir) L.dirs.push({ root, path: p }); else L.files.push({ root, path: p, size: 0, mtime: new Date().toISOString() }); },
    move(L, root, from, toRoot, to) {
      const one = (x) => { if (x.root === root && under(x.path, from)) { x.root = toRoot; x.path = swap(x.path, from, to); } };
      (L.files || []).forEach(one); (L.dirs || []).forEach(one);
    },
    copy(L, root, from, to) {
      L.files.push(...L.files.filter((x) => x.root === root && under(x.path, from)).map((x) => ({ ...x, path: swap(x.path, from, to), mtime: new Date().toISOString() })));
      L.dirs = L.dirs || []; L.dirs.push(...L.dirs.filter((x) => x.root === root && under(x.path, from)).map((x) => ({ ...x, path: swap(x.path, from, to) })));
    },
    drop(L, root, p) { const keep = (x) => !(x.root === root && under(x.path, p)); L.files = L.files.filter(keep); L.dirs = (L.dirs || []).filter(keep); },
  };
  /* the folders that were open, and the open document, follow a rename or a move */
  function follow(vp, root, from, toRoot, to) {
    const o = vp.state.open || {};
    Object.keys(o).forEach((k) => { const i = k.indexOf(':'), r = k.slice(0, i), p = k.slice(i + 1); if (r === root && p && under(p, from)) { o[toRoot + ':' + swap(p, from, to)] = o[k]; delete o[k]; } });
    const d = vp.state.doc;
    if (d && d.root === root && under(d.path, from)) { vp.state.doc = { ...d, root: toRoot, path: swap(d.path, from, to) }; vp.state.edit = null; }
    const h = vp.state.here;
    if (h && h.root === root && h.dir && under(h.dir, from)) vp.state.here = { root: toRoot, dir: swap(h.dir, from, to) };
  }
  async function noteAct(vp, src, body, done) {
    const key = src.base + '|docs', x = library(key), L = x.v;
    edFlush(vp);
    let r;
    try { r = await api.post(src.base + '/notes-op', body); }
    catch (e) { MC.toast((e.data && e.data.error) || errText(e), 'warn'); return null; }
    if (L) { done(L, r); x.at = Date.now(); }
    const here = [body.root, body.toRoot].filter(Boolean).every((id) => !(rootOf(L, id) || {}).remote);
    if (here) library(key, true); /* listed again from disk (the list stays meanwhile); the other PC's comes from the hub after its sync */
    docText.drop();
    vp.rerender();
    return r;
  }
  /* where + makes something: the folder last opened or picked, else the first notes folder */
  const herePlace = (vp, L) => {
    const h = vp.state.here;
    if (h && canEdit(L, h.root) && (!h.dir || (L.dirs || []).some((d) => d.root === h.root && d.path === h.dir) || (L.files || []).some((f) => f.root === h.root && under(f.path, h.dir)))) return h;
    const r = (L.roots || []).find((x) => canEdit(L, x.id));
    return r ? { root: r.id, dir: '' } : null;
  };
  async function makeNew(vp, src, root, dir, kind) {
    const L = library(src.base + '|docs').v; if (!L) return;
    const name = await MC.askText(kind === 'note' ? 'New note' : 'New folder', 'In ' + placeName(L, root, dir), kind === 'note' ? 'Untitled' : 'New folder', 'Create');
    if (name == null) return;
    const r = await noteAct(vp, src, { root, op: kind, dir, name }, (L2, res) => relist.add(L2, root, res.path, kind === 'folder'));
    if (!r) return;
    const o = (vp.state.open = vp.state.open || {}); o[root + ':'] = true; if (dir) o[root + ':' + dir] = true;
    if (kind === 'note') { vp.state.doc = { pid: src.key, path: r.path, root }; vp.state.source = false; vp.state.edit = edKey(src, vp.state.doc); delete ED[vp.state.edit]; vp.state.focusNew = vp.state.edit; } /* the cursor goes in it */
    else { o[root + ':' + r.path] = true; vp.state.here = { root, dir: r.path }; }
    vp.rerender();
  }
  async function renameItem(vp, src, root, p, isDir) {
    const old = leafOf(p), L = library(src.base + '|docs').v;
    const shown = !isDir && /\.(md|markdown)$/i.test(old) ? old.replace(/\.(md|markdown)$/i, '') : old;
    const name = await MC.askText(isDir ? 'Rename the folder' : 'Rename', 'In ' + placeName(L, root, parentOf(p)), shown, 'Rename');
    if (name == null || name.trim() === shown) return;
    const r = await noteAct(vp, src, { root, op: 'rename', path: p, name }, (L2, res) => { relist.move(L2, root, p, root, res.path); follow(vp, root, p, root, res.path); });
    if (r && r.path !== p) MC.toast(`Renamed to ${leafOf(r.path)}`, 'check', { label: 'Undo', run: () => noteAct(vp, src, { root, op: 'rename', path: r.path, name: old }, (L2, res) => { relist.move(L2, root, r.path, root, res.path); follow(vp, root, r.path, root, res.path); }) });
  }
  async function duplicateItem(vp, src, root, p) {
    const r = await noteAct(vp, src, { root, op: 'duplicate', path: p }, (L2, res) => relist.copy(L2, root, p, res.path));
    if (r) MC.toast(`Made ${leafOf(r.path)}`, 'copy');
  }
  async function deleteItem(vp, src, root, p, isDir) {
    const ok = await MC.askYes(`Delete "${leafOf(p)}"?`, isDir ? 'The folder and everything in it go to the trash, where you can get them back.' : 'It goes to the trash, where you can get it back.', 'Delete');
    if (!ok) return;
    const r = await noteAct(vp, src, { root, op: 'delete', paths: [p] }, (L2) => {
      relist.drop(L2, root, p);
      const d = vp.state.doc; if (d && d.root === root && under(d.path, p)) { vp.state.doc = null; vp.state.edit = null; }
    });
    if (r) MC.toast(r.bin === 'Recycle Bin' ? 'Moved to the Recycle Bin' : 'Moved to the trash', 'trash');
  }
  async function moveItem(vp, src, root, p, toRoot, to) {
    if (toRoot === root && (parentOf(p) === to || under(to, p))) return; /* already there, or into itself */
    const L = library(src.base + '|docs').v, dest = swap(leafOf(p), '', to);
    const r = await noteAct(vp, src, { root, op: 'move', paths: [p], to, ...(toRoot !== root ? { toRoot } : {}) }, (L2, res) => { const n = (res.paths || [])[0] || dest; relist.move(L2, root, p, toRoot, n); follow(vp, root, p, toRoot, n); });
    if (!r || !(r.paths || []).length) return;
    const n = r.paths[0], back = parentOf(p);
    const o = (vp.state.open = vp.state.open || {}); o[toRoot + ':' + to] = true;
    MC.toast(`Moved to ${placeName(L, toRoot, to)}`, 'folder', { label: 'Undo', run: () => noteAct(vp, src, { root: toRoot, op: 'move', paths: [n], to: back, ...(toRoot !== root ? { toRoot: root } : {}) }, (L2) => { relist.move(L2, toRoot, n, root, p); follow(vp, toRoot, n, root, p); }) });
  }
  /* the right-click menu of a file, a folder or a notes folder (dir: null for a file) */
  function itemMenu(vp, src, L, anchor, root, p, isDir, at) {
    const edit = canEdit(L, root), top = isDir && !p, name = top ? rootName(L, root) : leafOf(p);
    const copyPath = () => { const t = p || ''; if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => MC.toast('Copied ' + t, 'copy'), () => MC.toast('Could not copy', 'warn')); };
    const items = [{ h: name.slice(0, 40) }];
    if (!edit) {
      if (!isDir) items.push({ id: 'open', label: 'Open', icon: 'doc' }, { id: 'copy', label: 'Copy path', icon: 'copy' });
      items.push({ id: 'ro', label: 'Read only here', sub: root === 'p' ? 'the project folder' : '', icon: 'lock' });
    } else if (isDir) {
      items.push({ id: 'note', label: 'New note here', icon: 'doc' }, { id: 'folder', label: 'New folder here', icon: 'folder' });
      if (!top) items.push({ sep: 1 }, { id: 'ren', label: 'Rename', icon: 'note' }, { id: 'dup', label: 'Duplicate', icon: 'copy' }, { id: 'copy', label: 'Copy path', icon: 'copy' }, { sep: 1 }, { id: 'del', label: 'Delete', sub: 'to the trash', icon: 'trash' });
    } else {
      items.push({ id: 'open', label: 'Open', icon: 'doc' }, { id: 'edit', label: 'Edit', icon: 'note' }, { sep: 1 }, { id: 'ren', label: 'Rename', icon: 'note' }, { id: 'dup', label: 'Duplicate', icon: 'copy' }, { id: 'copy', label: 'Copy path', icon: 'copy' }, { sep: 1 }, { id: 'del', label: 'Delete', sub: 'to the trash', icon: 'trash' });
    }
    MC.menu(anchor, items, (id) => {
      if (id === 'open' || id === 'edit') { edFlush(vp); vp.state.doc = { pid: src.key, path: p, root }; vp.state.source = false; vp.state.edit = id === 'edit' ? edKey(src, vp.state.doc) : null; if (id === 'edit') delete ED[vp.state.edit]; vp.state.here = { root, dir: parentOf(p) }; vp.rerender(); }
      if (id === 'note' || id === 'folder') makeNew(vp, src, root, p, id);
      if (id === 'ren') renameItem(vp, src, root, p, isDir);
      if (id === 'dup') duplicateItem(vp, src, root, p);
      if (id === 'del') deleteItem(vp, src, root, p, isDir);
      if (id === 'copy') copyPath();
    }, at ? { at } : {});
  }
  /* a row of the tree as { root, path, dir } (dir: a folder or a notes folder), or null */
  const rowItem = (t) => {
    const tk = t.closest('[data-tk]'); if (tk) { const k = tk.dataset.tk, i = k.indexOf(':'); return { root: k.slice(0, i), path: k.slice(i + 1), dir: true, el: tk }; }
    const d = t.closest('[data-doc]'); return d ? { root: d.dataset.root, path: d.dataset.doc, dir: false, el: d } : null;
  };
  let DRAG = null; /* { root, path, dir } while a row is dragged */
  M.docs = {
    label: 'Documents', icon: 'doc',
    render: (vp) => {
      const src = libSrc(); if (!src) return noProj('Documents');
      const pid = src.key, x = library(src.base + '|docs'), L = x.v;
      if (!L) return x.err ? failed('Could not list the documents', x.err) : loading('Listing the documents');
      const roots = {}; (L.roots || []).forEach((r) => (roots[r.id] = r.label));
      const q = (vp.state.q || '').toLowerCase();
      const files = (L.files || []).filter((f) => !q || f.path.toLowerCase().includes(q)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const sel = vp.state.doc && vp.state.doc.pid === pid ? vp.state.doc : null;
      let view = `<div class="empty">${I('doc', 'lg')}<b>Pick a document</b></div>`;
      if (sel) {
        /* an .html file shows as a page in a sandbox of its own (?view=page), or as its text */
        const k = edKey(src, sel), editing = editable(sel) && vp.state.edit === k;
        const page = /\.html?$/i.test(sel.path) && !vp.state.source && !editing, pageUrl = fileUrl(src.base, sel.path, sel.root) + '&view=page';
        let e = editing ? ED[k] : null;
        if (editing && (!e || (e.st === 'err' && e.text == null && !e.tried))) { edLoad(k, fileUrl(src.base, sel.path, sel.root)); e = ED[k]; e.tried = true; if (vp.state.focusNew === k) { e.focus = true; vp.state.focusNew = null; } }
        if (e) e.url = fileUrl(src.base, sel.path, sel.root);
        const acts = (/\.html?$/i.test(sel.path) && !editing ? `<button class="btn sm ghost" data-source>${page ? 'Show the code' : 'Show the page'}</button><a class="btn sm ghost" href="${esc(pageUrl)}" target="_blank" rel="noopener">${I('ext', 'sm')}Open in a new tab</a>` : '')
          + (editable(sel) ? `<button class="btn sm ${editing ? 'primary' : 'ghost'}" data-edit>${I(editing ? 'check' : 'note', 'sm')}${editing ? 'Done' : 'Edit'}</button>` : '')
          + (canEdit(L, sel.root) ? `<button class="ibtn sm" data-dmore title="Rename, duplicate, delete">${I('more', 'sm')}</button>` : '')
          + (e && e.st !== 'load' ? `<span class="dsave ${e.st}" data-dsave="${esc(k)}">${edIcon(e)}${esc(edLabel(e))}</span>` : '');
        const head = `<div class="dhead"><button class="linkb dback" data-back>${I('chevL', 'sm')}All documents</button><b class="ellip">${esc(sel.path.split('/').pop())}</b><span class="faint ellip">${esc(roots[sel.root] || '')} · ${esc(sel.path)}</span>${acts ? `<span class="dacts">${acts}</span>` : ''}</div>`;
        const t = page || editing ? null : docText(k);
        view = editing ? head + (!e || e.st === 'load' ? loading('Opening')
          : e.text == null ? `<div class="lv-err">${I('xc', 'sm')}${esc(e.err || 'Could not open it')} <button class="btn sm" data-edretry>Try again</button></div>`
          : (e.st === 'conflict' ? `<div class="dconf">${I('warn', 'sm')}<b>This note changed somewhere else since you opened it.</b><span class="grow"></span><button class="btn sm" data-edtheirs>Use that version</button><button class="btn sm primary" data-edmine>Keep mine</button></div>` : '')
            + `<div><textarea class="dedit" data-ed spellcheck="true">${esc(e.text)}</textarea></div>`)
          : page ? head + `<iframe class="dframe" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" src="${esc(pageUrl)}"></iframe>`
          : t.v != null && !t.busy ? head + (t.v.slice(0, 8000).includes('\u0000') ? `<div class="empty">${I('doc', 'lg')}<b>This file is not text</b></div>` : /\.(md|markdown)$/i.test(sel.path) ? `<div class="md">${MC.md(t.v.slice(0, 200000))}</div>` : `<pre class="dpre">${esc(t.v.slice(0, 200000))}</pre>`) : t.err ? `<div class="lv-err">${esc(t.err)}</div>` : loading('Opening');
      }
      const on = (f) => (sel && sel.path === f.path && sel.root === f.root ? 'on' : '');
      const drag = (root) => (canEdit(L, root) ? ' draggable="true"' : '');
      const tree = treeMode(vp) ? treeHtml(vp, L, (fs, root, node, depth) => fs.slice().sort((a, b) => byName(a.path, b.path)).map((f) => `<div class="ditem tfile ${on(f)}" style="--d:${depth}" data-doc="${esc(f.path)}" data-root="${esc(f.root)}" title="${esc(f.path)}"${drag(f.root)}>${I(fileIcon(f.path), 'sm')}<span class="grow ellip dn">${esc(shownName(f.path))}</span>${extTag(f.path) ? `<span class="k">${esc(extTag(f.path))}</span>` : ''}<span class="dw">${esc(ago(f.mtime))}</span></div>`).join(''), { keep: (id) => canEdit(L, id), attrs: (root, p) => (p ? drag(root) : '') }) || '<div class="lv-empty">No documents found</div>' : null;
      return `<div class="docwrap"><div class="docs ${sel ? 'has-doc' : ''}"><div class="dlist"><div class="ltop"><div class="input grow" style="height:calc(36px*var(--k))">${I('search', 'sm')}<input data-q placeholder="Find a document" value="${esc(vp.state.q || '')}"></div>${modeSeg(vp)}${herePlace(vp, L) ? `<button class="ibtn" data-dnew title="New note or folder">${I('plus', 'sm')}</button>` : ''}</div>
        ${tree != null ? tree : files.slice(0, 300).map((f) => `<div class="ditem ${sel && sel.path === f.path && sel.root === f.root ? 'on' : ''}" data-doc="${esc(f.path)}" data-root="${esc(f.root)}" title="${esc(f.path)}"><span class="k">${esc(extTag(f.path) || (f.root === 'p' ? 'MD' : 'NOTE'))}</span><div class="grow" style="min-width:0"><div class="dn ellip">${esc(niceName(f.path.split('/').pop()))}</div><div class="dw ellip">${esc((f.root === 'p' ? '' : (roots[f.root] || '') + ' · ') + (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : 'top folder'))} · ${esc(ago(f.mtime))}</div></div></div>`).join('') || '<div class="lv-empty">No documents found</div>'}
        ${L.cut ? '<div class="faint" style="padding:calc(6px*var(--k))">Only the first 600 files are listed.</div>' : ''}</div><div class="dview">${view}</div></div></div>`;
    },
    mount: (el, vp) => {
      const q = el.querySelector('[data-q]'); if (q) q.oninput = () => { vp.state.q = q.value; const pos = q.selectionStart; vp.rerender(); const q2 = vp.body.querySelector('[data-q]'); if (q2) { q2.focus(); q2.setSelectionRange(pos, pos); } };
      el.onclick = (e) => {
        const src = libSrc(); if (!src) return; const pid = src.key;
        if (e.target.closest('[data-retry]')) { library(src.base + '|docs', true); return; }
        if (e.target.closest('[data-back]')) { edFlush(vp); vp.state.doc = null; vp.state.edit = null; vp.rerender(); return; }
        if (e.target.closest('[data-source]')) { vp.state.source = !vp.state.source; vp.rerender(); return; }
        const sel = vp.state.doc, k = sel && edKey(src, sel), x = k && ED[k];
        if (e.target.closest('[data-edit]')) {
          if (vp.state.edit === k) { edFlush(vp); vp.state.edit = null; }
          else { if (!x || !['dirty', 'saving', 'conflict'].includes(x.st)) delete ED[k]; vp.state.edit = k; ED[k] && (ED[k].focus = true); }
          vp.rerender(); return;
        }
        if (e.target.closest('[data-edretry]')) { delete ED[k]; vp.rerender(); return; }
        if (x && x.theirs && e.target.closest('[data-edtheirs]')) { Object.assign(x, { text: x.theirs.text, hash: x.theirs.hash, theirs: null, st: 'saved', where: null }); docText.drop(k); vp.rerender(); return; }
        if (x && x.theirs && e.target.closest('[data-edmine]')) { const h = x.theirs.hash; x.theirs = null; x.st = 'dirty'; vp.rerender(); edSave(k, x.url, h); return; }
        const L = library(src.base + '|docs').v;
        const nb = e.target.closest('[data-dnew]');
        if (nb && L) { const h = herePlace(vp, L); if (h) MC.menu(nb, [{ h: 'In ' + placeName(L, h.root, h.dir) }, { id: 'note', label: 'New note', icon: 'doc' }, { id: 'folder', label: 'New folder', icon: 'folder' }], (id) => makeNew(vp, src, h.root, h.dir, id), { alignRight: true }); return; }
        const mb = e.target.closest('[data-dmore]'); if (mb && L && sel) { itemMenu(vp, src, L, mb, sel.root, sel.path, false); return; }
        const tk = e.target.closest('[data-tk]'); if (tk) { const it = rowItem(tk); vp.state.here = { root: it.root, dir: it.path }; flipDir(vp, tk); return; }
        const lm = e.target.closest('[data-lmode] [data-val]'); if (lm) { vp.state.mode = lm.dataset.val; vp.rerender(); return; }
        const d = e.target.closest('[data-doc]'); if (d) { edFlush(vp); vp.state.doc = { pid, path: d.dataset.doc, root: d.dataset.root }; vp.state.here = { root: d.dataset.root, dir: parentOf(d.dataset.doc) }; vp.state.source = false; vp.state.edit = null; vp.rerender(); }
      };
      /* a right-click on a file, a folder or a notes folder */
      el.oncontextmenu = (e) => {
        const src = libSrc(), L = src && library(src.base + '|docs').v, it = L && e.target.closest('.dlist') && rowItem(e.target);
        if (!it) return;
        e.preventDefault();
        itemMenu(vp, src, L, it.el, it.root, it.path, it.dir, { x: e.clientX, y: e.clientY });
      };
      /* drag a note or a folder onto a folder (or onto a note, for its folder) to move it there; a closed folder opens
         when the drag waits on it */
      let hoverT = 0, hoverK = null;
      const target = (e) => {
        const ours = e.dataTransfer && [...e.dataTransfer.types].includes('text/mc-note'); /* not a file from the desktop */
        const src = libSrc(), L = src && library(src.base + '|docs').v, it = ours && DRAG && L && rowItem(e.target);
        if (!it) return null;
        const to = it.dir ? it.path : parentOf(it.path);
        return canDrop(L, DRAG.root, it.root) && !(DRAG.root === it.root && (to === parentOf(DRAG.path) || (DRAG.dir && under(to, DRAG.path)))) ? { ...it, to } : null;
      };
      const unmark = () => { $$('.drop', el).forEach((x) => x.classList.toggle('drop', false)); };
      el.ondragstart = (e) => {
        const it = e.target.closest && e.target.closest('[draggable="true"]') && rowItem(e.target);
        if (!it || !el.contains(it.el)) return;
        DRAG = { root: it.root, path: it.path, dir: it.dir };
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.path); e.dataTransfer.setData('text/mc-note', it.root);
        it.el.classList.add('dragging');
      };
      el.ondragover = (e) => {
        const t = target(e); unmark();
        if (!t) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const row = t.dir ? t.el : el.querySelector(`[data-tk="${CSS.escape(t.root + ':' + t.to)}"]`) || t.el;
        row.classList.add('drop');
        const k = t.dir ? t.el.dataset.tk : null;
        if (k !== hoverK) { clearTimeout(hoverT); hoverK = k; if (k && t.el.getAttribute('aria-expanded') !== 'true') hoverT = setTimeout(() => { const o = (vp.state.open = vp.state.open || {}); o[k] = true; vp.rerender(); }, 700); }
      };
      el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) { unmark(); clearTimeout(hoverT); hoverK = null; } };
      el.ondrop = (e) => {
        const t = target(e), d = DRAG; unmark(); clearTimeout(hoverT); hoverK = null;
        if (!t || !d) return;
        e.preventDefault(); DRAG = null;
        const src = libSrc(); if (src) moveItem(vp, src, d.root, d.path, t.root, t.to);
      };
      el.ondragend = () => { DRAG = null; clearTimeout(hoverT); hoverK = null; unmark(); $$('.dragging', el).forEach((x) => x.classList.toggle('dragging', false)); };
      /* the editor: each key marks the note changed and saves it a moment after the last one; where the cursor was survives
         a repaint of the panel */
      const ta = el.querySelector('[data-ed]'), src = libSrc(), sel = vp.state.doc;
      if (ta && src && sel) {
        const k = edKey(src, sel), x = ED[k];
        if (x) {
          if (x.sel) { ta.focus(); ta.setSelectionRange(x.sel[0], x.sel[1]); ta.scrollTop = x.sel[2]; } else if (x.focus) { ta.focus(); ta.setSelectionRange(0, 0); x.focus = false; }
          const keep = () => { x.sel = document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd, ta.scrollTop] : null; };
          ta.oninput = () => { x.text = ta.value; if (x.st !== 'conflict') { x.st = 'dirty'; clearTimeout(x.t); x.t = setTimeout(() => edSave(k, x.url), SAVE_MS); edPaint(k); } keep(); };
          ta.onkeyup = ta.onclick = ta.onscroll = keep;
          ta.onblur = () => { setTimeout(() => { if (ta.isConnected) x.sel = null; }); if (x.st === 'dirty') edSave(k, x.url); }; /* a repaint takes the textarea away without a real blur */
          ta.onkeydown = (ev) => {
            if (ev.key === 's' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (x.st === 'dirty') edSave(k, x.url); }
            if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
          };
        }
      }
    },
  };

  /* ---------- Gallery: pictures in the project folder, and pictures from its conversations ---------- */
  async function toChat(src, name) {
    if (!S.session) { MC.toast('Open a conversation first', 'chat'); return; }
    try {
      const r = await fetch(src, { headers: { 'X-MC': '1' } }); if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob(); H.attachFiles([new File([b], name || 'picture.png', { type: b.type || 'image/png' })]);
      MC.emit('open', 'convo'); MC.toast('Added to the message box', 'image');
    } catch (e) { MC.toast('Could not add it: ' + errText(e), 'warn'); }
  }
  const tile = (src, name, sub, i) => `<div class="gi" data-gi="${i}"><button class="gsel" data-tochat="${i}" title="Put it in the message box">${I('chat', 'sm')}</button><img src="${esc(src)}" loading="lazy" alt=""><div class="gc"><span class="ellip">${esc(name)}</span><span class="faint">${esc(sub)}</span></div></div>`;
  M.gallery = {
    label: 'Gallery', icon: 'image', tabs: ['Project', 'Conversations'],
    render: (vp) => {
      const src = libSrc(); if (!src || (src.pc && vp.tab === 'Conversations')) return noProj('Galleries');
      const pid = src.key;
      let list = [], head = '';
      if (vp.tab === 'Conversations') {
        const rows = ((LV.lists[pid] && LV.lists[pid].rows) || []).slice(0, 60);
        if (!LV.lists[pid]) H.loadList(pid).then(() => MC.emit('rerender', 'gallery'));
        const open = vp.state.conv;
        if (open) {
          const x = convImgs(open), imgs = ((x.v && x.v.images) || []).slice().reverse();
          list = imgs.map((m) => ({ src: m.src, name: m.name || 'picture', from: m.from, caption: m.caption, sub: m.from === 'you' ? 'you' : m.from === 'tool' ? 'Claude looked' : 'Claude' }));
          head = `<button class="btn sm ghost" data-back>${I('chevL', 'sm')}All conversations</button><b class="ellip">${esc(MC.sessionById(open).title)}</b>`;
          if (!x.v) return `<div class="gal"><div class="tbar">${head}</div>${x.err ? `<div class="lv-err">${esc(x.err)}</div>` : loading('Finding the pictures')}</div>`;
        } else {
          const ids = rows.map((r) => r.id).join(','), c = ids ? imgCounts(ids) : { v: { counts: {} } }, n = (c.v && c.v.counts) || {};
          const withImgs = rows.filter((r) => n[r.id] > 0);
          return `<div class="gal"><div class="list">${!c.v ? loading('Counting pictures') : withImgs.map((r) => `<div class="li" data-conv="${esc(r.id)}" style="cursor:pointer">${I('image')}<span class="grow ellip">${esc(r.title || 'Untitled conversation')}</span><span class="lm">${n[r.id]} · ${esc(ago(r.lastAt))}</span></div>`).join('') || '<div class="lv-empty">No pictures in these conversations</div>'}</div></div>`;
        }
      } else {
        const x = library(src.base + '|images'), L = x.v;
        if (!L) return x.err ? failed('Could not list the pictures', x.err) : loading('Finding the pictures');
        const roots = {}; (L.roots || []).forEach((r) => (roots[r.id] = r.label));
        const pic = (f) => ({ src: fileUrl(src.base, f.path, f.root), name: f.path.split('/').pop(), label: f.path, sub: ago(f.mtime), dir: f.root + ':' + f.path.slice(0, Math.max(0, f.path.lastIndexOf('/'))) });
        list = (L.files || []).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).map(pic);
        head = `<span class="faint">${list.length} picture${list.length === 1 ? '' : 's'} ${src.pc ? 'in its notes' : 'in the project folder'}${L.cut ? ' (the first 6000)' : ''}</span><span class="grow"></span>${modeSeg(vp)}`;
        if (treeMode(vp)) {
          /* by folder: each folder's pictures newest first; the viewer steps through that folder */
          const shown = [], fmax = vp.state.fmax || {};
          const tree = treeHtml(vp, L, (fs, root, node, depth) => {
            const k = root + ':' + node.path, max = fmax[k] || 120, ps = fs.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).map(pic);
            const tiles = ps.slice(0, max).map((g) => { shown.push(g); return tile(g.src, g.name, g.sub, shown.length - 1); }).join('');
            return `<div class="ggrid tgrid" style="--d:${depth}">${tiles}</div>${ps.length > max ? `<button class="btn sm ghost tmore" style="--d:${depth}" data-fmore="${esc(k)}">Show more (${ps.length - max} left)</button>` : ''}`;
          });
          vp._gal = shown;
          return `<div class="gal"><div class="tbar">${head}<div class="input" style="width:calc(220px*var(--k));height:calc(36px*var(--k))">${I('search', 'sm')}<input data-q placeholder="Find a picture" value="${esc(vp.state.q || '')}"></div></div>
            <div class="ltree">${tree || '<div class="lv-empty">No pictures</div>'}</div></div>`;
        }
      }
      const q = (vp.state.q || '').toLowerCase(), shown = list.filter((g) => !q || (g.label || g.name).toLowerCase().includes(q)), max = vp.state.max || 120;
      vp._gal = shown;
      return `<div class="gal"><div class="tbar">${head}${vp.tab === 'Conversations' ? '<span class="grow"></span>' : ''}<div class="input" style="width:calc(220px*var(--k));height:calc(36px*var(--k))">${I('search', 'sm')}<input data-q placeholder="Find a picture" value="${esc(vp.state.q || '')}"></div></div>
        <div class="ggrid">${shown.slice(0, max).map((g, i) => tile(g.src, g.name, g.sub, i)).join('') || '<div class="lv-empty">No pictures</div>'}</div>${shown.length > max ? `<button class="btn sm ghost" data-more style="align-self:center">Show more (${shown.length - max} left)</button>` : ''}</div>`;
    },
    mount: (el, vp) => {
      const q = el.querySelector('[data-q]'); if (q) q.oninput = () => { vp.state.q = q.value; const pos = q.selectionStart; vp.rerender(); const q2 = vp.body.querySelector('[data-q]'); if (q2) { q2.focus(); q2.setSelectionRange(pos, pos); } };
      el.onclick = (e) => {
        const src = libSrc(); if (!src) return; const t = e.target;
        if (t.closest('[data-retry]')) { library(src.base + '|images', true); return; }
        if (t.closest('[data-back]')) { vp.state.conv = null; vp.rerender(); return; }
        const cv = t.closest('[data-conv]'); if (cv) { vp.state.conv = cv.dataset.conv; vp.state.max = 120; vp.rerender(); return; }
        if (t.closest('[data-more]')) { vp.state.max = (vp.state.max || 120) + 120; vp.rerender(); return; }
        const tk = t.closest('[data-tk]'); if (tk) { flipDir(vp, tk); return; }
        const lm = t.closest('[data-lmode] [data-val]'); if (lm) { vp.state.mode = lm.dataset.val; vp.rerender(); return; }
        const fm = t.closest('[data-fmore]'); if (fm) { const o = (vp.state.fmax = vp.state.fmax || {}); o[fm.dataset.fmore] = (o[fm.dataset.fmore] || 120) + 120; vp.rerender(); return; }
        const list = vp._gal || [];
        const tc = t.closest('[data-tochat]'); if (tc) { const g = list[+tc.dataset.tochat]; if (g) toChat(g.src, g.name); return; }
        const gi = t.closest('[data-gi]'); if (gi && vp.tab !== 'Conversations' && treeMode(vp)) { const g0 = list[+gi.dataset.gi], same = list.filter((g) => g.dir === g0.dir); MC.gallery.open(same.map((g) => ({ src: g.src, name: g.name })), same.indexOf(g0), { opener: gi }); return; }
        if (gi) MC.gallery.open(list.map((g) => ({ src: g.src, name: g.name, from: g.from, caption: g.caption, label: g.from ? undefined : '' })), +gi.dataset.gi, { opener: gi });
      };
    },
  };

  /* ---------- Project settings: the name, archive, build checks, and the jobs (add, reorder, remove, label, kind, flags) ---------- */
  const KINDS = [['build-dev', 'Build, dev'], ['build-release', 'Build, release'], ['export-game', 'Export game'], ['install-local', 'Install on this PC'], ['make-installer', 'Make installer'], ['push-github', 'Push to GitHub'], ['publish-website', 'Publish website'], ['release', 'Release'], ['deploy', 'Deploy'], ['sync', 'Sync'], ['test', 'Test'], ['run-dev', 'Run, dev'], ['clean', 'Clean'], ['other', 'Other']];
  const OUTWARD = new Set(['push-github', 'publish-website', 'release', 'deploy', 'sync']);
  const scripts = cache((pid) => api.get(`/api/projects/${enc(pid)}/scripts`).then((r) => r.scripts || []), ['settings'], 60000);
  const cloneJob = (j) => ({ id: j.id, label: j.label, file: j.file || null, builtin: j.builtin || null, kind: j.kind, outward: !!j.outward, interactive: !!j.interactive, visible: j.visible !== false });
  const fromDetail = (d) => ({ name: d.name, about: d.about || '', hidden: !!d.hidden, req: Object.fromEntries((d.checks || []).map((c) => [c.key, !!c.required])), jobs: (d.jobs || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(cloneJob) });
  const jobsNorm = (jobs) => jobs.map((j) => [j.id, j.label, j.file, j.builtin, j.kind, j.outward, j.interactive, j.visible]);
  const normE = (E) => JSON.stringify([E.name.trim(), E.about.trim(), E.hidden, Object.keys(E.req).sort().map((k) => [k, E.req[k]]), jobsNorm(E.jobs)]);
  /* the server refuses these characters in a script path (they are unsafe in a command line) */
  const badName = (f) => /["%^&|<>\x00-\x1f]/.test(String(f || ''));
  const normPath = (f) => String(f || '').replace(/\//g, '\\').toLowerCase();
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 36) || 'job';
  const uniqueId = (E, base) => { let n = base, i = 2; while (E.jobs.some((j) => j.id === n)) n = base + '-' + i++; return n; };
  /* a new job's kind, from the words of its script name */
  const KIND_GUESS = [[/push/, 'push-github'], [/publish|upload/, 'publish-website'], [/installer|setup|nsis/, 'make-installer'], [/install/, 'install-local'], [/build.*release|release.*build/, 'build-release'], [/release/, 'release'], [/deploy/, 'deploy'], [/sync/, 'sync'], [/test/, 'test'], [/clean/, 'clean'], [/export/, 'export-game'], [/build/, 'build-dev'], [/dev|run|start/, 'run-dev']];
  const guessKind = (n) => (KIND_GUESS.find(([re]) => re.test(n.toLowerCase())) || [0, 'other'])[1];
  const niceLabel = (n) => { const t = n.replace(/[-_]+/g, ' ').trim(); return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 40) || 'Job'; };
  function addScript(E, s) {
    if (s.builtin === 'git-push') { E.jobs.push({ id: uniqueId(E, 'push'), label: 'Push to GitHub', file: null, builtin: 'git-push', kind: 'push-github', outward: true, interactive: false, visible: true }); return; }
    const base = s.file.split(/[\\/]/).pop().replace(/\.(bat|cmd|ps1)$/i, ''), kind = guessKind(base);
    E.jobs.push({ id: uniqueId(E, slug(base)), label: niceLabel(base), file: s.file, builtin: null, kind, outward: OUTWARD.has(kind), interactive: !!s.interactiveGuess, visible: true });
  }
  /* New, Changed or nothing: a job row against the saved settings (a move counts as a change) */
  const rowMark = (E, O, i) => { const j = E.jobs[i], o = O.jobs.find((x) => x.id === j.id); if (!o) return 'New'; return JSON.stringify(jobsNorm([o])) !== JSON.stringify(jobsNorm([j])) || O.jobs.indexOf(o) !== i ? 'Changed' : ''; };
  const tog = (on, attr) => `<span class="tog ${on ? 'on' : ''}" role="switch" aria-checked="${on}" ${attr}></span>`;
  const jtg = (act, on, text, locked, title) => `<button class="jtg" data-act="${act}" role="switch" aria-checked="${on}" ${locked ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>${tog(on, '')}<span>${esc(text)}</span></button>`;
  const ERR_FIELDS = ['kind', 'outward', 'interactive', 'visible', 'file', 'builtin', 'id', 'order'];
  M.settings = {
    label: 'Project settings', icon: 'gear',
    render: (vp) => {
      const pid = realPid(); if (!pid) return noProj('Settings');
      const x = detail(pid), d = x.v;
      if (!d) return x.err ? failed('Could not load the project', x.err) : loading('Loading the settings');
      if (!vp.state.edit || vp.state.editPid !== pid) { vp.state.edit = fromDetail(d); vp.state.editPid = pid; vp.state.errs = {}; vp.state.banner = ''; }
      const E = vp.state.edit, O = fromDetail(d), dirty = normE(E) !== normE(O), errs = vp.state.errs || {}, n = E.jobs.length;
      const row = (l, s, ctl) => `<div class="fr"><div class="fl2"><b>${l}</b><span>${s}</span></div>${ctl}</div>`;
      const ferr = (keys) => { const m = keys.map((k) => errs[k]).filter(Boolean); return m.length ? `<div class="jerr" role="alert">${I('warn', 'sm')}<span>${m.map(esc).join('<br>')}</span></div>` : ''; };
      const jobRow = (j, i) => {
        const mark = rowMark(E, O, i), b = !!j.builtin, kind = (KINDS.find((k) => k[0] === j.kind) || [j.kind, j.kind])[1];
        return `<div class="jrow ${mark ? 'chg' : ''} ${j.visible ? '' : 'hid'}" data-i="${i}">
          <div class="jl"><span class="jgrip" title="Drag to reorder">${I('grip', 'sm')}</span><span class="input jlab ${errs[i + ':label'] ? 'bad' : ''}"><input data-label="${i}" maxlength="40" value="${esc(j.label)}" aria-label="Button label"></span>${jtg('vis', j.visible, j.visible ? 'Shown' : 'Not shown')}<span class="grow"></span><span class="jtag" ${mark ? '' : 'hidden'}>${mark}</span>
            <button class="ibtn sm" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${I('arrowU', 'sm')}</button><button class="ibtn sm" data-act="down" title="Move down" ${i === n - 1 ? 'disabled' : ''}>${I('down', 'sm')}</button><button class="ibtn sm" data-act="rm" title="Remove">${I('trash', 'sm')}</button></div>
          ${ferr([i + ':label'])}
          <div class="jl"><span class="mono faint ellip grow" title="${esc(b ? 'git push' : j.file)}">${b ? 'Built in: git push' : esc(j.file)}</span><button class="pillsel ${errs[i + ':kind'] ? 'bad' : ''}" data-act="kind" title="Kind">${I(OUTWARD.has(j.kind) ? 'share' : 'play', 'sm')}${esc(kind)}${I('chev', 'sm')}</button>${jtg('out', j.outward, 'Sends off this PC: ' + (j.outward ? 'Yes' : 'No') + (b ? ' (locked)' : ''), b, b ? 'A git push always goes off this PC' : '')}${jtg('int', j.interactive, 'Own window: ' + (j.interactive ? 'Yes' : 'No'), b, b ? 'A git push runs with its output shown here' : '')}</div>
          ${ferr(ERR_FIELDS.map((f) => i + ':' + f))}</div>`;
      };
      /* the folder's scripts that have no job yet */
      const sc = scripts(pid), tracked = (f) => E.jobs.some((j) => j.file && normPath(j.file) === normPath(f));
      let others;
      if (!sc.v) others = sc.err ? `<div class="lv-err">${I('xc', 'sm')}Could not list the scripts: ${esc(sc.err)} <button class="btn sm" data-rescan>Try again</button></div>` : loading('Looking for scripts');
      else {
        const rest = sc.v.map((s, k) => [s, k]).filter(([s]) => (s.builtin ? !E.jobs.some((j) => j.builtin === s.builtin) : !tracked(s.file)));
        others = rest.length ? `<div class="ovrows">${rest.map(([s, k]) => `<div class="ovr">${I(s.builtin ? 'git' : 'terminal', 'sm')}<span class="grow mono ellip" title="${esc(s.file)}">${esc(s.file)}</span>${s.interactiveGuess ? MC.st('idle', 'Seems to wait for a key') : ''}${!s.builtin && badName(s.file) ? MC.st('fail', 'Name not allowed') : `<button class="btn sm" data-add="${k}">${I('plus', 'sm')}Add</button>`}</div>`).join('')}</div>` : '<div class="faint">Every script in this folder is already tracked.</div>';
      }
      const inp = (f, max, w) => `<div class="input ${errs['p:' + f] ? 'bad' : ''}" style="width:calc(${w}px*var(--k));height:calc(38px*var(--k))"><input data-f="${f}" maxlength="${max}" value="${esc(E[f])}"></div>`;
      return `<div class="form jform">
        ${row('Display name', 'How the project shows everywhere', inp('name', 60, 320))}
        ${row('Subtitle', 'One line under the name', inp('about', 160, 320))}
        ${ferr(['p:name', 'p:about'])}
        ${row('Archived', 'Hidden from the lists. Its conversations stay.', tog(E.hidden, 'data-act="hidden"'))}
        <div class="sect-h">Build checks</div>
        ${(d.checks || []).map((c) => row(esc(c.label), esc(c.line || c.detail || ''), tog(E.req[c.key], `data-act="req" data-k="${esc(c.key)}"`))).join('') || '<div class="faint">No checks for this project.</div>'}
        <div class="sect-h">Jobs<span class="grow"></span>${n ? `<span class="note">${n} tracked script${n === 1 ? '' : 's'}</span>` : ''}</div>
        <div class="jlist">${n ? E.jobs.map(jobRow).join('') : '<div class="faint">No scripts are tracked yet.</div>'}</div>
        <div class="sect-h">Other scripts in this folder</div>
        ${others}
        <div class="jbar">${vp.state.banner ? `<div class="lv-err" role="alert">${I('warn', 'sm')}${esc(vp.state.banner)}</div>` : ''}<div class="row"><span class="grow faint" data-dirty>${vp.state.saving ? 'Saving' : dirty ? 'Not saved yet' : 'Saved'}</span><button class="btn sm ghost" data-revert ${dirty && !vp.state.saving ? '' : 'disabled'}>Undo changes</button><button class="btn sm primary" data-save ${dirty && !vp.state.saving ? '' : 'disabled'}>${I('check', 'sm')}Save</button></div></div></div>`;
    },
    mount: (el, vp) => {
      const pid = realPid();
      if (!pid || !vp.state.edit) { el.onclick = (e) => { if (pid && e.target.closest('[data-retry]')) detail(pid, true); }; return; }
      const E = vp.state.edit, d = detail(pid).v, O = fromDetail(d), errs = vp.state.errs || (vp.state.errs = {});
      const mark = () => { const dirty = normE(E) !== normE(O), off = !dirty || !!vp.state.saving; el.querySelector('[data-save]').disabled = off; el.querySelector('[data-revert]').disabled = off; el.querySelector('[data-dirty]').textContent = vp.state.saving ? 'Saving' : dirty ? 'Not saved yet' : 'Saved'; };
      /* a structural change paints the panel again; typing only updates the marks in place, so the field keeps its focus */
      const changed = () => { vp.state.errs = {}; vp.state.banner = ''; vp.rerender(); };
      el.oninput = (e) => {
        const t = e.target, f = t.dataset.f, l = t.dataset.label;
        if (f) { E[f] = t.value; delete errs['p:' + f]; }
        if (l != null) {
          const i = +l, row = t.closest('.jrow'); E.jobs[i].label = t.value; delete errs[i + ':label'];
          const mk = rowMark(E, O, i), tag = row.querySelector('.jtag'); row.classList.toggle('chg', !!mk); tag.textContent = mk; tag.hidden = !mk;
        }
        const box = t.closest('.input'); if (box) box.classList.remove('bad');
        mark();
      };
      el.onclick = async (e) => {
        const t = e.target;
        if (t.closest('[data-retry]')) { detail(pid, true); return; }
        if (t.closest('[data-rescan]')) { scripts(pid, true); return; }
        if (vp.state.saving) return;
        const b = t.closest('[data-act]');
        if (b && !b.disabled) {
          const act = b.dataset.act, row = b.closest('.jrow'), i = row ? +row.dataset.i : -1, j = E.jobs[i];
          if (act === 'kind' && j) {
            MC.menu(b, [{ h: 'Kind' }, ...KINDS.map(([id, l]) => ({ id, label: l, icon: OUTWARD.has(id) ? 'share' : 'play', on: j.kind === id }))], (id) => { j.kind = id; if (OUTWARD.has(id) && !j.outward && !j.builtin) j.outward = true; changed(); });
            return;
          }
          if (act === 'hidden') E.hidden = !E.hidden;
          else if (act === 'req') E.req[b.dataset.k] = !E.req[b.dataset.k];
          else if (act === 'vis' && j) j.visible = !j.visible;
          else if (act === 'out' && j && !j.builtin) j.outward = !j.outward;
          else if (act === 'int' && j && !j.builtin) j.interactive = !j.interactive;
          else if ((act === 'up' || act === 'down') && j) { const k = i + (act === 'up' ? -1 : 1); if (k < 0 || k >= E.jobs.length) return; [E.jobs[i], E.jobs[k]] = [E.jobs[k], E.jobs[i]]; }
          else if (act === 'rm' && j) E.jobs.splice(i, 1);
          else return;
          changed(); return;
        }
        const a = t.closest('[data-add]'); if (a) { const s = (scripts(pid).v || [])[+a.dataset.add]; if (s && (s.builtin || !badName(s.file))) { addScript(E, s); changed(); } return; }
        if (t.closest('[data-revert]')) { vp.state.edit = null; vp.rerender(); return; }
        if (t.closest('[data-save]')) {
          const body = {};
          if (E.name.trim() !== O.name.trim()) body.name = E.name.trim() || String(d.folder || '').split(/[\\/]/).pop(); /* an empty box means the folder's name */
          if (E.about.trim() !== O.about.trim()) body.about = E.about.trim();
          if (E.hidden !== O.hidden) body.hidden = E.hidden;
          const ch = {}; Object.keys(E.req).forEach((k) => { if (E.req[k] !== O.req[k]) ch[k] = { required: E.req[k] }; }); if (Object.keys(ch).length) body.checks = ch;
          if (JSON.stringify(jobsNorm(E.jobs)) !== JSON.stringify(jobsNorm(O.jobs))) body.jobs = E.jobs.map((j, i) => ({ id: j.id, label: j.label.trim(), file: j.builtin ? null : j.file, builtin: j.builtin || null, kind: j.kind, outward: j.outward, interactive: j.interactive, order: i, visible: j.visible }));
          vp.state.saving = true; vp.state.banner = ''; mark();
          try {
            await api.put(`/api/projects/${enc(pid)}/settings`, body);
            MC.toast(body.hidden === true ? 'Saved. This project is archived.' : 'Settings saved', 'check');
            vp.state.saving = false; vp.state.edit = null; detail.drop(pid); scripts.drop(pid); jobsAll('all', true); vp.rerender();
          } catch (er) {
            /* the server names the field: "jobs[2].label must be ..." or "name cannot be empty" */
            const msg = errText(er), m = /^jobs\[(\d+)\]\.(\w+)\s*(.*)$/.exec(msg), pm = /^(name|about) (.*)$/.exec(msg), E2 = {};
            if (pm) E2['p:' + pm[1]] = (pm[1] === 'name' ? 'Name ' : 'Subtitle ') + pm[2];
            else if (m) E2[m[1] + ':' + m[2]] = m[2].charAt(0).toUpperCase() + m[2].slice(1) + ' ' + m[3];
            vp.state.saving = false; vp.state.errs = E2; vp.state.banner = 'Not saved. ' + (Object.values(E2)[0] || msg); vp.rerender();
          }
        }
      };
      /* reorder: drag a job by its grip (the same pattern as Manage layouts) */
      let dragI = null;
      const clear = () => $$('.jrow', el).forEach((x) => x.classList.remove('dropb', 'dropa'));
      el.onmousedown = (e) => { const g = e.target.closest('.jgrip'); if (g) g.closest('.jrow').draggable = true; };
      el.onmouseup = () => { if (dragI == null) $$('.jrow[draggable="true"]', el).forEach((x) => (x.draggable = false)); };
      el.ondragstart = (e) => { const r = e.target.closest && e.target.closest('.jrow'); if (!r || !r.draggable) return; dragI = +r.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragI)); r.classList.add('dragging'); };
      const over = (e) => { const r = e.target.closest('.jrow'); clear(); if (!r || +r.dataset.i === dragI) return null; const b = r.getBoundingClientRect(), after = e.clientY > b.top + b.height / 2; r.classList.add(after ? 'dropa' : 'dropb'); return { i: +r.dataset.i, after }; };
      el.ondragover = (e) => { if (dragI == null) return; e.preventDefault(); over(e); };
      el.ondrop = (e) => {
        if (dragI == null) return; e.preventDefault();
        const t = over(e), from = dragI; dragI = null;
        if (t) { const [j] = E.jobs.splice(from, 1); E.jobs.splice(t.i - (from < t.i ? 1 : 0) + (t.after ? 1 : 0), 0, j); changed(); }
      };
      el.ondragend = () => { dragI = null; $$('.jrow', el).forEach((x) => { x.draggable = false; x.classList.remove('dragging', 'dropb', 'dropa'); }); };
    },
  };

  /* ---------- Usage: plan usage, the open conversation's context and cache, and cost at API prices ---------- */
  const ring = (pct, warn) => { const c = 2 * Math.PI * 8; return `<svg class="ring" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="none" stroke="var(--press)" stroke-width="3"/><circle cx="11" cy="11" r="8" fill="none" stroke="${warn ? 'var(--warn)' : 'var(--hi)'}" stroke-width="3" stroke-dasharray="${c * Math.max(0, Math.min(1, pct))} ${c}" transform="rotate(-90 11 11)" stroke-linecap="round"/></svg>`; };
  const dayName = (t) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' });
  const resetText = (iso, week) => { const t = toMs(iso); if (!t) return ''; return 'resets ' + (week && t - Date.now() > 86400000 ? dayName(t) + ' ' : '') + hhmm(t); };
  /* the two plan meters only: the 5-hour session and the week */
  function planHtml() {
    const u = LV.usage;
    if (!u && usageErr) return `<div class="lv-err">${I('xc', 'sm')}Could not read plan usage: ${esc(usageErr)} <button class="btn sm" data-u="refresh">Try again</button></div>`;
    if (!u) { loadUsage(); return loading('Reading plan usage'); }
    const m = (l, w, week) => { if (!w) return `<div class="meter"><div class="row"><b>${l}</b><span class="faint">not known yet</span></div><div class="bar"><i style="width:0"></i></div></div>`; const p = Math.round(w.pct || 0); return `<div class="meter"><div class="row"><b>${l}</b><span>${p}% · ${esc(resetText(w.resetsAt, week))}</span></div><div class="bar ${p >= 80 ? 'warn' : ''}"><i style="width:${Math.min(100, p)}%"></i></div></div>`; };
    return m('Session (5 h)', u.fiveHour) + m('Week', u.sevenDay, true) + `<div class="faint row" style="font-size:calc(13px*var(--k));gap:calc(8px*var(--k))">${I('clock', 'sm')}Checked ${esc(ago(u.observedAt))}<span class="grow"></span><button class="linkb" data-u="refresh">Check now</button></div>`;
  }
  let usageBusy = false, usageErr = ''; /* a failed read shows its error with Try again, instead of asking again at each repaint */
  async function loadUsage(force) {
    if (usageBusy) return; usageBusy = true;
    try { LV.usage = force ? await api.post('/api/usage/refresh', {}) : await api.get('/api/usage'); usageErr = ''; } catch (e) { usageErr = errText(e); if (force && LV.usage) MC.toast('Could not check: ' + usageErr, 'warn'); }
    usageBusy = false; MC.emit('rerender', 'usage'); paintMinis(); MC.D && MC.D.drawSbar && MC.D.drawSbar();
  }
  const tokK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M' : Math.round(n / 1000) + 'k');
  /* what fills the context, like Claude Code's /context: the setup the first request carried (system prompt, tools, memory,
     skills), the messages since, and the free space */
  /* what fills the context: the last /context report saved in the conversation (system prompt, tools, MCP, memory files,
     skills), with the messages and the free space worked out again from the conversation as it is now */
  const CTXC = { 'System prompt': 'c-sys', 'System tools': 'c-tools', 'MCP tools': 'c-mcp', 'MCP server instructions': 'c-mcpi', 'Custom agents': 'c-agents', 'Memory files': 'c-mem', 'Skills': 'c-skill', 'Messages': 'c-msgs', 'Free space': 'c-free', 'Autocompact buffer': 'c-buf' };
  const ctxOpen = new Set();
  function ctxdHtml() {
    const sid = S.session, st = sid && LV.stats[sid];
    if (!sid || H.isNew(sid)) return '<div class="faint">Nothing yet.</div>';
    if (!st) { H.loadStats(sid); return loading('Reading the conversation'); }
    const win = st.contextWindow, used = st.contextUsed; if (!win || used == null) return '<div class="faint">Not known for this conversation.</div>';
    const rep = st.context, run = `<button class="btn sm ghost" data-u="ctxrun" title="Run /context in this conversation">${I('refresh', 'sm')}${rep ? esc(H.ago(rep.at) === 'now' ? 'Just now' : H.ago(rep.at) + ' ago') : 'Run /context'}</button>`;
    let parts;
    if (rep && rep.cats.length) {
      const live = rep.cats.filter((c) => !/deferred/i.test(c.name) && !/^(Messages|Free space|Autocompact buffer)$/.test(c.name) && c.tokens);
      const setup = live.reduce((a, c) => a + c.tokens, 0), buf = (rep.cats.find((c) => c.name === 'Autocompact buffer') || {}).tokens || 0;
      parts = live.map((c) => [c.name, c.tokens, CTXC[c.name] || 'c-other']).concat([['Messages', Math.max(0, used - setup), 'c-msgs']], buf ? [['Autocompact buffer', buf, 'c-buf']] : [], [['Free space', Math.max(0, win - used - buf), 'c-free']]);
      rep.cats.filter((c) => /deferred/i.test(c.name)).forEach((c) => parts.push([c.name, c.tokens, 'c-def']));
    } else {
      const setup = st.setup && st.setup < used ? st.setup : null;
      parts = [setup ? ['Setup', setup, 'c-setup'] : null, ['Messages', setup ? used - setup : used, 'c-msgs'], ['Free space', Math.max(0, win - used), 'c-free']].filter(Boolean);
    }
    const pct = (v) => (v / win * 100).toFixed(1) + '%';
    const rows = parts.map(([n, v, c]) => `<div class="cd2 ${c === 'c-def' ? 'def' : ''}"><span class="sw ${c}"></span><span class="grow">${esc(n)}</span><span class="mono">${(v / 1000).toFixed(1)}k</span><span class="mono faint">${c === 'c-def' ? '' : pct(v)}</span></div>`).join('');
    const lists = rep ? rep.lists.map((l) => {
      const key = l.title, on = ctxOpen.has(key), total = l.rows.reduce((a, r) => a + (r.tokens || 0), 0);
      let body = '';
      if (on) {
        const mcp = /mcp/i.test(l.title) && l.cols.length === 3, isPath = /path/i.test(l.cols[1] || '');
        const items = mcp
          ? Object.values(l.rows.reduce((m, r) => { const k = r.cells[1] || '?'; m[k] = m[k] || { name: k, n: 0, tokens: 0 }; m[k].n++; m[k].tokens += r.tokens || 0; return m; }, {})).map((x) => [x.name, x.n + (x.n === 1 ? ' tool' : ' tools'), x.tokens])
          : l.rows.map((r) => (isPath ? [r.cells[1] || r.cells[0], r.cells[0], r.tokens] : [r.cells[0], r.cells[1] || '', r.tokens]));
        body = `<div class="cxl">${items.sort((a, b) => (b[2] || 0) - (a[2] || 0)).map(([a, b, t]) => `<div class="cxr"><span class="ellip grow" title="${esc(a)}">${esc(a)}</span><span class="faint ellip">${esc(b)}</span><span class="mono">${t == null ? '' : (t / 1000).toFixed(1) + 'k'}</span></div>`).join('')}</div>`;
      }
      return `<div class="cxg"><button class="cxh" data-u="cx:${esc(key)}">${I('chev', 'sm')}<b class="grow">${esc(l.title)}</b><span class="faint">${l.rows.length}</span><span class="mono">${(total / 1000).toFixed(1)}k</span></button>${body}</div>`;
    }).join('') : '';
    return `<div class="ctxbar"><div class="row"><b>${tokK(used)} of ${tokK(win)}</b><span class="grow"></span>${run}</div><div class="cbars">${parts.filter((p) => p[2] !== 'c-def').map((p) => `<i class="${p[2]}" style="width:${p[1] / win * 100}%"></i>`).join('')}</div></div>
      <div class="ctxd2">${rows}</div>${lists ? `<div class="cxgs">${lists}</div>` : ''}`;
  }
  const EXP = { compact: ['Compact', 'sums up, cache still warm'], handoff: ['Handoff', 'for a new conversation'], none: ['Nothing', 'the cache runs out'] };
  function cacheHtml() {
    const sid = S.session; if (!sid) return '<div class="faint">No conversation open.</div>'; if (H.isNew(sid)) return '<div class="faint">A new conversation has no cache yet.</div>';
    const st = LV.stats[sid]; if (!st) { H.loadStats(sid); return loading('Reading the conversation'); }
    const left = MC.cacheLeft(), ttl = S.cacheTtl || 300, row = LV.rows[sid] || {};
    const used = st.contextUsed, win = st.contextWindow, pct = st.contextPct != null ? Math.round(st.contextPct) : null;
    const exp = row.expiryAction === null ? null : row.expiryChoice || row.expiryAction || 'compact';
    return `<div class="kc"><span class="cache-r">${ring(left / ttl, left < 60)}</span><div class="grow"><div><b>${left > 0 ? 'Cache warm' : 'Cache cold'}</b>, <span class="cache-t mono">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span> left</div></div></div>
      ${row.kind !== 'chat' && exp ? `<div class="kc"><span class="muted grow">At 5 min left</span><button class="pillsel" data-u="exp">${I('zap', 'sm')}${esc((EXP[exp] || [exp])[0])}${I('chev', 'sm')}</button></div>` : ''}
      <div class="meter"><div class="row"><b>Context</b><span>${used != null && win ? `${tokK(used)} of ${tokK(win)}` : pct == null ? '--' : pct + '%'}</span><button class="btn sm ghost" data-u="compact" style="margin-left:calc(8px*var(--k));height:calc(28px*var(--k))">Compact</button></div><div class="bar ${pct >= 80 ? 'warn' : ''}"><i style="width:${pct || 0}%"></i></div></div>`;
  }
  function lastHtml() {
    const st = LV.stats[S.session], u = st && st.lastUsage; if (!u) return '<div class="faint">No message yet.</div>';
    const parts = [['Read from the cache', u.cacheRead], ['Written to the cache', u.cacheWrite], ['New input', u.input], ['Output', u.output]], max = Math.max(1, ...parts.map((p) => p[1] || 0));
    return `<div class="ctxd">${parts.map(([n, v]) => `<div class="cd"><span class="ellip">${n}</span><span class="bar"><i style="width:${Math.max(.6, (v || 0) / max * 100)}%"></i></span><span class="mono">${((v || 0) / 1000).toFixed(1)}k</span><span></span></div>`).join('')}</div>`;
  }
  const money = (v) => (v == null ? '--' : v >= 100 ? '$' + Math.round(v) : '$' + v.toFixed(2));
  const bigNum = (v) => (v == null ? '--' : v >= 1e9 ? (v / 1e9).toFixed(1) + ' B' : v >= 1e6 ? (v / 1e6).toFixed(1) + ' M' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' k' : String(v));
  const hours = (ms) => (ms == null ? '--' : ms >= 3600e3 ? (ms / 3600e3).toFixed(1) + ' h' : Math.round(ms / 60000) + ' m');
  function costHtml(all) {
    const x = stats('30d'), s = x.v; if (!s) return x.err ? `<div class="lv-err">${esc(x.err)}</div>` : loading(s && s.index && !s.index.ready ? 'Reading every conversation once' : 'Adding up');
    const pid = realPid(), p = !all && pid ? (s.projects || []).find((q) => q.id === pid) : null;
    const T = all || !pid ? { cost: s.total.cost, tokens: s.total.tokens, req: s.total.req, active: s.total.activeMs, n: s.total.sessions } : { cost: p && p.cost, tokens: p && p.tokens, req: p && p.req, active: p && p.activeMs, n: p && p.sessions };
    /* cost per day over the 30 days, every project (the server keeps hours for the whole account only) */
    const day0 = new Date(); day0.setHours(0, 0, 0, 0); const days = new Array(30).fill(0);
    (s.hours || []).forEach((h) => { const t = h.h * 3600e3, i = 29 - Math.floor((day0.getTime() - new Date(t).setHours(0, 0, 0, 0)) / 86400000); if (i >= 0 && i < 30) Object.values(h.m || {}).forEach((v) => (days[i] += v[7] || 0)); });
    const max = Math.max(1, ...days);
    const dayOf = (i) => new Date(day0.getTime() - (29 - i) * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const bars = days.map((v, i) => `<span class="cb ${i === 29 ? 'now' : ''}" data-v="${v.toFixed(2)}" data-d="${esc(dayOf(i))}"><i style="height:${Math.max(v > 0 ? 1.5 : 0, v / max * 100)}%"></i></span>`).join('');
    const tiles = [['Cost at API prices', money(T.cost), all || !pid ? 'every project' : esc(S.project)], ['Tokens', bigNum(T.tokens), 'in and out'], ['Requests', bigNum(T.req), 'to the model'], ['Active time', hours(T.active), (T.n || 0) + ' conversations']];
    return `<div class="tiles">${tiles.map(([l, v, sub]) => `<div class="tile"><div class="tl">${l}</div><div class="tv">${v}</div><div class="ts">${sub}</div></div>`).join('')}</div>
      <div style="margin-top:calc(14px*var(--k))"><div class="faint" style="font-size:calc(13px*var(--k));margin-bottom:calc(4px*var(--k))">Cost per day, every project, last 30 days</div><div class="chart cchart"><div class="cbarsx">${bars}</div><div class="cax"><span>${esc(dayOf(0))}</span><span>Today</span></div><div class="tip"></div></div></div>
      ${s.total.saved ? `<div class="faint" style="font-size:calc(13px*var(--k));margin-top:calc(8px*var(--k))">The cache saved ${money(s.total.saved)} in these 30 days.</div>` : ''}`;
  }
  async function expMenu(b) {
    const sid = S.session, row = LV.rows[sid] || {}, cur = row.expiryChoice || row.expiryAction || 'compact';
    MC.menu(b, [{ h: 'At 5 min of cache left' }, ...Object.entries(EXP).map(([id, [l, sub]]) => ({ id, label: l, sub, icon: 'zap', on: cur === id }))], async (id) => {
      try { await api.post(`/api/sessions/${enc(sid)}/expiry-action`, { action: id }); if (LV.rows[sid]) LV.rows[sid].expiryChoice = id; MC.emit('rerender', 'usage'); paintMinis(); }
      catch (e) { MC.toast('Not changed: ' + errText(e), 'warn'); }
    });
  }
  async function uAct(b) {
    const k = b.dataset.u;
    if (k === 'refresh') { loadUsage(true); return true; }
    if (k === 'exp') { expMenu(b); return true; }
    if (k.indexOf('cx:') === 0) { const t = k.slice(3); if (ctxOpen.has(t)) ctxOpen.delete(t); else ctxOpen.add(t); MC.emit('rerender', 'usage'); return true; }
    if (k === 'ctxrun') { const sid = S.session; if (!sid || H.isNew(sid)) return true; if (H.busy(sid)) { MC.toast('Claude is working in this conversation. Try again when it is done.', 'info'); return true; } b.disabled = true; H.sendText(sid, '/context'); return true; }
    if (k === 'compact') { const sid = S.session; if (!sid || H.isNew(sid)) return true; if (await MC.askYes('Compact this conversation?', 'Claude sums it up so far. The context gets much smaller, and the cache stays warm.', 'Compact')) { H.sendText(sid, '/compact'); MC.emit('open', 'convo'); } return true; }
    return false;
  }
  M.usage = {
    label: 'Usage', icon: 'chart', scope: true,
    render: (vp) => {
      const o = vp.state.u || (vp.state.u = { plan: 1, cache: 1, ctxd: 0, last: 0, api: 1 });
      const all = vp.state.scope === 'all';
      const chip = (k, l) => `<button class="chip ${o[k] ? 'on' : ''}" data-u="${k}">${I(o[k] ? 'check' : 'plus', 'sm')}${l}</button>`;
      return `<div class="use"><div class="row" style="flex-wrap:wrap;gap:calc(8px*var(--k))">${chip('plan', 'Plan usage')}${chip('cache', 'Context and cache')}${chip('ctxd', 'What fills the context')}${chip('last', 'Last message')}${chip('api', 'Cost at API prices')}</div>
        ${o.plan ? `<section><div class="sect-h">Plan usage</div><div class="meters">${planHtml()}</div></section>` : ''}
        ${o.cache ? `<section><div class="sect-h">Context and cache<span class="grow"></span><span class="note ellip">${esc(S.session ? MC.sessionById(S.session).title : '')}</span></div><div class="meters">${cacheHtml()}</div></section>` : ''}
        ${o.ctxd ? `<section><div class="sect-h">What fills the context</div>${ctxdHtml()}</section>` : ''}
        ${o.last ? `<section><div class="sect-h">Last message<span class="grow"></span><span class="note">tokens</span></div>${lastHtml()}</section>` : ''}
        ${o.api ? `<section><div class="sect-h">Cost at API prices<span class="grow"></span><span class="note">last 30 days</span></div>${costHtml(all)}</section>` : ''}
        ${!o.plan && !o.cache && !o.ctxd && !o.last && !o.api ? '<div class="empty">Turn on a section above.</div>' : ''}</div>`;
    },
    mount: (el, vp) => {
      el.onclick = async (e) => { const b = e.target.closest('[data-u]'); if (!b) return; if (await uAct(b)) return; vp.state.u[b.dataset.u] = !vp.state.u[b.dataset.u]; vp.rerender(); };
      const ch = el.querySelector('.chart'); if (!ch) return; const tip = ch.querySelector('.tip');
      ch.onmousemove = (e) => { const r = e.target.closest('[data-v]'); if (!r) { tip.style.display = 'none'; return; } const b = ch.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = e.clientX - b.left + 'px'; tip.style.top = e.clientY - b.top + 'px'; tip.innerHTML = `${esc(r.dataset.d)}: <b>$${esc(r.dataset.v)}</b>`; };
      ch.onmouseleave = () => (tip.style.display = 'none');
    },
  };
  /* the small usage panel inside a conversation */
  MC.usageMini = () => `<div class="umini">${cacheHtml()}${planHtml()}</div>`;
  function paintMinis() { $$('.umini').forEach((u) => { u.outerHTML = MC.usageMini(); }); }
  document.addEventListener('click', (e) => { const b = e.target.closest('.umini [data-u]'); if (b) uAct(b); }, true);
  MC.events.on('session.stats', () => { paintMinis(); });
  MC.on('session', () => { paintMinis(); });
  MC.on('stats', () => { paintMinis(); MC.emit('rerender', 'usage'); });
  MC.events.on('expiry-action', (d) => { if (d && d.id && LV.rows[d.id]) { LV.rows[d.id].expiryChoice = d.action; paintMinis(); MC.emit('rerender', 'usage'); } });
  loadUsage();
})();
