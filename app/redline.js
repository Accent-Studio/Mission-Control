// Mission Control, Redline style. Shared behavior for every prototype screen.
window.MC = window.MC || {};
MC.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- icons ---------- */
MC.ic = {
  home:'<svg viewBox="0 0 18 18"><path d="M2 8 L9 2 L16 8 V16 H2 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  proj:'<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><ellipse cx="9" cy="9" rx="8" ry="3.2" fill="none" stroke="currentColor" stroke-width="1.2" transform="rotate(-20 9 9)"/></svg>',
  sys:'<svg viewBox="0 0 18 18"><rect x="4" y="4" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 1V4M11 1V4M7 14V17M11 14V17M1 7H4M1 11H4M14 7H17M14 11H17" stroke="currentColor" stroke-width="1.4"/></svg>',
  auto:'<svg viewBox="0 0 18 18"><path d="M10 1 L3 10 H9 L8 17 L15 8 H9 Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  conn:'<svg viewBox="0 0 18 18"><circle cx="4" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="4" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="14" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 8 L12 5 M6 10 L12 13" stroke="currentColor" stroke-width="1.4"/></svg>',
  chat:'<svg viewBox="0 0 18 18"><path d="M2 3 H16 V12 H8 L4 16 V12 H2 Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  usage:'<svg viewBox="0 0 18 18"><path d="M2 16H16M4 13V9M8 13V4M12 13V7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  set:'<svg viewBox="0 0 18 18"><circle cx="9" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 1.5V4M9 14V16.5M1.5 9H4M14 9H16.5M3.7 3.7L5.5 5.5M12.5 12.5L14.3 14.3M14.3 3.7L12.5 5.5M5.5 12.5L3.7 14.3" stroke="currentColor" stroke-width="1.5"/></svg>',
  ok:'<svg viewBox="0 0 10 10"><path d="M1.5 5.2L4 7.5L8.5 2.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>',
  bad:'<svg viewBox="0 0 10 10"><path d="M5 1L9.5 9H.5Z" fill="currentColor"/></svg>',
  warn:'<svg viewBox="0 0 10 10"><path d="M5 1L9.5 9H.5Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 4V6.2" stroke="currentColor" stroke-width="1.4"/></svg>',
  idle:'<svg viewBox="0 0 10 10"><path d="M2 5H8" stroke="currentColor" stroke-width="1.6"/></svg>',
  live:'<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" fill="currentColor"/></svg>',
  mic:'<svg viewBox="0 0 20 20"><rect x="7" y="2" width="6" height="10" rx="3" fill="#fff"/><path d="M4 9a6 6 0 0 0 12 0M10 15v3" stroke="#fff" stroke-width="1.8" fill="none"/></svg>',
  x:'<svg viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="#fff" stroke-width="1.6"/></svg>',
  plus:'<svg viewBox="0 0 10 10"><path d="M2 5H8M5 2V8" stroke="#fff" stroke-width="1.6"/></svg>',
  skill:'<svg viewBox="0 0 18 18"><path d="M3 3H15V15H3Z M6 9H12" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  arrow:'<svg viewBox="0 0 12 12"><path d="M8 2 L3 6 L8 10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
};
MC.chip = (k, t) => `<span class="chip c-${k}">${MC.ic[k] || ''}${t}</span>`;

/* ---------- rail ---------- */
MC.rail = function(page){
  const el = document.querySelector('nav.rail'); if(!el) return;
  const items = [['home','index.html','Home'],['proj','project.html','Projects'],['sys','system.html','System and servers'],['auto','automation.html','Skills and schedules'],['conn','connections.html','Connections'],['chat','chat.html','Talk to Claude'],['usage','usage.html','Usage and cost'],['set','settings.html','Settings']];
  el.innerHTML = `<a class="rail-home ${page==='home'?'on':''}" href="index.html" aria-label="Home" title="Home"${page==='home'?' aria-current="page"':''}><canvas class="rail-eye" data-eye="mini"></canvas></a>` +
    items.map(([k,h,t]) => `<div class="tab-wrap${k==='home'?' tw-home':''}"><a class="tab ${k===page?'on':''}" href="${h}" aria-label="${t}">${MC.ic[k]}</a><span class="tip">${t}</span></div>`).join('') +
    ``;
};

/* ---------- frames ---------- */
MC.drawFrames = function(){
  document.querySelectorAll('.fr').forEach(el => {
    let s = el.querySelector(':scope > svg.edge');
    if(!s){ s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.classList.add('edge'); el.prepend(s); }
    const w = el.clientWidth, h = el.clientHeight, c = parseFloat(getComputedStyle(el).getPropertyValue('--c')) || 16, o = .5;
    if(!w || !h) return;
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.innerHTML = `<path class="e" d="M${c} ${o} H${w-o} V${h-c} L${w-c} ${h-o} H${o} V${c} Z" fill="none" stroke-width="1"/><path d="M${c+10} 1.5 H${c+48}" stroke="#d6473c" stroke-width="2.5"/>`;
  });
};

/* ---------- canvas helper ---------- */
MC.fit = function(c){
  const D = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if(c.width !== Math.round(w*D) || c.height !== Math.round(h*D)){ c.width = Math.round(w*D); c.height = Math.round(h*D); }
  const x = c.getContext('2d'); x.setTransform(D,0,0,D,0,0); return [x,w,h];
};
MC.noise = t => (Math.sin(t*1.7)+Math.sin(t*2.9+1.3)*.6+Math.sin(t*5.3+.7)*.35+Math.sin(t*9.1+2.1)*.2)/2.15;

/* ---------- voice state (shared by every eye on the page) ---------- */
MC.STATES = {
  idle:['IDLE','Waiting for you',.25,.1,.05],
  listening:['LISTENING','Listening to you',3.2,.35,.5],
  thinking:['THINKING','Claude is thinking',.9,.3,.2],
  speaking:['SPEAKING','Claude is talking',2.4,.4,.55]
};
MC.voice = {state:'idle', level:.1, peak:0};
MC.setVoice = function(s){
  MC.voice.state = s;
  document.querySelectorAll('[data-voice-btn]').forEach(b => b.classList.toggle('on', b.dataset.voiceBtn === s));
  document.querySelectorAll('[data-voice-state]').forEach(e => e.textContent = MC.STATES[s][0]);
  document.querySelectorAll('[data-voice-sub]').forEach(e => e.textContent = MC.STATES[s][1]);
};

/* ---------- eye renderer ---------- */
MC.drawEye = function(ex, x, y, R, L, spin, mini){
  ex.lineWidth = 1; ex.strokeStyle = 'rgba(220,231,243,.35)';
  if(!mini){
    ex.beginPath(); ex.moveTo(x-R-6,y); ex.lineTo(x-R*.62,y); ex.moveTo(x+R*.62,y); ex.lineTo(x+R+6,y); ex.moveTo(x,y-R-6); ex.lineTo(x,y-R*.62); ex.moveTo(x,y+R*.62); ex.lineTo(x,y+R+6); ex.stroke();
    ex.beginPath(); ex.arc(x,y,R,0,7); ex.stroke();
    for(let i=0;i<72;i++){ const a=i/72*6.283, r2=R-(i%6?4:9); ex.beginPath(); ex.moveTo(x+Math.cos(a)*R,y+Math.sin(a)*R); ex.lineTo(x+Math.cos(a)*r2,y+Math.sin(a)*r2); ex.stroke(); }
    ex.save(); ex.translate(x,y); ex.rotate(spin); ex.setLineDash([22,10]); ex.strokeStyle='rgba(220,231,243,.55)'; ex.beginPath(); ex.arc(0,0,R*.86,.2,2.6); ex.stroke(); ex.setLineDash([]); ex.strokeStyle='#d6473c'; ex.lineWidth=3; ex.beginPath(); ex.arc(0,0,R*.86,3.4,3.9); ex.stroke(); ex.restore();
  }
  const N = mini ? 20 : 40, lit = Math.round(L*N), ro = mini ? R : R*.74, ri = mini ? R*.78 : R*.64;
  for(let i=0;i<N;i++){ const a0=-Math.PI/2+i/N*6.283+.02, a1=a0+6.283/N-(mini?.08:.05); ex.beginPath(); ex.arc(x,y,ro,a0,a1); ex.arc(x,y,ri,a1,a0,true); ex.closePath(); ex.fillStyle = i<lit ? (i>N*.8?'#e2e9f0':'#d6473c') : 'rgba(220,231,243,.08)'; ex.fill(); }
  const lr = mini ? R*.62 : R*.5;
  ex.beginPath(); ex.arc(x,y,lr+(mini?2:4),0,7); ex.fillStyle='#16161a'; ex.fill(); ex.strokeStyle='rgba(220,231,243,.5)'; ex.lineWidth=1; ex.stroke();
  const g = ex.createRadialGradient(x,y,0,x,y,lr); g.addColorStop(0,`rgba(255,${190+50*L|0},${120+80*L|0},1)`); g.addColorStop(.12+.18*L,'#ff3b2a'); g.addColorStop(.55,'#9d0f12'); g.addColorStop(1,'#1a0304');
  ex.beginPath(); ex.arc(x,y,lr,0,7); ex.fillStyle=g; ex.fill();
  ex.globalCompositeOperation='lighter'; const g2=ex.createRadialGradient(x,y,0,x,y,lr*(1.1+L*.8)); g2.addColorStop(0,`rgba(214,71,60,${.35+L*.4})`); g2.addColorStop(1,'rgba(214,71,60,0)'); ex.fillStyle=g2; ex.beginPath(); ex.arc(x,y,lr*2,0,7); ex.fill(); ex.globalCompositeOperation='source-over';
  ex.beginPath(); ex.ellipse(x-lr*.35,y-lr*.42,lr*.22,lr*.1,-.5,0,7); ex.fillStyle='rgba(220,231,243,.22)'; ex.fill();
};

/* one loop drives the level and every eye canvas on the page */
(function(){
  let t0 = performance.now(), spin = 0;
  function loop(now){
    const v = MC.voice, S = MC.STATES[v.state], t = (now-t0)/1000;
    let tg = S[3] + S[4]*(v.state==='thinking' ? Math.sin(t*S[2]*2)*.5+.5 : Math.max(0, MC.noise(t*S[2])*.5+.5));
    if(MC.reduce) tg = S[3] + S[4]*.4;
    if(v.liveAt && now - v.liveAt > 400) v.live = 0; /* BlitzVoice level events stopped: fall back to silence */
    if(v.state==='listening' && v.liveAt) tg = Math.min(1, .12 + .88*Math.sqrt(v.live || 0));
    v.level += (tg - v.level) * (v.state==='speaking'||v.state==='listening' ? .35 : .08);
    const L = Math.max(0, Math.min(1, v.level)); v.peak = Math.max(L, v.peak - .006);
    if(!MC.reduce) spin += .004 + (v.state==='thinking' ? .02 : 0);
    document.querySelectorAll('canvas[data-eye]').forEach(c => {
      const [ex,w,h] = MC.fit(c); ex.clearRect(0,0,w,h);
      if(w < 24 || h < 24) return; /* a hidden canvas has no size: a negative radius would throw and stop the loop for every eye */
      const mini = c.dataset.eye === 'mini';
      MC.drawEye(ex, w/2, h/2, Math.min(w,h)/2 - (mini?2:8), L, spin, mini);
    });
    document.querySelectorAll('[data-voice-meter]').forEach(m => {
      if(!m.children.length) for(let i=0;i<28;i++) m.appendChild(document.createElement('i'));
      const n = m.children.length, lm = Math.round(L*n), pk = Math.round(v.peak*n)-1;
      for(let i=0;i<n;i++) m.children[i].className = i===pk ? 'pk' : i<lm ? 'on' : '';
    });
    document.querySelectorAll('[data-voice-level]').forEach(e => e.textContent = (L*100).toFixed(1)+'%');
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();

/* ---------- 3D helpers ---------- */
// camera: yaw around Y, pitch around X, perspective distance D, zoom z
MC.cam = function(yaw, pitch, zoom, cx, cy, D){
  const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return function(x, y, z){
    const x1 = x*cy_ - z*sy, z1 = x*sy + z*cy_;
    const y2 = y*cp - z1*sp, z2 = y*sp + z1*cp;
    const f = D/(D + z2) * zoom;
    return [cx + x1*f, cy - y2*f, z2, f];
  };
};
// wireframe sphere in world space, lines fade on the far side
MC.wireSphere = function(ctx, P, ox, oy, oz, r, spin, col, opt){
  opt = opt || {};
  const lat = opt.lat || 6, lon = opt.lon || 8, seg = opt.seg || 22, c0 = P(ox,oy,oz);
  const line = pts => { for(let i=1;i<pts.length;i++){ const a=pts[i-1], b=pts[i], front=(a[2]+b[2])/2 < c0[2]; ctx.strokeStyle = front ? col : col.replace(/[\d.]+\)$/, m => (parseFloat(m)*.22).toFixed(2)+')'); ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke(); } };
  ctx.lineWidth = opt.lw || 1;
  for(let i=1;i<lat;i++){ const la = -Math.PI/2 + i*Math.PI/lat, pts=[]; for(let k=0;k<=seg;k++){ const lo=k/seg*6.283+spin; pts.push(P(ox+r*Math.cos(la)*Math.cos(lo), oy+r*Math.sin(la), oz+r*Math.cos(la)*Math.sin(lo))); } line(pts); }
  for(let j=0;j<lon;j++){ const lo = j/lon*Math.PI*2 + spin, pts=[]; for(let k=0;k<=seg;k++){ const la=-Math.PI/2+k/seg*Math.PI; pts.push(P(ox+r*Math.cos(la)*Math.cos(lo), oy+r*Math.sin(la), oz+r*Math.cos(la)*Math.sin(lo))); } line(pts); }
  return c0;
};

/* ---------- misc ---------- */
MC.barcode = function(){
  document.querySelectorAll('svg.barcode').forEach(bc => { let bx=0, s=''; while(bx<150){ const bw=1+Math.floor(Math.random()*3); s+=`<rect x="${bx}" y="0" width="${bw}" height="26" fill="#f2f2f0"/>`; bx+=bw+1+Math.floor(Math.random()*3); } bc.setAttribute('viewBox','0 0 150 26'); bc.innerHTML = s; });
};
MC.ruler = function(){
  const labels = ['FN_01','FN_03','FN_06','FN_08','FN_12','FN_15','FN_17','FN_18','FN_22','FN_24','FN_25','FN_29','FN_33','FN_42','FN_43','FN_44','FN_47','FN_51'];
  document.querySelectorAll('.ruler:empty').forEach(r => r.innerHTML = labels.map((l,i) => `<span class="${[2,6,11,15].includes(i)?'r':''}">${l}</span>`).join(''));
};
MC.clock = function(){
  const tick = () => { const d = new Date(); document.querySelectorAll('[data-clock]').forEach(e => e.textContent = d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})); };
  tick(); setInterval(tick, 1000);
};
/* ---------- shared helpers ---------- */
MC.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
MC._projects = null;
MC.projectList = function(){
  if(!MC._projects) MC._projects = MC.api.get('/api/projects').then(r => r.projects || []).catch(() => { MC._projects = null; return []; });
  return MC._projects;
};
MC.events.on('projects.changed', () => { MC._projects = null; });

/* The voice assistant's name, from the Settings page (voice prefs comlinkName). */
MC.comlinkName = () => (MC.voicePrefs && MC.voicePrefs.comlinkName) || 'Com Link';

/* ---------- Com Link: the voice assistant ----------
   The panel is the HAL eye, one status word and the mic button. Talking is the whole interface: the wake word or the mic starts
   a dictation with live words, "send it" sends it to the assistant (Haiku with the Com Link persona, medium effort, in this page's
   folder), "cancel that" drops it, "start over" drops the words and keeps listening, "end conversation" ends the conversation.
   The conversation shows in the mini panel to the right (MC.comlink.mini), where the answer streams in, is spoken, and where
   Claude's permission questions (from any run) and errors appear. The conversation lasts until "end conversation" or a page
   change: the panel hides itself after a while (or on Escape) but the next question reopens it and continues the same one. MC.comlink exists as soon as this file loads, so pages may call send() or prefill() before MC.init
   has built the panel. Run states: starting, working, idle (warm). */
MC.comlink = (function(){
  const cl = { run:null, runAt:0, runs:[], projectId:null, listeners:[] };
  const q = sel => document.querySelector(sel);
  /* one short word under the eye, the same on every page: Ready, Listening, Thinking, Talking (plus Failed and Voice off) */
  const states = { idle:'Ready', starting:'Thinking', working:'Thinking', done:'Ready', failed:'Failed', stopped:'Ready' };
  let status = 'idle', stopping = false, stopWanted = false;
  let noteTimer = 0, early = {}, held = [], lastErr = '', doneAt = 0;
  const reply = { say:null }; /* the full final text of this panel's turn, for reading aloud */
  const perms = [], pendChecked = {};
  /* the mini conversation: turns {text, answer[], err, state, speak}, the words being dictated (live, null when none), the Haiku session */
  const conv = { turns:[], live:null, sessionId:null, open:false, hold:false, track:false }; /* track: the current run is a voice turn, so its session is the conversation */ /* hold: a silent task (Commit, push review) keeps the panel open until the owner closes it, its last answer may be a question */
  let cur = null, closeT = 0, speakGen = 0;
  const live = r => !!r && (r.running === true || r.state === 'starting' || r.state === 'working' || r.state === 'running');
  const busy = () => status === 'starting' || status === 'working';

  /* which project this page talks about: project.html?id=X, or a panel marked data-project */
  function scope(){
    const el = q('[data-voice-panel]');
    const isProj = !!((el && el.dataset.project) || /project\.html$/.test(location.pathname));
    const pid = new URLSearchParams(location.search).get('id') || (el && el.dataset.project) || null;
    return { isProj, pid: isProj ? pid : null };
  }

  /* the eye thinks while this panel's run is going or any run on the server is */
  function syncVoice(){
    if(MC.voice.link && MC.voice.link !== 'idle') return; /* BlitzVoice owns the eye while it listens, transcribes or speaks */
    const think = busy() || cl.runs.some(live);
    if(think && MC.voice.state === 'idle') MC.setVoice('thinking');
    else if(!think && MC.voice.state === 'thinking') MC.setVoice('idle');
  }
  function paint(){
    syncVoice();
    const say = q('[data-cl-status]');
    if(say){
      /* BlitzVoice's own step first (Listening, Thinking, Talking), then Claude at work, then Voice off, then Ready */
      const vt = cl.voiceText && cl.voiceText();
      const think = busy() || cl.runs.some(live);
      say.textContent = vt && vt !== 'Voice off' ? vt : think ? 'Thinking' : status === 'failed' ? states.failed : vt || states.idle;
      const stop = q('[data-cl-stop]'); if(stop){ stop.hidden = !busy(); stop.disabled = stopping; stop.textContent = stopping ? 'Stopping…' : 'Stop'; }
    }
    paintPerm();
  }

  /* ---- the mini conversation panel ---- */
  const clipN = (t, n) => { t = String(t == null ? '' : t).replace(/\s+/g,' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const plain = t => String(t == null ? '' : t).replace(/```\w*\n?/g, '').replace(/\*\*|__|`/g, '').replace(/^#{1,6}\s+/gm, '').trim();
  function miniEl(){
    let el = q('[data-mini]'); if(el) return el;
    if(!q('[data-voice-panel]')) return null;
    el = document.createElement('aside'); el.className = 'cl-mini fr'; el.setAttribute('data-mini', ''); el.setAttribute('aria-label', 'Conversation with ' + MC.comlinkName()); el.hidden = true;
    el.innerHTML = '<div class="ttl"><h3 data-mini-title>' + MC.esc(MC.comlinkName()) + '</h3><span class="right"><button type="button" class="mclose" data-mini-close aria-label="Close" title="Close (Esc)">' + MC.ic.x + '</button></span></div>' +
      '<div class="mbody" data-mini-body></div>' +
      '<div class="vperm" data-cl-perm role="group" aria-label="Permission question" hidden></div>';
    document.body.appendChild(el);
    el.querySelector('[data-mini-close]').onclick = () => closeMini(true);
    el.querySelector('[data-cl-perm]').addEventListener('click', e => { const b = e.target.closest('[data-cl-pa]'); if(b) answerPerm(b.dataset.clPa); });
    if(window.ResizeObserver) new ResizeObserver(() => MC.drawFrames()).observe(el);
    addEventListener('resize', placeMini);
    const host = q('[data-voice-panel]');
    if(window.ResizeObserver && host) new ResizeObserver(placeMini).observe(host);
    return el;
  }
  /* to the right of the Com Link panel, level with its top (a CSS rule docks it to the bottom on narrow windows) */
  function placeMini(){
    const el = q('[data-mini]'), host = q('[data-voice-panel]'); if(!el || !host || el.hidden) return;
    const r = host.getBoundingClientRect();
    el.style.setProperty('--mx', Math.round(r.right + 12) + 'px'); el.style.setProperty('--my', Math.round(Math.max(8, r.top)) + 'px');
  }
  function renderMini(){
    const el = q('[data-mini]'); if(!el || el.hidden) return;
    const body = el.querySelector('[data-mini-body]');
    let h = conv.turns.map(t =>
      '<div class="mt"><div class="mu"><b>You</b><span title="' + MC.esc(clipN(t.text, 600)) + '">' + MC.esc(clipN(t.text, 400)) + '</span></div>' +
      (t.answer.length ? '<div class="ma"><b>' + MC.esc(t.who) + '</b><div>' + t.answer.map(a => '<p>' + MC.esc(plain(a)) + '</p>').join('') + '</div></div>'
        : t.state === 'working' ? '<div class="ma"><b>' + MC.esc(t.who) + '</b><div><p class="mwait">…</p></div></div>' : '') +
      (t.err ? '<div class="me" role="alert">' + MC.esc(t.err) + '</div>' : '') + '</div>').join('');
    if(conv.live !== null) h += '<div class="mt mlive"><div class="mu"><b>You</b><span data-mini-live>' + MC.esc(conv.live) + '</span></div></div>';
    el.querySelector('[data-mini-title]').textContent = h ? MC.comlinkName() : 'Question';
    if(body.dataset.h !== h){
      const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      body.dataset.h = h; body.innerHTML = h;
      if(stick) body.scrollTop = body.scrollHeight;
    }
    placeMini();
  }
  function openMini(){
    const el = miniEl(); if(!el) return;
    conv.open = true;
    if(el.hidden){ el.hidden = false; placeMini(); }
    renderMini(); MC.drawFrames();
  }
  /* "End conversation" archives the assistant's conversation: it leaves the Talk page list (Show archived brings it back) and goes
     offline on claude.ai. Leaving the page or hiding the panel never gets here. A conversation whose id the panel does not
     know yet (ended during its first reply) is found through its run. A failure is only a console note: the owner already
     ended it, and the conversation stays in the list. */
  async function archiveNow(sid){
    try { await MC.api.post('/api/sessions/' + encodeURIComponent(sid) + '/archive', { archived:true }); }
    catch(e){ console.warn('Could not archive the ended conversation:', e && e.message); }
  }
  /* Still no session id: the run is remembered (archiveWait) and the conversation is archived the moment that run reports its
     session id. A run that ends without one (it failed before starting) archives nothing. Only one run is ever waited for. */
  let archiveWait = null, sendSeq = 0;
  function archiveEnded(sid, runId){
    archiveWait = null;
    if(sid) return archiveNow(sid);
    archiveWait = { runId: runId || null, seq: sendSeq };
  }
  function archiveWatch(d){
    const w = archiveWait; if(!w || !w.runId || d.runId !== w.runId) return;
    const sid = d.sessionId || (d.event && typeof d.event.session_id === 'string' && d.event.session_id) || '';
    if(sid){ archiveWait = null; archiveNow(sid); }
    else if(d.done || (d.turnDone && d.ok === false)) archiveWait = null;
  }
  /* Hides the panel. manual: the owner closed it (Escape, the mark): speech stops and the reply is no longer read. Otherwise it
     timed out. The conversation stays (turns and session): the next question reopens the panel and continues it.
     end: "end conversation": everything is forgotten and the next question starts a new conversation. */
  function closeMini(manual, end){
    if(manual && !end && perms.some(p => p.state === 'pending')){ flashPerm(); return; } /* a pending question stays until it is answered */
    clearTimeout(closeT); speakGen++;
    const wasLive = conv.live !== null;
    if(manual){ if(cur) cur.speak = false; reply.say = null; if(MC.voice.link === 'speaking') MC.voice.stopSpeak(); else if(MC.voice.phoneStopSpeech) MC.voice.phoneStopSpeech(); }
    conv.open = false; conv.live = null; conv.hold = false;
    if(end){
      if(conv.track) archiveEnded(conv.sessionId, cl.run); /* only the assistant's own voice conversation: a Commit or push task is never a voice turn */
      conv.turns = []; conv.sessionId = null; conv.track = false; cur = null;
    }
    const el = q('[data-mini]'); if(el){ el.hidden = true; const b = el.querySelector('[data-mini-body]'); b.dataset.h = ''; b.innerHTML = ''; }
    if(wasLive && cl.mini.onLiveClosed) cl.mini.onLiveClosed();
    if(!busy() && status !== 'idle') status = 'idle';
    paint();
  }
  const canClose = () => !busy() && conv.live === null && !perms.some(p => p.state === 'pending');
  /* force: a failed or stopped turn always closes in time, even a silent one that would otherwise wait for the owner */
  function armClose(force){
    clearTimeout(closeT);
    if(!conv.open || (conv.hold && !force)) return;
    const sec = MC.voicePrefs ? MC.voicePrefs.hidePanelSec : 30; /* Settings: hide the panel this long after the answer, 0 never */
    if(!sec) return;
    closeT = setTimeout(() => { if(conv.open && canClose()) closeMini(false); }, sec * 1000);
  }
  function beginTurn(text, opt){
    if(opt.quiet){ cur = null; return; } /* real work started from a page: only the status word and permission questions show here */
    clearTimeout(closeT); speakGen++;
    cur = { text: opt.label || text, answer:[], err:'', state:'working', speak: !opt.silent, voice: !!opt.voice, who: opt.voice ? MC.comlinkName() : 'Haiku' };
    conv.hold = !!opt.silent;
    conv.turns.push(cur); if(conv.turns.length > 12) conv.turns.shift();
    conv.live = null; openMini();
  }
  /* the end of a good turn: read the answer aloud (always, whatever the Talk page switch says), then the close timer starts */
  function finishTurn(runId){
    if(cur) cur.state = 'done';
    const t = cur; renderMini();
    /* on a phone only a voice question is answered aloud (a typed or silent task from a page stays quiet) */
    if(t && t.speak && (!MC.voice.remote() || t.voice)){
      const gen = ++speakGen;
      Promise.resolve(MC.voice.finishReply(reply, runId, true)).then(r => {
        if(gen !== speakGen) return;
        if(!r || r.skipped || r.duplicate) return armClose();
        untilSpoken(gen).then(ok => { if(ok && gen === speakGen){ armClose(); listenAgain(t); } });
      });
    } else { reply.say = null; if(!t){ status = 'idle'; paint(); } armClose(); }
  }
  /* Settings "Listen again after an answer": a spoken answer to a voice question opens the mic for the follow-up */
  function listenAgain(t){
    const P = MC.voicePrefs;
    if(MC.voice.remote()) return; /* a phone has no silence detection yet: Talk is pressed for every question */
    if(!t || !t.voice || !P || !P.autoListen || !conv.open || perms.some(p => p.state === 'pending')) return;
    if(MC.assistant && MC.assistant.start && MC.assistant.phase !== 'listening') MC.assistant.start({ followUp:true });
  }
  /* resolves true when BlitzVoice has finished speaking (or never started), false when a newer turn took over */
  function untilSpoken(gen){
    return new Promise(done => {
      const t0 = Date.now(); let saw = MC.voice.link === 'speaking';
      (function look(){
        if(gen !== speakGen) return done(false);
        const sp = MC.voice.link === 'speaking'; if(sp) saw = true;
        if((saw && !sp) || (!saw && Date.now() - t0 > 4000) || Date.now() - t0 > 300000) return done(true);
        setTimeout(look, 150);
      })();
    });
  }

  /* the question Claude asks before it runs a tool: Allow or Deny, answered in one click */
  function paintPerm(){
    const box = q('[data-cl-perm]'); if(!box) return;
    const pend = perms.filter(x => x.state === 'pending'), fin = perms.filter(x => x.state !== 'pending' && x.until > Date.now());
    let h = '';
    if(pend.length && pend[0].ask){
      /* Claude's multiple choice questions are answered on the Talk page, where the options fit */
      const x = pend[0], run = cl.runs.find(r => r.runId === x.runId), sid = run && run.sessionId;
      h = '<div class="vpq">Claude asks: <b>' + MC.esc(x.summary.slice(0, 200)) + '</b></div>' +
        '<div class="vpb"><a class="act red" href="chat.html' + (sid ? '?session=' + encodeURIComponent(sid) : '') + '">Answer on the Talk page</a>' + (pend.length > 1 ? '<small>' + (pend.length - 1) + ' more waiting</small>' : '') + '</div>';
    } else if(pend.length){
      const x = pend[0];
      h = '<div class="vpq">Claude wants to run: <b>' + MC.esc(x.tool) + '</b>' + (x.summary ? '<code title="' + MC.esc(x.summary) + '">' + MC.esc(x.summary.slice(0, 200)) + '</code>' : '') + '</div>' +
        '<div class="vpb"><button type="button" class="act red" data-cl-pa="allow"' + (x.busy ? ' disabled' : '') + '>Allow</button><button type="button" class="act" data-cl-pa="deny"' + (x.busy ? ' disabled' : '') + '>Deny</button>' +
        (x.busy ? '<small>Sending…</small>' : pend.length > 1 ? '<small>' + (pend.length - 1) + ' more waiting</small>' : '') + '</div>' +
        (x.err ? '<div class="vpe">' + MC.esc(x.err) + '</div>' : '') +
        (x.flash ? '<div class="vpe" role="alert">Answer the permission first</div>' : '');
    } else if(fin.length){
      const x = fin[fin.length - 1];
      h = '<div class="vpq">' + MC.esc(x.tool) + ' <span class="vpw ' + (x.state === 'allowed' ? 'ok' : x.state === 'denied' ? 'no' : 'cl') + '">' + (x.state === 'allowed' ? 'Allowed' : x.state === 'denied' ? 'Denied' : 'Closed') + '</span></div>';
    }
    if(box.dataset.h !== h){
      const f = document.activeElement, had = f && f.dataset && f.dataset.clPa;
      box.dataset.h = h; box.innerHTML = h; box.hidden = !h;
      if(had){ const b = box.querySelector('[data-cl-pa="' + had + '"]'); if(b && !b.disabled) b.focus(); }
      placeMini();
    }
    if(fin.length && !pend.length){ clearTimeout(paintPerm.t); paintPerm.t = setTimeout(paintPerm, Math.max(300, Math.max.apply(null, fin.map(x => x.until)) - Date.now() + 50)); }
  }
  /* the owner tried to close the panel while a question waits */
  function flashPerm(){
    const x = perms.find(y => y.state === 'pending'); if(!x) return;
    x.flash = true; paintPerm(); note('Answer the permission first');
    clearTimeout(flashPerm.t); flashPerm.t = setTimeout(() => { x.flash = false; paintPerm(); }, 3000);
  }
  function addPerm(runId, p){
    if(perms.some(x => x.requestId === String(p.requestId))) return;
    perms.push({ runId, requestId:String(p.requestId), tool:String(p.tool || 'a tool').slice(0, 60), summary:String(p.summary || '').replace(/\s+/g,' ').trim(), state:'pending', busy:false, ask:Array.isArray(p.questions) && p.questions.length > 0 });
    clearTimeout(closeT); openMini(); /* a question must be seen: the panel opens even if it was closed */
    paintPerm();
  }
  function resolvePerm(requestId, behavior){
    const x = perms.find(y => y.requestId === String(requestId)); if(!x || x.state !== 'pending') return;
    x.state = behavior === 'allow' ? 'allowed' : behavior === 'deny' ? 'denied' : 'closed'; x.busy = false; x.until = Date.now() + 4000; paintPerm();
    if(canClose() && conv.open) armClose();
  }
  async function answerPerm(behavior){
    const x = perms.find(y => y.state === 'pending'); if(!x || x.busy) return;
    x.busy = true; x.err = ''; paintPerm();
    try { await MC.api.post('/api/runs/' + encodeURIComponent(x.runId) + '/permission', { requestId:x.requestId, behavior }); resolvePerm(x.requestId, behavior); }
    catch(e){
      x.busy = false;
      if(e.status === 404 || e.status === 409){ x.state = 'closed'; x.until = Date.now() + 3000; }
      else x.err = 'Could not send your answer. ' + friendly(e);
      paintPerm();
    }
  }
  /* a question that was asked before this page opened */
  function loadPending(runId){
    if(!runId || pendChecked[runId]) return; pendChecked[runId] = 1;
    MC.api.get('/api/runs/' + encodeURIComponent(runId) + '/pending').then(d => {
      const list = Array.isArray(d) ? d : (d && (d.pending || d.permissions || d.items)) || [];
      (Array.isArray(list) ? list : []).forEach(p => { p = p && p.permission ? p.permission : p; if(p && p.requestId) addPerm(runId, p); });
    }).catch(() => {});
  }
  /* errText: why it failed, shown in the mini panel under the turn it belongs to (a quiet run has no turn: a note says it) */
  function setStatus(s, errText){
    status = s;
    if(s === 'failed' && cur){ cur.state = 'failed'; if(errText) cur.err = errText; renderMini(); }
    else if(s === 'failed' && errText) note(errText);
    paint();
  }
  /* a short message under the status word, then it goes away (after ms, 5 seconds unless given) */
  function note(text, ms){
    const c = q('[data-cl-ctx]'); if(!c) return;
    c.textContent = text; c.hidden = !text; clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { c.textContent = ''; c.hidden = true; }, ms || 5000);
  }

  function textOf(ev){
    if(!ev || ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return '';
    return ev.message.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
  }
  function clip(t){ t = String(t == null ? '' : t).replace(/\s+/g,' ').trim(); return t.length > 180 ? t.slice(0,177) + '…' : t; }
  function friendly(e){
    const s = e && e.status, m = (e && e.message) || '';
    if(s === 429) return 'Too many runs at once. Wait for one to finish.';
    if(s === 404) return /session/i.test(m) ? 'That session was not found.' : /project/i.test(m) ? 'That project was not found.' : 'Not found.';
    if(s === 409) return 'That session cannot be resumed here.';
    if(s === 400) return m ? clip(m) : 'The server did not accept that message.';
    if(s >= 500) return 'Server error, try again.' ;
    return 'Server offline, nothing was sent.';
  }

  function onChat(d){
    if(!d || !d.runId) return;
    archiveWatch(d);
    if(d.permission && d.permission.requestId){ addPerm(d.runId, d.permission); return; }
    if(d.permissionDone != null){ resolvePerm(d.permissionDone, d.behavior); return; }
    if(d.done){ perms.forEach(x => { if(x.runId === d.runId && x.state === 'pending'){ x.state = 'closed'; x.until = Date.now() + 2000; } }); paintPerm(); }
    if(d.sent) return;
    if(d.done || d.turnDone || !cl.runs.some(r => r.runId === d.runId)) pollRuns(!!(d.done || d.turnDone));
    if(cl.run && d.runId === cl.run) handle(d);
    else if(!cl.run && status === 'starting'){ const l = early[d.runId] = early[d.runId] || []; if(l.length < 40) l.push(d); }
  }
  function handle(d){
    if(d.turnDone){
      /* the turn is over; the process stays warm on the server. Every message here starts a new chat, so this one is finished. */
      if(!busy()) return;
      stopping = false; stopWanted = false; doneAt = Date.now();
      if(d.sessionId && conv.track) conv.sessionId = d.sessionId;
      if(d.ok === false){ reply.say = null; if(conv.track) conv.sessionId = null; setStatus('failed', lastErr || 'Claude reported an error.'); armClose(true); } else { setStatus('done'); finishTurn(d.runId); }
      paint();
      return;
    }
    if(d.done){
      if(!busy()){ pollRuns(true); return; } /* the process closing after a finished turn changes nothing */
      const st = d.state === 'stopped' ? 'stopped' : (d.state === 'done' || d.code === 0) ? 'done' : 'failed';
      stopping = false; stopWanted = false;
      if(st === 'stopped' && cur){ cur.state = 'stopped'; cur.err = 'Stopped.'; renderMini(); }
      setStatus(st); paint();
      if(st === 'failed' && conv.track) conv.sessionId = null; /* stopped keeps the conversation: the next question resumes it */
      if(st !== 'done') armClose(true);
      if(st === 'failed') pollRuns(true).then(() => {
        const r = cl.runs.find(x => x.runId === d.runId);
        if(r && r.error && status === 'failed' && cl.run === d.runId){ setStatus('failed', clip(r.error.split(/\r?\n/).filter(Boolean).pop())); armClose(true); }
      });
      return;
    }
    const ev = d.event;
    if(ev && ev.type === 'result' && ev.is_error) lastErr = clip(ev.result || 'Claude reported an error.');
    if(ev && typeof ev.session_id === 'string' && conv.track) conv.sessionId = ev.session_id;
    const t = textOf(ev);
    MC.voice.noteReply(reply, ev);
    if(t && cur){ cur.answer.push(t); renderMini(); }
    if(t) setStatus('working'); else if(status === 'starting') setStatus('working');
  }
  /* if an event was missed (the stream dropped), the run list says where the run stands */
  function reconcile(){
    if(!cl.run) return;
    const r = cl.runs.find(x => x.runId === cl.run);
    if(!busy()){
      /* a message joined right at the end of a turn keeps Claude working: do not say Done too early */
      if(status === 'done' && r && r.state === 'working' && Date.now() - doneAt < 10000) setStatus('working');
      return;
    }
    if(r && (r.state === 'starting' || r.state === 'working' || r.state === 'running')) return;
    if(r && r.state === 'idle') handle({ runId:r.runId, turnDone:true, ok:true });
    else if(r) handle({ runId:r.runId, done:true, state:r.state, code:r.state === 'done' ? 0 : -1 });
    else if(Date.now() - cl.runAt > 5000){ stopping = false; setStatus('failed', 'Lost track of this run. The server may have restarted.'); }
  }

  /* the run list: fetched at most about once a second, never two at once */
  let inflight = null, queued = false, lastPoll = 0;
  function pollRuns(now){
    if(inflight){ queued = true; return inflight; }
    const wait = now ? 0 : Math.max(0, 800 - (Date.now() - lastPoll));
    inflight = new Promise(r => setTimeout(r, wait)).then(async () => {
      lastPoll = Date.now();
      try {
        const runs = await MC.api.get('/api/runs');
        if(Array.isArray(runs)){ cl.runs = runs; running(); reconcile(); paint(); runs.filter(r => r.state === 'working').slice(0, 3).forEach(r => loadPending(r.runId)); runs.forEach(r => { if(r.state !== 'working') delete pendChecked[r.runId]; }); }
      } catch(e){ /* offline: keep what we had, the title bar chip says why */ }
      inflight = null;
      if(queued){ queued = false; return pollRuns(); }
    });
    return inflight;
  }
  function running(){ const n = cl.runs.filter(live).length; cl.listeners.forEach(f => { try { f(n); } catch(e){} }); }
  /* nothing sits under the Talk button: plan use lives on the Talk page */

  /* while Claude works, a new message joins the reply at once (Claude sees it at its next step) */
  async function join(text){
    if(!cl.run){ held.push(text); return true; } /* the run id is not known yet: it goes out right after */
    try { await MC.api.post('/api/chat', { prompt:text, runId:cl.run }); return true; }
    catch(e){
      if(e.status === 404 || e.status === 409){ note('That chat just ended. Say it again to start a new one.'); pollRuns(true); }
      else note('Could not send it. ' + friendly(e));
      if(cur){ cur.state = 'failed'; cur.err = e.status === 404 || e.status === 409 ? 'That chat just ended. Say it again to start a new one.' : 'Could not send it. ' + friendly(e); renderMini(); }
      return false;
    }
  }
  /* the Haiku model id as the server names it (from the CLI's model list), fetched once */
  let haikuP = null;
  function haiku(){
    if(!haikuP) haikuP = MC.api.get('/api/chat/options')
      .then(o => { const h = ((o && o.models) || []).find(m => /haiku/i.test(m.id) && !m.disabled); return h ? h.id : null; })
      .catch(() => { haikuP = null; return null; });
    return haikuP;
  }
  let convOneOff = false; /* the voice conversation on screen began as a one-off task (a skill chip), so it stays off claude.ai */
  /* opt: projectId, sessionId (to continue one on purpose), model, mode, effort;
     silent (shown but not read aloud), quiet (real work: no mini conversation, only the status word and permission questions);
     remote:false (a one-off task: the conversation is not shown on claude.ai, Remote Control stays off) */
  async function send(text, opt){
    opt = opt || {}; text = (text || '').trim(); if(!text) return null;
    if(busy()){ beginTurn(text, opt); return (await join(text)) ? cl.run : null; }
    const projectId = opt.projectId !== undefined ? opt.projectId : (cl.projectId !== null ? cl.projectId : scope().pid);
    const sessionId = opt.sessionId || null;
    cl.run = null; early = {}; stopWanted = false; stopping = false; held = []; lastErr = ''; reply.say = null;
    conv.track = !!opt.voice; const seq = ++sendSeq;
    beginTurn(text, opt);
    /* a warm process that already holds the session answers at once; only a new process says Starting */
    const warm = !!(sessionId && cl.runs.some(r => r.sessionId === sessionId && (live(r) || r.state === 'idle')));
    setStatus(warm ? 'working' : 'starting');
    try {
      /* the small panel is for quick questions: a new conversation in this page's folder, on Haiku with medium effort,
         so it never touches (or switches the model of) a real work session. A follow-up resumes the conversation on screen. */
      const body = { prompt: text, source: 'comlink' }; /* the server never holds a Com Link or one-off task send for "open in Claude Desktop" */
      if(projectId) body.projectId = projectId;
      if(sessionId) body.sessionId = sessionId;
      const VP = MC.voicePrefs || {};
      body.model = opt.model || (opt.voice && VP.comlinkModel) || await haiku();
      body.effort = opt.effort || (opt.voice && VP.comlinkEffort) || 'medium';
      if(opt.mode) body.mode = opt.mode;
      else if(opt.voice) body.mode = VP.comlinkMode || 'auto'; /* the assistant works hands free: Auto mode (Settings) instead of a permission question for every command */
      if(opt.voice && VP.comlinkPersona !== false) body.persona = 'comlink'; /* the assistant's persona prompt and memory, on every run of the conversation */
      if(!body.model) delete body.model;
      /* Remote Control (the conversation shows on claude.ai) is for conversations you hold. A caller that starts a one-off task
         (Commit, Review and push, a skill chip) says remote:false; a follow-up in a voice conversation that began that way stays off. */
      let remote = opt.remote;
      if(opt.voice){ if(remote === undefined && sessionId && convOneOff) remote = false; convOneOff = remote === false; }
      if(remote === false) body.remote = false;
      const r = await MC.api.post('/api/chat', body);
      if(!r || !r.runId) throw new Error('The server did not return a run');
      cl.run = r.runId; cl.runAt = Date.now();
      if(archiveWait && !archiveWait.runId && archiveWait.seq === seq){ archiveWait.runId = r.runId; (early[r.runId] || []).forEach(archiveWatch); }
      if(r.joined && status === 'starting') setStatus('working');
      const l = early[r.runId] || []; early = {};
      l.forEach(handle);
      if(held.length){ const hs = held; held = []; hs.forEach(t => MC.api.post('/api/chat', { prompt:t, runId:r.runId }).catch(e => note('Could not send it. ' + friendly(e)))); }
      pollRuns(true);
      if(stopWanted && busy()){ stopWanted = false; stopping = false; stop(); }
      return r.runId;
    } catch(e){
      cl.run = null; stopping = false; stopWanted = false; held = [];
      if(archiveWait && archiveWait.seq === seq && !archiveWait.runId) archiveWait = null;
      if(conv.track && !sessionId) conv.sessionId = null;
      setStatus('failed', friendly(e)); armClose(true);
      return null;
    }
  }
  async function stop(){
    if(!busy() || stopping) return;
    stopping = true; paint();
    if(!cl.run){ stopWanted = true; return; } /* still starting: stop as soon as the server has a run id */
    try { await MC.api.post('/api/runs/' + encodeURIComponent(cl.run) + '/stop', {}); pollRuns(true); }
    catch(e){
      stopping = false; paint();
      if(e.status === 404 || e.status === 409) pollRuns(true); /* it already ended */
      else note('Could not stop it. ' + friendly(e));
    }
  }
  /* a skill chip: the assistant starts listening and the skill name leads whatever you say */
  /* opt.oneOff: the chip starts a one-off task, so what is said goes out with remote:false (not on claude.ai) */
  function prefill(text, opt){
    if(MC.assistant && MC.assistant.start) MC.assistant.start({ prefix:text || '', oneOff:!!(opt && opt.oneOff) });
    else note('Voice is not available.');
  }

  cl.send = send; cl.stop = stop; cl.prefill = prefill; cl.isBusy = busy; cl.onRunning = f => cl.listeners.push(f);
  cl.refreshRuns = pollRuns;
  cl.paint = paint; cl.note = note; cl.syncVoice = syncVoice; cl.voiceText = null; /* hooks for the BlitzVoice block below */
  cl.mini = {
    isOpen: () => conv.open,
    sessionId: () => conv.sessionId, /* the conversation a follow-up resumes, kept while the panel is hidden */
    beginLive(prefix){ clearTimeout(closeT); speakGen++; conv.live = prefix || ''; if(conv.open) renderMini(); else openMini(); },
    setLive(text){
      conv.live = String(text == null ? '' : text);
      const e = q('[data-mini-live]');
      if(e){ e.textContent = conv.live; const b = q('[data-mini-body]'); if(b) b.scrollTop = b.scrollHeight; }
      else renderMini();
    },
    endLive(){ conv.live = null; renderMini(); },
    close: () => closeMini(true),
    end: () => closeMini(true, true),
    later: () => { if(conv.open && canClose()) armClose(); }, /* the panel hides after a while unless something keeps it */
    hasTurns: () => conv.turns.length > 0,
    onLiveClosed: null /* the assistant drops its dictation when the panel is closed while listening */
  };
  cl.build = function(){
    document.querySelectorAll('[data-voice-panel]').forEach(el => {
      el.classList.add('voice','fr');
      const sc = scope(); cl.projectId = sc.pid;
      el.innerHTML = `<div class="ttl"><h3>Com Link</h3><span class="right"><span class="info">?<span class="pop" data-cl-help></span></span></span></div>
        <div class="vbody"><canvas data-eye="big" aria-hidden="true"></canvas>
        <div class="vstat"><div class="vsay" data-cl-status role="status">${states.idle}</div><button type="button" class="vstop" data-cl-stop hidden>Stop</button></div>
        <div class="vctx" data-cl-ctx role="status" hidden></div>
        <div class="vmrow"><button type="button" class="vmic" data-cl-mic aria-label="Talk" title="BlitzVoice is not running" aria-disabled="true" style="opacity:.4;cursor:default">${MC.ic.mic}<span class="ml">Talk</span></button><button type="button" class="vcancel" data-cl-cancel hidden>Cancel</button></div>
        </div>`;
      MC.voice._bind();
      el.querySelector('[data-cl-stop]').onclick = stop;
    });
    miniEl(); addStyle(); paint(); pollRuns(true);
    if(MC.assistant && MC.assistant.help) MC.assistant.help();
  };
  /* the styles only the Com Link panel and its mini panel need (kept here so the shared stylesheet stays as it is) */
  function addStyle(){
    if(document.getElementById('cl-extra')) return;
    const st = document.createElement('style'); st.id = 'cl-extra';
    st.textContent = '.voice .vmic{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:12px;padding:0 14px;height:38px;background:var(--red);border:0;color:#fff;font:600 13px var(--sans);letter-spacing:.03em;cursor:pointer;clip-path:polygon(0 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%)}' +
      '.voice .vmic svg{width:16px;height:16px;flex:none}.voice .vmic:focus-visible{outline:1px solid var(--white);outline-offset:2px}' +
      '.voice .vmrow{display:flex;gap:8px;margin-top:12px}.voice .vmrow .vmic{margin-top:0;width:auto;flex:1 1 0;min-width:0}' +
      '.voice .vcancel{flex:none;height:38px;padding:0 16px;background:none;border:1px solid var(--line-2);color:var(--white);font:600 13px var(--sans);letter-spacing:.03em;cursor:pointer}.voice .vcancel[hidden]{display:none}.voice .vcancel:hover{border-color:var(--w2)}.voice .vcancel:focus-visible{outline:1px solid var(--white);outline-offset:2px}' +
      '.voice .vctx{margin-top:6px}' +
      '.cl-mini{position:fixed;left:var(--mx,300px);top:var(--my,100px);z-index:40;width:min(360px,calc(100vw - var(--mx,300px) - 24px));max-height:min(440px,calc(100vh - var(--my,100px) - 16px));display:flex;flex-direction:column;background:rgba(9,16,27,.82);-webkit-backdrop-filter:blur(7px) saturate(1.1);backdrop-filter:blur(7px) saturate(1.1);--frame:rgba(220,231,243,.26)}.cl-mini.fr:hover,.cl-mini.fr:focus-within{background:rgba(9,16,27,.82)}' +
      '.cl-mini[hidden]{display:none}.cl-mini .ttl{min-height:36px;flex:none}' +
      '.cl-mini .mclose{background:none;border:1px solid var(--line-2);width:24px;height:24px;display:grid;place-items:center;cursor:pointer}.cl-mini .mclose svg{width:10px;height:10px}.cl-mini .mclose:hover{border-color:var(--w2)}' +
      '.cl-mini .mbody{overflow-y:auto;padding:2px 16px 12px 22px;min-height:44px;flex:1 1 auto}' +
      '.cl-mini .mt+.mt{margin-top:12px}.cl-mini .mu,.cl-mini .ma{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;font-size:13.5px;line-height:1.45;overflow-wrap:anywhere}' + /* the label column fits a short assistant name like "Com Link" on one line */
      '.cl-mini .mu b,.cl-mini .ma b{font:600 11.5px var(--sans);color:var(--w3);padding-top:2px;white-space:nowrap}.cl-mini .mu span{color:var(--white);font-weight:500}' +
      '.cl-mini .ma{margin-top:6px}.cl-mini .ma p{color:var(--w2);white-space:pre-wrap}.cl-mini .ma p+p{margin-top:6px}.cl-mini .mwait{color:var(--w3)}' +
      '.cl-mini .mlive .mu span{color:var(--w2);font-style:italic}.cl-mini .mlive .mu span:empty::before{content:"…";color:var(--w3)}' +
      '.cl-mini .me{margin-top:6px;margin-left:66px;font-size:12.5px;color:var(--white);border-left:3px solid #b3261b;padding:2px 0 2px 8px;overflow-wrap:anywhere}' +
            '.cl-mini .vperm{margin:0 16px 12px 22px;border:1px solid var(--line);border-left:3px solid #e08a2c;padding:8px 10px;text-align:left;background:rgba(255,255,255,.03);flex:none}' +
      '.cl-mini .vperm[hidden]{display:none}' +
      '.cl-mini .vpq{font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}.cl-mini .vpq b{font-weight:700}' +
      '.cl-mini .vpq code{display:block;margin-top:2px;font:11px var(--mono);color:var(--w2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.cl-mini .vpb{display:flex;gap:6px;align-items:center;margin-top:8px}.cl-mini .vpb small{margin-left:auto;font-size:11.5px;color:var(--w3)}' +
      '.cl-mini .vpb .act:disabled{opacity:.5;cursor:default}' +
      '.cl-mini .vpe{margin-top:6px;font:11px var(--mono);color:var(--white);border-left:3px solid #b3261b;padding:2px 0 2px 8px}' +
      '.cl-mini .vpw{display:inline-block;font:600 11.5px var(--sans);padding:1px 8px;margin-left:6px;white-space:nowrap}' +
      '.cl-mini .vpw.ok{background:#9ccf7c;color:#0b1806}.cl-mini .vpw.no{background:#8f1d16;color:#fff}.cl-mini .vpw.cl{border:1px solid var(--line);color:var(--w2)}' +
      '.voice .vstop{background:none;border:1px solid var(--line);color:var(--w2);font:600 11.5px var(--sans);padding:2px 10px;cursor:pointer}.voice .vstop[hidden]{display:none}.voice .vstop:hover{color:var(--white);border-color:var(--w2)}.voice .vstop:disabled{opacity:.5;cursor:default}' +
      '@media (max-width:1100px){.cl-mini{left:12px;right:12px;top:auto;bottom:12px;width:auto;max-height:46vh}}';
    document.head.appendChild(st);
  }
  MC.events.on('chat', onChat);
  setInterval(() => { if(!document.hidden) pollRuns(); }, 30000);
  return cl;
})();
MC.voicePanel = () => MC.comlink.build();

/* ---------- BlitzVoice link: the voice client ----------
   MC.voice keeps the eye fields (state is the eye state: idle, listening, thinking, speaking; level, peak)
   and adds: available, reason, link (BlitzVoice's own state: idle, recording, transcribing, speaking),
   start(opts), stop(), cancel(), discard(), on(fn). The server relays BlitzVoice over the event stream as 'voice' events.
   Hooks a page may set: onPartial({id, text, wake}) for the live words of its own dictation, onWake(d) when the wake word
   went to this tab, onTranscript({id, text, error}) for the final text of its own dictation, onWakeFinal({id, text, error})
   for the final text of a wake dictation sent to this tab (without it onWakeText(text) is called, or the text goes to the Com Link). */
(function(){
  const V = MC.voice, subs = [];
  const eyeOf = { recording:'listening', transcribing:'thinking', speaking:'speaking', idle:'idle' };
  const stopIcon = '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" fill="#fff"/></svg>';
  const tips = { 'not running':'BlitzVoice is not running, or its Mission Control link is off', 'link off':'Turn on Mission Control link in BlitzVoice settings', 'unauthorized':'Turn on Mission Control link in BlitzVoice settings' };
  let myId = null, pending = false, earlyP = null; /* myId: the dictation this page started; only its transcript and live words are used */
  V.available = false; V.reason = 'not running'; V.link = 'idle'; V.live = 0; V.liveAt = 0;
  /* On a phone the voice client acts as if BlitzVoice is not linked: no focus reports, no speak, no wake, no mic.
     The attribute can arrive after first paint (MC.whoami), so nothing decides until it has answered. */
  let whoKnown = false;
  const isRemote = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  V.remote = isRemote;
  const ready = Promise.resolve(MC.whoami).then(() => { whoKnown = true; });

  const emit = kind => subs.forEach(f => { try { f(kind, V); } catch(e){ console.error(e); } });
  V.on = fn => { subs.push(fn); return () => { const i = subs.indexOf(fn); if(i >= 0) subs.splice(i, 1); }; };

  const mic = () => document.querySelector('[data-cl-mic]');

  function wordFor(){
    if(V.linkWord && V.link !== 'idle') return V.linkWord; /* a phone names its own steps, such as Preparing voice */
    if(V.link === 'recording') return 'Listening';
    if(V.link === 'transcribing') return 'Thinking';
    if(V.link === 'speaking') return 'Talking';
    return '';
  }
  /* The Com Link's mic is a wide button with a word (Talk or Stop); the Talk page paints its own control. */
  function paintMic(){
    const b = mic(); if(!b) return;
    if(whoKnown && isRemote()){ if(V.paintPhone) V.paintPhone(b); return; } /* a phone paints its own steps: Talk, Send, Stop */
    const rec = V.link === 'recording', talk = V.link === 'speaking', usable = V.available && !pending && (V.link === 'idle' || rec || talk);
    b.setAttribute('aria-disabled', usable ? 'false' : 'true');
    b.style.opacity = usable ? '' : '.4';
    b.style.cursor = usable ? '' : 'default';
    const label = !V.available ? (tips[V.reason] || tips['not running'])
      : rec ? 'Stop and send what you said (Esc cancels)'
      : V.link === 'transcribing' ? 'Transcribing, one moment'
      : talk ? 'Stop speaking'
      : 'Talk to Haiku';
    b.title = label; b.setAttribute('aria-label', label);
    if(!b.classList.contains('vmic')){
      /* another page's control (the Talk page): icon only, repainted here */
      const want = rec || talk ? 'stop' : 'mic';
      if(b.dataset.icon !== want){ b.dataset.icon = want; b.innerHTML = want === 'stop' ? stopIcon : MC.ic.mic; }
    } else {
      const want = rec || talk ? 'stop' : 'mic';
      if(b.dataset.icon !== want){ b.dataset.icon = want; b.innerHTML = (want === 'stop' ? stopIcon : MC.ic.mic) + '<span class="ml">' + (want === 'stop' ? 'Stop' : 'Talk') + '</span>'; }
    }
    b.classList.toggle('on', rec || talk);
  }
  function paintAll(){
    paintMic();
    if(MC.comlink.paint) MC.comlink.paint();
  }
  MC.comlink.voiceText = () => (V.available || isRemote() ? wordFor() : 'Voice off');

  function setLink(st){
    V.link = st;
    if(st === 'idle'){ V.live = 0; V.liveAt = 0; MC.setVoice('idle'); MC.comlink.syncVoice(); }
    else MC.setVoice(eyeOf[st] || 'idle');
    if(st !== 'recording'){ V.live = 0; V.liveAt = 0; }
  }
  /* a phone has no BlitzVoice state, so its own steps (recording, sending, speaking) use the same link vocabulary and the eye,
     the status word and the reply logic follow them. word replaces the usual word for the step (for example Preparing voice). */
  V.setPhoneLink = (st, word) => { if(!isRemote()) return; V.linkWord = word || ''; setLink(st); paintAll(); };
  function applyStatus(s){
    if(!s || typeof s !== 'object' || isRemote()) return;
    const was = V.available;
    V.available = !!s.available; V.reason = s.reason || 'not running';
    setLink(V.available ? (s.state || 'idle') : 'idle');
    pending = false; paintAll(); emit('status');
    if(!V.available) applyWake(null); else if(!was) loadWake(); /* the wake status belongs to the link: ask for it when the link comes up */
  }

  /* ---- wake word: BlitzVoice listens for a phrase and starts a dictation by itself ----
     V.wake is BlitzVoice's own status {enabled, state, paused_reason, model, threshold, models, error}, null when unknown. */
  V.wake = null;
  V.wakePhrase = () => { /* hey_jarvis_v0.1 -> Hey Jarvis */
    const m = V.wake && V.wake.model; if(!m) return '';
    return String(m).replace(/_v\d+(\.\d+)*$/i, '').split(/[_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  };
  function applyWake(w){ V.wake = w && typeof w === 'object' ? w : null; emit('wake'); }
  function loadWake(){ return MC.api.get('/api/voice/wake').then(r => applyWake(r && r.available ? r.wake : null)).catch(() => {}); }
  /* patch: any of {enabled, model, threshold}. The switch moves at once and snaps back if BlitzVoice refuses (no popup). */
  V.setWake = async patch => {
    const old = V.wake;
    if(old && typeof patch.enabled === 'boolean'){ V.wake = Object.assign({}, old, { enabled:patch.enabled }); emit('wake'); }
    try { applyWake(await MC.api.post('/api/voice/wake', patch)); return true; }
    catch(e){ V.wake = old; emit('wake'); loadWake(); return false; }
  };
  /* the phrase was heard: the eye listens at once, the recording state follows a moment later */
  let eyeT = 0;
  function heardWake(){
    if(!V.available || V.link !== 'idle') return;
    MC.setVoice('listening');
    clearTimeout(eyeT);
    eyeT = setTimeout(() => { if(V.link === 'idle' && MC.voice.state === 'listening'){ MC.setVoice('idle'); MC.comlink.syncVoice(); } }, 4000);
  }

  /* ---- which tab gets a wake dictation: every page tells the server when it is visible or focused ----
     Only the tab the server names acts. On the Talk page the words go to the open conversation (chat.html sets the hooks),
     on Home and project pages the Com Link assistant takes them, anywhere else the server drops the dictation. */
  MC.tabId = ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, '').slice(0, 40);
  const wakePage = () => /chat\.html$/.test(location.pathname) ? 'chat' : (document.querySelector('[data-voice-panel]') && window.MCPhrases) ? 'comlink' : 'other';
  let focusSeq = 0;
  function tellFocus(beat, gone){
    if(!whoKnown || isRemote()) return; /* a phone is never the tab that takes a wake dictation */
    const visible = !gone && document.visibilityState === 'visible';
    /* seq orders this tab's reports, at is when it happened on this page (so a slow request cannot reorder events) */
    const body = { tab:MC.tabId, seq:++focusSeq, at:performance.timeOrigin + performance.now() };
    if(gone) body.gone = true;
    else Object.assign(body, { page:wakePage(), visible, beat:!!beat, focused:document.hasFocus() });
    try {
      /* keepalive lets a pagehide report finish; sendBeacon cannot send the X-MC header the server requires */
      fetch('/api/voice/focus', { method:'POST', keepalive:true, headers:{ 'X-MC':'1', 'Content-Type':'application/json' }, body:JSON.stringify(body) }).catch(() => {});
    } catch(e){}
  }
  document.addEventListener('visibilitychange', () => tellFocus(false));
  window.addEventListener('focus', () => tellFocus(false));
  window.addEventListener('pageshow', () => tellFocus(false));
  window.addEventListener('pagehide', () => tellFocus(false, true));
  setInterval(() => tellFocus(true), 30000); /* hidden tabs too: they stay known for the 2 minute grace */
  ready.then(() => tellFocus(false));

  const woken = new Set();
  function wakeText(d){
    if(!d.target || d.target !== MC.tabId) return; /* some other tab was looked at last, or none was */
    if(d.id != null){ if(woken.has(String(d.id))) return; woken.add(String(d.id)); if(woken.size > 50) woken.delete(woken.values().next().value); }
    const text = String(d.text == null ? '' : d.text).replace(/\s+/g, ' ').trim();
    if(V.onWakeFinal){ V.onWakeFinal({ id:d.id == null ? null : String(d.id), text, error:d.error ? String(d.error) : '' }); return; }
    if(d.error){
      if(V.onWakeError) V.onWakeError(String(d.error)); else MC.comlink.note('BlitzVoice could not transcribe that: ' + d.error);
      return;
    }
    if(!text) return; /* nothing was heard: nothing is sent */
    /* a follow-up resumes the conversation on screen (its session id), so a one-off task that began there stays off claude.ai */
    if(V.onWakeText) V.onWakeText(text); else MC.comlink.send(text, { voice:true, sessionId: MC.comlink.mini.sessionId() || undefined });
  }

  /* the live words: only this page's own dictation (the one it started, or a wake dictation sent to it) */
  function partial(d){
    const id = String(d.id), text = String(d.text == null ? '' : d.text);
    const mine = myId !== null && id === myId, wk = d.wake === true && !!d.target && d.target === MC.tabId;
    if(!mine && !wk){ if(pending && myId === null) earlyP = { id, text }; return; } /* a live word can beat the answer to /start */
    if(V.onPartial) V.onPartial({ id, text, wake:wk });
  }

  MC.events.on('voice', d => {
    if(!d || !whoKnown || isRemote()) return;
    if(d.kind === 'status') applyStatus(d);
    else if(d.kind === 'prefs') applyPrefs(d);
    else if(d.kind === 'state'){ if(V.available){ setLink(d.state); pending = false; paintAll(); emit('state'); } }
    else if(d.kind === 'level'){
      V.live = Math.max(0, Math.min(1, +d.value || 0)); V.liveAt = performance.now();
      if(V.link === 'recording'){ if(MC.comlink.paint) MC.comlink.paint(); emit('level'); }
    }
    else if(d.kind === 'wake_state'){ if(V.available) applyWake(d.wake); }
    else if(d.kind === 'wake'){ heardWake(); if(d.target && d.target === MC.tabId && V.onWake) V.onWake(d); }
    else if(d.kind === 'partial') partial(d);
    else if(d.kind === 'wake_note'){ if(d.target && d.target === MC.tabId){ const n = String(d.note || ''); if(n){ if(V.onWakeNote) V.onWakeNote(n); else MC.comlink.note(n); } } }
    else if(d.kind === 'transcript'){
      if(d.wake){ wakeText(d); return; }
      if(myId == null || String(d.id) !== myId) return; /* a hotkey dictation, another tab's, or one already handled */
      const id = myId; myId = null; pending = false;
      if(V.onTranscript) V.onTranscript({ id, text:String(d.text == null ? '' : d.text), error:d.error ? String(d.error) : '' });
      else if(d.error) MC.comlink.note('BlitzVoice could not transcribe that: ' + d.error);
      paintAll(); emit('transcript');
    }
  });

  /* ---- voice preferences (kept by the server, so every tab agrees): the Talk page switches, the spoken phrases, and how the
     Com Link runs and listens. The Settings page edits them all. ---- */
  const P = MC.voicePrefs = { readAloud:false, cleanup:true, sendPhrase:'send it', cancelPhrase:'cancel that', rewritePhrase:'start over', endPhrase:'end conversation',
    comlinkName:'Com Link', comlinkPersona:true, autoListen:true, remoteControl:true, listenSilenceSec:30, hidePanelSec:0, comlinkEffort:'medium', comlinkMode:'auto', comlinkModel:'', ready:null }, psubs = [];
  const PHRASE_KEYS = ['sendPhrase', 'cancelPhrase', 'rewritePhrase', 'endPhrase'];
  const BOOL_KEYS = ['readAloud', 'cleanup', 'comlinkPersona', 'autoListen', 'remoteControl'];
  const NUM_KEYS = ['listenSilenceSec', 'hidePanelSec'];
  const TEXT_KEYS = ['comlinkName', 'comlinkEffort', 'comlinkMode', 'comlinkModel'];
  P.on = fn => { psubs.push(fn); return () => { const i = psubs.indexOf(fn); if(i >= 0) psubs.splice(i, 1); }; };
  const pnotify = () => psubs.forEach(f => { try { f(P); } catch(e){ console.error(e); } });
  function applyPrefs(j){
    if(!j || typeof j !== 'object') return;
    BOOL_KEYS.forEach(k => { if(typeof j[k] === 'boolean') P[k] = j[k]; });
    PHRASE_KEYS.forEach(k => { if(typeof j[k] === 'string' && j[k]) P[k] = j[k]; });
    NUM_KEYS.forEach(k => { if(typeof j[k] === 'number' && isFinite(j[k])) P[k] = j[k]; });
    TEXT_KEYS.forEach(k => { if(typeof j[k] === 'string') P[k] = j[k]; });
    pnotify();
  }
  P.load = () => (P.ready = MC.api.get('/api/voice/prefs').then(applyPrefs).catch(() => {}));
  P.set = async (key, val) => {
    if(PHRASE_KEYS.includes(key) || NUM_KEYS.includes(key) || TEXT_KEYS.includes(key)){ /* the server judges it, and a refusal reaches the caller */
      try { applyPrefs(await MC.api.put('/api/voice/prefs', { [key]: val })); }
      catch(e){ P.load(); throw e; }
      return;
    }
    if(typeof val !== 'boolean' || !BOOL_KEYS.includes(key)) return;
    const old = P[key]; P[key] = val; pnotify();
    try { applyPrefs(await MC.api.put('/api/voice/prefs', { [key]: val })); }
    catch(e){ P[key] = old; pnotify(); P.load(); } /* no popup: the switch simply snaps back */
  };
  P.load();
  document.addEventListener('visibilitychange', () => { if(!document.hidden) P.load(); }); /* catches a change made while this tab slept */

  /* ---- reading a reply aloud: the final text of a turn, sent to BlitzVoice ----
     holder.say = { id, text } is the latest assistant message with text; a tool call after it means it was not the final one.
     The Talk page reads aloud only when its "Read replies aloud" switch is on; the Com Link always does (always: true). */
  V.noteReply = (holder, ev) => {
    if(!ev || ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return;
    const blocks = ev.message.content.filter(b => b && typeof b === 'object');
    const t = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
    const id = String(ev.message.id || ev.uuid || '');
    if(t){
      if(holder.say && id && holder.say.id === id) holder.say.text += '\n' + t; else holder.say = { id, text:t };
    }
    if(blocks.some(b => b.type === 'tool_use')) holder.say = null;
  };
  V.finishReply = (holder, runId, always) => {
    const s = holder.say; holder.say = null; if(!s) return Promise.resolve(null);
    let h = 5381; for(let i = 0; i < s.text.length; i++) h = ((h * 33) ^ s.text.charCodeAt(i)) >>> 0;
    return V.speakReply(s.text, String(runId) + ':' + (s.id || h.toString(36)), always);
  };
  /* resolves BlitzVoice's answer, or null when nothing was sent */
  V.speakReply = async (text, key, always) => {
    text = String(text || '').trim(); if(!text) return null;
    await P.ready;
    if(isRemote()) return always && V.phoneSpeak ? V.phoneSpeak(text) : null; /* a phone plays the voice itself */
    if((!always && !P.readAloud) || !V.available) return null;
    try { return await MC.api.post('/api/voice/speak', { text, key }); } catch(e){ return null; /* nothing extra is shown, BlitzVoice may be busy */ }
  };

  async function call(name, body){
    try { return await MC.api.post('/api/voice/' + name, body || {}); }
    catch(e){
      if(e.status === 409) MC.comlink.note(name === 'start' ? (/busy|transcrib/i.test(e.message) ? 'BlitzVoice is still transcribing.' : 'BlitzVoice is already recording.') : 'BlitzVoice is not recording.');
      else if(e.status === 503 || e.status === 502) { MC.comlink.note('BlitzVoice did not answer. Is it running?'); refresh(); }
      else MC.comlink.note('BlitzVoice refused that: ' + (e.message || 'error'));
      return null;
    }
  }
  /* BlitzVoice is reading a reply: stop it. The state event that follows repaints everything. */
  V.stopSpeak = async () => {
    if(isRemote()){ if(V.phoneStopSpeech) V.phoneStopSpeech(); return; }
    if(!V.available || V.link !== 'speaking') return;
    try { await MC.api.post('/api/voice/speak/stop', {}); }
    catch(e){ if(e.status === 503 || e.status === 502) refresh(); }
  };
  const untilIdle = ms => new Promise(done => {
    const t0 = Date.now();
    (function look(){ if(V.link === 'idle' || Date.now() - t0 > ms) done(); else setTimeout(look, 60); })();
  });
  /* opts (all optional): partials (live words), autostop ('none' keeps listening until you end it), cleanup (false for none), model.
     A page may set V.startOptions for its own mic button. */
  V.startOptions = null;
  V.start = async opts => {
    if(!V.available || pending || (V.link !== 'idle' && V.link !== 'speaking')) return;
    opts = opts && typeof opts === 'object' ? opts : V.startOptions;
    pending = true; myId = null; earlyP = null; paintMic();
    if(V.link === 'speaking'){ await V.stopSpeak(); await untilIdle(2000); }
    if(V.link !== 'idle'){ pending = false; paintMic(); return; }
    const r = await call('start', opts || {});
    if(r && r.id != null){
      myId = String(r.id);
      const e = earlyP; earlyP = null;
      if(e && e.id === myId) setTimeout(() => { if(myId === e.id && V.onPartial) V.onPartial({ id:e.id, text:e.text, wake:false }); }, 0);
    }
    if(!r){ pending = false; paintMic(); }
    else if(r.cleanup === 'unavailable' && !V.cleanupNoted){ V.cleanupNoted = true; /* once per page load */ if(V.onCleanupOff) V.onCleanupOff(); else MC.comlink.note('Cleanup is off in BlitzVoice'); }
    return r;
  };
  V.stop = async () => { if(V.available && V.link === 'recording') await call('stop'); };
  V.cancel = async () => {
    if(!V.available || V.link !== 'recording') return;
    myId = null; await call('cancel');
  };
  /* ends the dictation at once: no transcription, no text, no transcript event */
  V.discard = async () => {
    myId = null;
    if(!V.available) return;
    try { await MC.api.post('/api/voice/discard', {}); } catch(e){ /* it may already have ended */ }
  };

  function refresh(){ if(!whoKnown || isRemote()) return Promise.resolve(); return MC.api.get('/api/voice').then(applyStatus).catch(() => { if(V.available) applyStatus({ available:false, reason:'not running' }); }); }

  V._bind = function(){
    const b = mic(); if(!b) return;
    b.onclick = () => {
      if(isRemote()){ if(b.getAttribute('aria-disabled') !== 'true' && V.micAction) V.micAction(); return; } /* a phone: the Com Link assistant records */
      if(b.getAttribute('aria-disabled') === 'true') return;
      if(V.micAction && V.micAction() !== false) return; /* the Com Link assistant owns the button */
      V.link === 'recording' ? V.stop() : V.link === 'speaking' ? V.stopSpeak() : V.start();
    };
    paintMic(); ready.then(() => { refresh(); paintMic(); });
  };
  document.addEventListener('keydown', e => {
    if(MC.comlink.mini && MC.comlink.mini.isOpen()) return; /* the assistant's own Escape handling closes its panel */
    if(e.key === 'Escape' && !isRemote() && V.available && V.link === 'recording'){ e.preventDefault(); V.cancel(); }
  });
  /* the status event is sent only on a change, so a slow poll catches anything missed (server restart, sleep) */
  let ticks = 0;
  setInterval(() => { if(!document.hidden && document.querySelector('[data-cl-mic]') && (!V.available || ++ticks % 5 === 0)) refresh(); }, 3000);
})();

/* ---------- microphone capture helpers: the Com Link on a phone and the wake word recorder on Settings ----------
   MC.audio.wav(f32) is a 16kHz mono 16-bit PCM WAV blob from float samples, MC.audio.to16k(samples, rate) resamples to 16kHz,
   MC.audio.WORKLET is the source of the capture processor ("wk-cap"). MC.audio.record(opts) asks for the microphone and resolves
   a recording: { stop() resolves { wav, seconds, peak } (peak 0 to 1), cancel() }. It rejects with the getUserMedia error
   (name NotAllowedError when the microphone is blocked), or TimeoutError when the microphone opened but the audio would not
   start within 8 seconds (the microphone is released first). opts: maxSec (the recording ends by itself, default 120: onLimit is
   called, the page then calls stop), skipMs (the first milliseconds are not kept, so a chime is not recorded), onLevel(0 to 1),
   openMs (give up with TimeoutError when getUserMedia has not answered after this long, default: wait for ever) and signal (an
   AbortSignal: aborting it rejects with AbortError at any point of the start). Whenever a start is given up, whether it timed out,
   was aborted or failed, every track is stopped, also the ones of a getUserMedia that answers late. */
MC.audio = (function(){
  const WORKLET = 'class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("wk-cap",C)';
  function wav(f32){
    const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
    const str = (o, s) => { for(let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, f32.length * 2, true);
    for(let i = 0; i < f32.length; i++){ const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type:'audio/wav' });
  }
  /* the browser's own resampler first; plain averaging if it is not there */
  async function to16k(samples, rate){
    if(rate === 16000) return samples;
    try {
      const n = Math.max(1, Math.round(samples.length * 16000 / rate));
      const off = new OfflineAudioContext(1, n, 16000);
      const b = off.createBuffer(1, samples.length, rate);
      b.copyToChannel(samples, 0);
      const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start();
      return (await off.startRendering()).getChannelData(0);
    } catch(e){
      const ratio = rate / 16000, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
      for(let i = 0; i < n; i++){ const a = Math.floor(i * ratio), z = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for(let k = a; k < z; k++) s += samples[k]; out[i] = s / (z - a); }
      return out;
    }
  }
  const START_MS = 8000;
  /* p, or a TimeoutError after ms (none when ms is 0), or an AbortError as soon as signal is aborted */
  function within(p, ms, signal){
    let t, onAbort;
    const late = new Promise((_, no) => {
      if(ms) t = setTimeout(() => no(Object.assign(new Error('The microphone did not start'), { name:'TimeoutError' })), ms);
      if(signal){
        onAbort = () => no(Object.assign(new Error('Canceled'), { name:'AbortError' }));
        if(signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once:true });
      }
    });
    return Promise.race([p, late]).finally(() => { clearTimeout(t); if(signal && onAbort) signal.removeEventListener('abort', onAbort); });
  }
  async function record(o){
    o = o || {};
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && AC && window.AudioWorkletNode)) throw Object.assign(new Error('Recording is not supported here'), { name:'NotSupportedError' });
    const sig = o.signal;
    let gaveUp = false, stream = null, ctx = null, node = null, url = '';
    try {
      /* the whole start is under a limit or an abort: the microphone, the audio context and the worklet. A microphone that answers
         after the start was given up is released the moment it arrives. */
      const asked = navigator.mediaDevices.getUserMedia({ audio:{ channelCount:1 } });
      asked.then(s => { if(gaveUp) s.getTracks().forEach(t => t.stop()); }, () => {});
      stream = await within(asked, o.openMs || 0, sig);
      ctx = new AC();
      /* once the microphone is open, the audio context must be ready within START_MS or the start fails (TimeoutError) and the mic is released */
      if(ctx.state !== 'running') await within(ctx.resume().catch(() => {}), START_MS, sig);
      url = URL.createObjectURL(new Blob([WORKLET], { type:'text/javascript' }));
      await within(ctx.audioWorklet.addModule(url), START_MS, sig);
      node = new AudioWorkletNode(ctx, 'wk-cap', { numberOfOutputs:0 });
      if(sig && sig.aborted) throw Object.assign(new Error('Canceled'), { name:'AbortError' });
      ctx.createMediaStreamSource(stream).connect(node);
    } catch(e){
      gaveUp = true;
      if(stream) stream.getTracks().forEach(t => t.stop());
      if(ctx) ctx.close().catch(() => {}); /* not awaited: a context that never settled may never close either */
      throw e;
    } finally { if(url) URL.revokeObjectURL(url); }
    const maxSec = o.maxSec || 120, chunks = []; let total = 0, level = 0, ended = false, limitT = 0;
    const keepFrom = performance.now() + (o.skipMs || 0), cap = Math.round(maxSec * ctx.sampleRate);
    node.port.onmessage = e => {
      const d = e.data; if(!d || performance.now() < keepFrom || total >= cap) return;
      chunks.push(d); total += d.length;
      let peak = 0; for(let i = 0; i < d.length; i++){ const a = Math.abs(d[i]); if(a > peak) peak = a; }
      level = Math.max(peak, level * .85);
      if(o.onLevel) o.onLevel(Math.min(1, level));
    };
    if(o.onLimit) limitT = setTimeout(() => { if(!ended) o.onLimit(); }, maxSec * 1000);
    async function end(){
      if(ended) return false; ended = true; clearTimeout(limitT);
      node.port.onmessage = null; try { node.disconnect(); } catch(e){ /* ignore */ }
      stream.getTracks().forEach(t => t.stop());
      return ctx.sampleRate;
    }
    return {
      async stop(){
        const rate = await end(); if(!rate) return null;
        try { await ctx.close(); } catch(e){ /* ignore */ }
        const all = new Float32Array(Math.min(total, cap)); let at = 0; for(const c of chunks){ const room = all.length - at; if(room <= 0) break; all.set(c.length > room ? c.subarray(0, room) : c, at); at += c.length; }
        const mono = await to16k(all, rate);
        let peak = 0; for(let i = 0; i < mono.length; i++){ const a = Math.abs(mono[i]); if(a > peak) peak = a; }
        return { wav:wav(mono), seconds:mono.length / 16000, peak };
      },
      async cancel(){ if(await end()){ try { await ctx.close(); } catch(e){ /* ignore */ } } }
    };
  }
  return { wav, to16k, record, WORKLET };
})();

/* ---------- Com Link sounds: listening, canceled, sent ----------
   MC.sound.play('listen' | 'cancel' | 'send'), three soft tones made with Web Audio (no files), each under 250ms and told apart by ear:
   listen is a rising two-note chime, cancel one low falling note, send a quick bright double blip. The context is created on first use
   and resumed when needed. A browser may keep audio locked until the page has had a click or key press; then the tone is skipped
   (never queued, so a late tone cannot surprise you) and nothing throws. Only the voice assistant below plays them. */
MC.sound = (function(){
  const GAIN = .07; /* peak of every tone: quiet */
  /* tones: [frequency Hz, start s, length s, end frequency Hz for a glide (optional)] */
  const TONES = {
    listen: [[660, 0, .09], [880, .09, .11]],
    cancel: [[330, 0, .21, 196]],
    send: [[1568, 0, .05], [1568, .08, .06]]
  };
  let ctx = null;
  function context(){
    if(ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    ctx = new AC();
    return ctx;
  }
  function tone(c, t0, spec){
    const s = t0 + spec[1], e = s + spec[2];
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = spec[0];
    if(spec[3]){ o.frequency.setValueAtTime(spec[0], s); o.frequency.exponentialRampToValueAtTime(spec[3], e); }
    g.gain.setValueAtTime(.0001, s); g.gain.linearRampToValueAtTime(GAIN, s + .008); g.gain.exponentialRampToValueAtTime(.0001, e);
    o.connect(g); g.connect(c.destination);
    o.start(s); o.stop(e + .02);
  }
  function play(name){
    try {
      const spec = TONES[name], c = spec && context(); if(!c) return;
      const asked = Date.now();
      const go = () => { try { if(c.state !== 'running' || Date.now() - asked > 400) return; const t0 = c.currentTime + .01; spec.forEach(t => tone(c, t0, t)); } catch(e){ /* a missing sound is not worth an error */ } };
      if(c.state === 'running') go();
      else { const r = c.resume(); if(r && r.then) r.then(go, () => {}); }
    } catch(e){ /* the sounds are a courtesy: never throw */ }
  }
  /* the first click or key press on a page with a Com Link unlocks audio, so the hands-free tones can play later */
  function unlock(){
    try {
      if(!document.querySelector('[data-voice-panel]')) return; /* only a page with a Com Link plays tones (a phone does too) */
      const c = context();
      if(c && c.state === 'running'){ removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true); }
      else if(c) c.resume().then(() => { if(c.state === 'running'){ removeEventListener('pointerdown', unlock, true); removeEventListener('keydown', unlock, true); } }, () => {});
    } catch(e){ /* locked or unsupported: the tones are skipped */ }
  }
  addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true);
  return { play };
})();

/* ---------- the Com Link assistant: talk, "send it", "cancel that", "start over", "end conversation" ----------
   The wake word or the mic starts a dictation with live words (partials, no automatic stop). The words show in the mini panel.
   When they end with the send phrase the dictation is discarded and the text goes to the assistant at once (no cleanup). The cancel
   phrase drops the dictation and stops listening, the conversation stays. The rewrite phrase drops the words and starts a fresh
   dictation at once, so you just keep talking. The end phrase drops the dictation and ends the conversation. A phrase counts only when the text ending with it has stayed
   unchanged for 400ms (MCPhrases.PhraseWatch). While listening the mic button sends what was said. */
(function(){
  const V = MC.voice, cl = MC.comlink, P = MC.voicePrefs, PH = window.MCPhrases;
  const isTalk = /chat\.html$/.test(location.pathname);
  const A = MC.assistant = { phase:'off', id:null, text:'', prefix:'', sawRec:false, startedAt:0 }; /* phase: off, listening */
  const enabled = () => !!(PH && !isTalk && document.querySelector('[data-voice-panel]')); /* a phone too: it records with its own microphone (see below) */
  const phrases = () => ({ send:P.sendPhrase, cancel:P.cancelPhrase, rewrite:P.rewritePhrase, end:P.endPhrase });
  const watch = PH ? new PH.PhraseWatch({ phrases, onAct:(kind, rest) => act(kind, rest) }) : null;
  if(!watch || isTalk) return;

  function begin(id, prefix, oneOff){
    A.oneOff = !!oneOff; /* a skill chip began this dictation: what is said starts a one-off task */
    A.phase = 'listening'; A.id = id == null ? null : String(id); A.gotPartial = false; A.text = ''; A.prefix = prefix || ''; A.sawRec = V.link === 'recording'; A.startedAt = Date.now();
    watch.reset(); cl.mini.beginLive(A.prefix);
    clearTimeout(A.lostT); A.lostT = setTimeout(checkLost, 5000);
    clearTimeout(A.quietT); A.quietT = setTimeout(quiet, Math.max(5, P.listenSilenceSec || 30) * 1000);
    MC.sound.play('listen'); /* the Talk button, a skill chip and the wake word all start here */
  }
  const done = new Set(); /* dictations this page has finished: their late live words must not start a new turn */
  /* Settings "Stop listening after": nothing was said, so the mic closes quietly. The conversation stays. */
  function quiet(){ if(A.phase === 'listening' && !String(A.text || '').trim()) cancelAll(); }
  function over(){ clearTimeout(A.quietT); if(A.id != null){ done.add(A.id); if(done.size > 30) done.delete(done.values().next().value); } A.phase = 'off'; A.id = null; watch.reset(); clearTimeout(A.lostT); cl.mini.endLive(); /* the live row never outlives its dictation, even when a pending permission keeps the panel open */ }
  function discard(){ if(V.remote()) phoneDrop(); else V.discard(); }
  function sendTurn(text){
    over();
    MC.sound.play('send'); /* the send phrase, the Talk button with words, or a dictation that ended with text */
    cl.send(text, { voice:true, sessionId: cl.mini.sessionId() || undefined, remote: A.oneOff ? false : undefined });
  }
  /* the cancel phrase, a send phrase with nothing before it, or the Talk button with nothing said: this question is dropped,
     the conversation stays (an empty panel closes, one with turns hides after the usual wait) */
  function cancelAll(){ over(); discard(); if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close(); MC.sound.play('cancel'); }
  /* the end phrase: the dictation is dropped, a reply in progress is stopped, and the next question starts a new conversation */
  function endAll(){ over(); discard(); if(cl.isBusy()) cl.stop(); cl.mini.end(); MC.sound.play('cancel'); }
  /* the rewrite phrase: the words so far are dropped and a fresh dictation starts at once (the listen chime says it is ready) */
  async function rewrite(){
    const prefix = A.prefix, oneOff = A.oneOff;
    over(); await V.discard();
    cl.mini.beginLive(prefix);
    const t0 = Date.now();
    while(V.link !== 'idle' && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 60));
    const r = await V.start({ partials:true, autostop:'none', cleanup:false });
    if(!r || r.id == null){ cl.mini.endLive(); cl.mini.later(); MC.sound.play('cancel'); cl.note('Could not start listening again.'); return; }
    begin(r.id, prefix, oneOff);
  }
  /* a phrase other than send: true when it was handled */
  function command(kind){
    if(kind === 'cancel'){ cancelAll(); return true; }
    if(kind === 'end'){ endAll(); return true; }
    if(kind === 'rewrite'){ rewrite(); return true; }
    return false;
  }
  function act(kind, rest){
    if(A.phase !== 'listening') return;
    if(command(kind)) return;
    const text = (A.prefix + rest).trim();
    if(!text) { cancelAll(); return; }
    discard(); sendTurn(text);
  }
  /* the mic button while listening: send what is there (or close if nothing was said) */
  function sendNow(){
    const d = PH.detect(A.text, phrases());
    if(d && command(d.kind)) return;
    const spoken = (d ? d.rest : A.text).trim();
    if(!spoken){ cancelAll(); return; }
    watch.reset(); discard(); sendTurn((A.prefix + spoken).trim());
  }
  function onPartial(p){
    if(done.has(p.id)) return;
    if(A.phase !== 'listening'){ if(p.wake && enabled()) begin(p.id, ''); else return; }
    if(p.wake && !A.gotPartial){ A.id = p.id; } /* a wake dictation: its own id is the one on its live words */
    A.gotPartial = true;
    if(A.id == null) A.id = p.id;
    if(p.id !== A.id) return;
    A.text = p.text; A.sawRec = true;
    cl.mini.setLive(A.prefix + p.text);
    watch.push(p.text);
  }
  /* the dictation ended some other way (BlitzVoice's own hotkey, an error): nothing is left to wait for */
  function checkLost(){
    if(A.phase !== 'listening') return;
    if(V.link === 'recording'){ A.sawRec = true; A.lostT = setTimeout(checkLost, 3000); return; }
    if(V.link === 'idle' && (A.sawRec || Date.now() - A.startedAt > 4500)){ over(); if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close(); MC.sound.play('cancel'); /* over() ended the live row, so onLiveClosed stays quiet: this is the only cancel tone */ }
    else A.lostT = setTimeout(checkLost, 1500);
  }
  V.on(kind => { if(kind === 'state' && A.phase === 'listening'){ if(V.link === 'recording') A.sawRec = true; else if(V.link === 'idle' && A.sawRec){ clearTimeout(A.lostT); A.lostT = setTimeout(checkLost, 900); } } });
  /* the final text of a dictation that ended by itself or by BlitzVoice: the same phrases apply */
  function onFinal(f){
    if(A.phase !== 'listening') return;
    if(A.id != null && f.id != null && String(f.id) !== A.id) return;
    if(f.error){ over(); if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close(); MC.sound.play('cancel'); cl.note(f.error === 'timeout' ? 'The dictation timed out, so nothing was sent.' : 'BlitzVoice could not transcribe that: ' + f.error); return; }
    const d = PH.detect(f.text, phrases());
    if(d && command(d.kind)) return;
    const spoken = (d ? d.rest : f.text).trim();
    if(!spoken){ cancelAll(); cl.note('BlitzVoice heard nothing.'); return; }
    sendTurn((A.prefix + spoken).trim());
  }

  /* ---- the Com Link on a phone: its own microphone and speaker ----
     Talk records in the page (MC.audio), Send posts the WAV to /api/voice/transcribe, and the text goes to the assistant exactly like a
     PC voice question (cl.send with voice:true, the same conversation). The reply is spoken by BlitzVoice into a WAV
     (/api/voice/tts) that this page plays. Nothing here touches the PC's microphone or speakers, and the wake word, the focus
     reports and BlitzVoice's own state stay off. There is no silence detection yet, so there is no "listen again after she
     answers" and no silence timeout: Talk is pressed for every question, and a recording ends by Send or after two minutes.
     R.step: idle, starting (waiting for the microphone), recording, sending (uploading and transcribing), preparing (the voice is
     being made), speaking. The step is mirrored into V.link (recording, transcribing, speaking) so the eye, the status word and
     the end-of-turn logic work as they do on the PC. */
  const PHONE_MAX_SEC = 120;
  /* R.tok numbers the starts: a start whose number is no longer R.tok was dropped (Escape, page hidden, timeout) while the
     microphone was still being asked for, so when it answers its recorder is released at once instead of going live. */
  const R = { step:'idle', rec:null, prefix:'', gen:0, tok:0, audio:null, url:'', startAc:null, job:null };
  const PHONE_OPEN_MS = 12000; /* the whole start gives up when the microphone has not answered by then; a late answer is released, so Talk can be tried again */
  const PHONE_SEND_MS = 70000; /* the upload and transcription of one question gives up after this long */
  /* a start that is no longer wanted: its number goes stale and the abort releases whatever it was waiting for */
  function dropStart(){
    R.tok++;
    const ac = R.startAc; R.startAc = null;
    if(ac) ac.abort();
  }
  const sendIcon = '<svg viewBox="0 0 20 20"><path d="M3 10 L17 3 L13 17 L10 11.5 Z" fill="#fff"/></svg>';
  const stopIcon = '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" fill="#fff"/></svg>';
  const LINK = { recording:'recording', sending:'transcribing', preparing:'transcribing', speaking:'speaking' };
  function phoneStep(step, word){
    /* a live recorder never outlives its step: leaving "recording" any way but phoneSend (which clears R.rec first) releases the mic,
       and a start still waiting for the microphone is dropped when the step moves on to anything but recording */
    if(R.rec && step !== 'recording'){ const r = R.rec; R.rec = null; r.cancel().catch(() => {}); }
    if(R.step === 'starting' && step !== 'starting' && step !== 'recording') dropStart();
    R.step = step; V.setPhoneLink(LINK[step] || 'idle', word); V.paintPhone();
  }
  const gone = ms => new Promise(r => setTimeout(r, ms));

  V.paintPhone = b => {
    b = b || document.querySelector('[data-cl-mic]'); if(!b) return;
    const s = R.step, rec = s === 'recording', talk = s === 'speaking' || s === 'preparing', wait = s === 'starting' || s === 'sending';
    const label = rec ? 'Send' : talk ? 'Stop' : s === 'sending' ? 'Sending' : 'Talk';
    const title = rec ? 'Send what you said' : talk ? 'Stop the answer' : s === 'sending' ? 'Sending, one moment' : s === 'starting' ? 'Waiting for the microphone' : 'Talk to ' + MC.comlinkName();
    b.setAttribute('aria-disabled', wait ? 'true' : 'false'); b.style.opacity = wait ? '.4' : ''; b.style.cursor = wait ? 'default' : '';
    b.title = title; b.setAttribute('aria-label', title);
    const want = rec ? 'send' : talk ? 'stop' : 'mic';
    if(b.dataset.icon !== want || b.dataset.word !== label){
      b.dataset.icon = want; b.dataset.word = label;
      b.innerHTML = (want === 'send' ? sendIcon : want === 'stop' ? stopIcon : MC.ic.mic) + '<span class="ml">' + label + '</span>';
    }
    b.classList.toggle('on', rec || talk);
    const c = document.querySelector('[data-cl-cancel]');
    if(c){ c.hidden = !(rec || wait); if(!c.dataset.bound){ c.dataset.bound = '1'; c.onclick = () => phoneCancel(); } }
  };

  /* the microphone could not be used: one short line that says what to do */
  function micFailed(e){
    const n = e && e.name;
    const text = n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'Microphone is blocked. In Android settings, open Apps, this app, Permissions, and allow Microphone.'
      : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No microphone was found on this phone.'
      : n === 'TimeoutError' ? 'The microphone did not start. Try again.' : 'Recording does not work here.';
    MC.sound.play('cancel');
    cl.note(text, 12000);
  }
  async function phoneStart(o){
    phoneStopSpeech();
    if(R.step !== 'idle') return;
    const tok = ++R.tok;
    const ac = new AbortController(); R.startAc = ac;
    phoneStep('starting');
    let rec;
    try {
      rec = await MC.audio.record({ signal:ac.signal, openMs:PHONE_OPEN_MS, maxSec:PHONE_MAX_SEC, skipMs:260, onLevel:v => { if(tok === R.tok){ V.live = Math.min(1, v * 2.5); V.liveAt = performance.now(); } }, onLimit:() => { if(tok === R.tok && R.step === 'recording'){ cl.note('That is the two minute limit, so it was sent.'); phoneSend(); } } });
    } catch(e){ if(tok === R.tok){ phoneStep('idle'); micFailed(e); phoneTidyPanel(); } return; }
    if(tok !== R.tok){ rec.cancel().catch(() => {}); return; } /* dropped while the microphone was starting: release it at once */
    R.startAc = null;
    R.rec = rec; R.prefix = (o && o.prefix) || ''; R.oneOff = !!(o && o.oneOff);
    A.phase = 'listening'; A.id = null; A.text = '';
    phoneStep('recording');
    cl.mini.beginLive(R.prefix);
    MC.sound.play('listen');
  }
  /* drops a recording in progress without sending it */
  function phoneDrop(){
    const rec = R.rec; R.rec = null;
    const starting = R.step === 'starting';
    if(starting) dropStart(); /* the microphone is still being asked for: that start is released (also when it answers late) */
    if(rec) rec.cancel().catch(() => {});
    if(R.step === 'recording' || starting){ phoneStep('idle'); if(starting) phoneTidyPanel(); }
  }
  /* a start that ended without a recording (dropped, or the microphone failed) leaves no empty "Question" panel behind: one with
     no turns closes, one with turns hides after the usual wait */
  function phoneTidyPanel(){
    if(!cl.mini.isOpen()) return;
    if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close();
  }
  /* Cancel: drops a start that is waiting for the microphone, a recording, or a question that is being uploaded */
  function phoneCancel(){
    if(R.step === 'sending'){ if(R.job) R.job.stop(true); return; } /* phoneSend then puts everything back */
    if(R.step !== 'recording' && R.step !== 'starting') return;
    over(); phoneDrop(); MC.sound.play('cancel');
    if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close();
  }
  /* the end of a question that sent nothing (nothing heard, an error): the live row goes and the panel hides */
  function phoneNothing(sound, text){
    over(); phoneStep('idle');
    if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close();
    if(sound) MC.sound.play('cancel');
    if(text) cl.note(text);
  }
  /* fetch, with one more try after a network error (the phone's proxy does not retry a POST for us) */
  async function postRetry(path, headers, body, signal){
    let err;
    for(let i = 0; i < 2; i++){
      try { return await fetch(path, { method:'POST', headers:Object.assign({ 'X-MC':'1' }, headers), body, signal }); }
      catch(e){ err = e; if(signal && signal.aborted) break; await gone(400); } /* no second try once it was canceled or timed out */
    }
    throw err;
  }
  async function transcribe(wav, signal){
    let res;
    try { res = await postRetry('/api/voice/transcribe', { 'Content-Type':'audio/wav' }, wav, signal); }
    catch(e){ throw new Error('Could not reach the server, so nothing was sent.'); }
    let j = null; try { j = await res.json(); } catch(e){ j = null; }
    if(res.ok) return String((j && j.text) || '');
    if(res.status === 403 && j && j.error === 'not_paired') MC.removed();
    throw new Error(res.status === 409 && j && j.error === 'no_link_model' ? 'Choose a "Model for Mission Control" in BlitzVoice on the PC.'
      : res.status === 409 ? 'BlitzVoice is busy. Try again in a moment.'
      : res.status === 503 ? ((j && j.reason) || 'BlitzVoice is not running.')
      : res.status === 413 ? 'That recording is too long.'
      : res.status === 400 ? 'BlitzVoice could not use that recording.'
      : 'Could not transcribe that.');
  }
  async function phoneSend(){
    const rec = R.rec; if(!rec || R.step !== 'recording') return;
    R.rec = null; A.phase = 'sending'; /* the live row stays up; closing the panel now drops the question */
    phoneStep('sending');
    MC.sound.play('send');
    /* The upload gives up after PHONE_SEND_MS. Cancel (or closing the panel) stops it at once. Whatever happens, the finally
       below returns the button to Talk. */
    const ac = new AbortController();
    const job = R.job = { canceled:false, timedOut:false, stop(byUser){ if(byUser) job.canceled = true; ac.abort(); } };
    const timer = setTimeout(() => { job.timedOut = true; ac.abort(); }, PHONE_SEND_MS);
    try {
      let out = null, text = '', fail = '';
      try { out = await rec.stop(); } catch(e){ out = null; }
      if(out && out.seconds >= .25 && out.peak >= .001 && !ac.signal.aborted){
        try { text = await transcribe(out.wav, ac.signal); } catch(e){ fail = e.message; }
      }
      if(ac.signal.aborted){ text = ''; fail = job.canceled ? '' : 'The server took too long, so nothing was sent.'; }
      if(!cl.mini.isOpen()){ A.phase = 'off'; phoneStep('idle'); MC.sound.play('cancel'); return; } /* the panel was closed meanwhile: the question is dropped */
      if(job.canceled){ phoneNothing(true); return; }
      const spoken = text.replace(/\s+/g, ' ').trim();
      if(fail){ phoneNothing(true, fail); return; }
      if(!spoken){ phoneNothing(true, 'Heard nothing.'); return; }
      /* the same phrases as on the PC apply to the end of what was said; a phone needs no send phrase, the Send button already sent it */
      const d = PH.detect(spoken, phrases());
      let say = spoken;
      if(d){
        if(d.kind === 'cancel'){ phoneStep('idle'); cancelAll(); return; } /* also a send phrase with nothing before it */
        if(d.kind === 'end'){ phoneStep('idle'); endAll(); return; }
        if(d.kind === 'rewrite'){ const prefix = R.prefix, oneOff = R.oneOff; over(); phoneStep('idle'); phoneStart({ prefix, oneOff }); return; }
        say = d.rest; /* the send phrase is not part of the question */
      }
      over();
      const sent = cl.send((R.prefix + say).trim(), { voice:true, sessionId: cl.mini.sessionId() || undefined, remote: R.oneOff ? false : undefined });
      if(sent && sent.catch) sent.catch(() => cl.note('Could not send that.'));
      phoneStep('idle'); /* after send: the eye then goes to thinking */
    } catch(e){
      if(R.step === 'sending') phoneNothing(true, 'Could not send that.'); /* something threw: the question is dropped, not stuck */
    } finally {
      clearTimeout(timer);
      if(R.job === job) R.job = null;
      if(A.phase === 'sending') A.phase = 'off';
      if(R.step === 'sending') phoneStep('idle');
    }
  }

  /* the reply: BlitzVoice makes the WAV, this page plays it. Resolves like BlitzVoice's speak answer: null when nothing played. */
  async function ttsBlob(text){
    const res = await postRetry('/api/voice/tts', { 'Content-Type':'application/json' }, JSON.stringify({ text }));
    if(res.status === 204) return null;
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }
  V.phoneSpeak = async text => {
    /* a new question is being asked (microphone starting, recording or uploading): an old reply stays silent, so it cannot
       talk over the recording or take the step away from it */
    if(R.step === 'starting' || R.step === 'recording' || R.step === 'sending') return null;
    phoneStopSpeech(true); /* an answer still playing (or being made) is stopped first, so two never play at once */
    const gen = ++R.gen; /* Talk, closing the panel or a newer reply stops this one */
    phoneStep('preparing', 'Preparing voice');
    let blob;
    try { blob = await ttsBlob(text); }
    catch(e){ if(gen === R.gen){ phoneStep('idle'); cl.note('Could not read the answer aloud.'); } return null; }
    if(gen !== R.gen) return null;
    if(!blob){ phoneStep('idle'); return { skipped:true }; }
    const url = URL.createObjectURL(blob), a = new Audio(url);
    R.audio = a; R.url = url;
    const finish = () => { if(R.audio !== a) return; R.audio = null; R.url = ''; URL.revokeObjectURL(url); phoneStep('idle'); };
    a.addEventListener('ended', finish); a.addEventListener('error', finish);
    try { await a.play(); }
    catch(e){ if(R.audio === a){ finish(); cl.note('The phone would not play the answer.'); } return null; }
    if(gen !== R.gen || R.audio !== a) return null; /* stopped while it was starting */
    phoneStep('speaking');
    return { ok:true, phone:true };
  };
  /* quiet: only the sound stops, the step is left for the caller to move on (no idle flicker between two answers) */
  function phoneStopSpeech(quiet){
    R.gen++;
    const a = R.audio;
    if(a){ R.audio = null; try { a.pause(); } catch(e){ /* ignore */ } }
    if(R.url){ URL.revokeObjectURL(R.url); R.url = ''; }
    if(quiet !== true && (R.step === 'speaking' || R.step === 'preparing')) phoneStep('idle');
  }
  V.phoneStopSpeech = phoneStopSpeech;
  /* leaving the page ends the microphone, so a recording does not carry on in the background */
  function phoneLeave(){
    const was = R.step;
    if(was === 'recording' || was === 'starting'){ over(); phoneDrop(); if(cl.mini.hasTurns()) cl.mini.later(); else cl.mini.close(); }
    return was;
  }
  document.addEventListener('visibilitychange', () => {
    if(document.hidden && phoneLeave() === 'recording') cl.note('Recording stopped when you left the page.');
  });
  /* leaving the page for good (or into the back/forward cache): the answer stops and the microphone is released, so a restored page
     does not show Speaking or Stop for sound that is no longer playing */
  addEventListener('pagehide', () => { phoneStopSpeech(); phoneLeave(); });

  A.start = async o => {
    if(!enabled()) return;
    if(V.remote()){ phoneStart(o); return; }
    if(!V.available){ cl.note('BlitzVoice is not running.'); return; }
    if(A.phase === 'listening') return;
    const r = await V.start({ partials:true, autostop:'none', cleanup:false });
    if(!r || r.id == null) return;
    begin(r.id, (o && o.prefix) || '', !!(o && o.oneOff));
  };
  V.micAction = () => {
    if(!enabled()) return false;
    if(V.remote()){ /* a phone: Talk records, Send sends, Stop ends the answer */
      if(R.step === 'idle') phoneStart();
      else if(R.step === 'recording') phoneSend();
      else if(R.step === 'speaking' || R.step === 'preparing') phoneStopSpeech();
      return true;
    }
    if(V.link === 'recording' && A.phase === 'listening'){ sendNow(); return true; }
    if(V.link === 'recording'){ V.stop(); return true; }
    if(V.link === 'speaking'){ V.stopSpeak(); return true; }
    A.start(); return true;
  };
  V.onWake = d => { if(enabled() && A.phase !== 'listening') begin(d.id, ''); };
  V.onPartial = onPartial;
  V.onTranscript = onFinal;
  V.onWakeFinal = onFinal;
  /* the panel was closed while listening (Escape or the close mark): that cancels the question. cancelAll ends the live row first, so it never lands here too. */
  cl.mini.onLiveClosed = () => {
    if(A.phase === 'listening'){ over(); discard(); MC.sound.play('cancel'); }
    else if(A.phase === 'sending' && R.job) R.job.stop(true); /* a phone question still being uploaded: closing the panel drops it, and frees the button */
  };
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && R.step === 'starting'){ e.preventDefault(); phoneDrop(); return; } /* the microphone is still starting: drop that start */
    if(e.key !== 'Escape' || !cl.mini.isOpen()) return;
    e.preventDefault(); cl.mini.close();
  });

  /* the help in the "?" pop: what to say, with the real phrases */
  function help(){
    const pop = document.querySelector('[data-cl-help]'); if(!pop) return;
    if(V.remote()){ pop.textContent = 'Talk to ' + MC.comlinkName() + ' with this phone\'s microphone. Tap Talk, speak, then tap Send. Cancel drops the question. The answer is read aloud, and Talk stops it. The conversation lasts until you leave the page. Escape hides the panel.'; return; }
    const w = V.wakePhrase && V.wakePhrase();
    const one = v => PH.variants(v)[0] || ''; /* a setting may hold several variations: the help names the first */
    pop.textContent = 'Talk to ' + MC.comlinkName() + ', hands free. ' + (w ? 'Say "' + w + '" or press' : 'Press') + ' Talk, then speak. Say "' + one(P.sendPhrase) + '" to send, "' + one(P.rewritePhrase) + '" to clear your words and keep talking, "' + one(P.cancelPhrase) + '" to drop the question, and "' + one(P.endPhrase) + '" to end the conversation. The answer is read aloud. The conversation lasts until you end it or leave the page. Escape hides the panel.';
  }
  P.on(help); V.on(k => { if(k === 'wake') help(); });
  help(); Promise.resolve(MC.whoami).then(help);
  A.help = help;
})();

/* ---------- title bar status chips: server, runs, VRAM ----------
   Server: any message on the event stream proves it is up. When the stream goes quiet
   (it ticks every 5 s) the health endpoint is asked, and a failure shows Offline with a word.
   When the server answers again the system and run numbers are fetched afresh. */
MC.statusChips = function(){
  const bars = document.querySelectorAll('header.page .hd'); if(!bars.length) return;
  const st = { online:null, runs:null, vram:null };
  let lastMsg = 0, vramTries = 0;
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  /* Two things only: the GPU memory in use, and one server button that is both the state and the action.
     Online: green outline, check mark, "Online"; on hover it reads "Restart". Offline: red outline, "Offline";
     on hover it reads "Start". Claude runs and plan use live in the Com Link panel. */
  const SB = (cls, icon, word, hicon, hword, act, title) => `<button type="button" class="srvb ${cls}" data-mc-rs="${act}" title="${title}"><span class="sa">${icon}${word}</span><span class="sb">${hicon}${hword}</span></button>`;
  const PLAY = '<svg viewBox="0 0 10 10" width="10" height="10" style="flex:none"><path d="M3 2l5 3-5 3z" fill="currentColor"/></svg>';
  const html = () => {
    const off = st.online === false;
    let gpu = '';
    if(st.vram && !off){
      const f = st.vram.used / st.vram.total;
      /* no icon while it is fine; a warning shape only when the video memory is nearly full */
      const k = f > .9 ? 'bad' : f > .75 ? 'warn' : 'ok';
      gpu = `<a href="system.html" title="${MC.esc((st.vram.name || 'GPU') + ': ' + st.vram.used.toFixed(1) + ' of ' + Math.round(st.vram.total) + 'GB of video memory in use')}" style="display:contents"><span class="chip c-${k}">${k === 'ok' ? '' : MC.ic[k] || ''}GPU ${st.vram.used.toFixed(1)}GB</span></a>`;
    }
    return `<span data-mc-chips style="display:contents">${gpu}${serverHtml()}</span>`;
  };
  /* Restart control: Restart > inline confirm > Restarting (polls health) > reload. Words carry the meaning, not color. */
  const rs = { s:'idle', info:null, msg:'' };
  const RB = 'font:600 11.5px var(--sans);letter-spacing:.02em;padding:2px 9px;line-height:1.5;border-radius:1px;background:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;';
  const RICON = '<svg viewBox="0 0 10 10" width="10" height="10" style="flex:none"><path d="M8.5 5A3.5 3.5 0 1 1 7.4 2.4M8.5 1V3.2H6.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  /* a phone may see the state but never restart: decided only once MC.whoami has answered */
  const phone = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  const serverHtml = () => {
    if(phone() && rs.s !== 'restarting'){
      if(st.online === null) return MC.chip('idle', 'Server…');
      return st.online === false ? MC.chip('bad', 'Offline') : MC.chip('ok', 'Online');
    }
    if(rs.s === 'hint') return `<span class="chip c-idle" style="color:var(--white);border-style:solid;border-color:var(--line)" role="status">Double-click Mission Control on your desktop to start it</span><button type="button" data-mc-rs="ok" style="${RB}color:var(--w2);border:1px solid var(--line-2)">OK</button>`;
    if(rs.s === 'idle'){
      if(st.online === null) return MC.chip('idle', 'Server…');
      return st.online === false
        ? SB('off', MC.ic.bad || '', 'Offline', PLAY, 'Start', 'start', 'The Mission Control server is not answering')
        : SB('on', MC.ic.ok || '', 'Online', RICON, 'Restart', 'ask', 'The Mission Control server is running. Click to restart it.');
    }
    if(rs.s === 'restarting') return `<span class="chip c-live" role="status">${RICON}Restarting</span>`;
    if(rs.s === 'failed') return `<span class="chip c-bad" role="alert">${MC.ic.warn}${MC.esc(rs.msg)}</span><button type="button" data-mc-rs="ok" style="${RB}color:var(--w2);border:1px solid var(--line-2)">Dismiss</button>`;
    if(rs.s === 'confirm'){
      const i = rs.info, n = i ? i.runs + i.jobs : 0;
      const warn = n ? ' This stops ' + [i.runs ? i.runs + (i.runs === 1 ? ' Claude run' : ' Claude runs') : '', i.jobs ? i.jobs + (i.jobs === 1 ? ' job' : ' jobs') : ''].filter(Boolean).join(' and ') + '.' : '';
      return `<span class="chip c-idle" style="color:var(--white);border-style:solid;border-color:var(--line)" role="alertdialog">Restart the server?${warn}</span><button type="button" data-mc-rs="yes" style="${RB}color:#0a1019;background:var(--white);border:1px solid var(--white)">Restart now</button><button type="button" data-mc-rs="no" style="${RB}color:var(--w2);border:1px solid var(--line-2)">Cancel</button>`;
    }
    return '';
  };
  const waitForServer = () => {
    const t0 = Date.now(); let down = false;
    const tick = () => {
      if(Date.now() - t0 > 60000){ rs.s = 'failed'; rs.msg = 'Server did not come back. Look at the Mission Control server window.'; paintChips(); return; }
      const c = new AbortController(), t = setTimeout(() => c.abort(), 1500);
      fetch('/api/health', { signal:c.signal, cache:'no-store' })
        .then(r => { if(r.ok && (down || Date.now() - t0 > 5000)) location.reload(); else setTimeout(tick, 500); })
        .catch(() => { down = true; setTimeout(tick, 500); })
        .finally(() => clearTimeout(t));
    };
    setTimeout(tick, 500);
  };
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-mc-rs]'); if(!b) return;
    const a = b.getAttribute('data-mc-rs');
    if(phone() && a !== 'ok' && a !== 'no') return;
    if(a === 'ask'){
      rs.s = 'confirm'; rs.info = null; paintChips();
      MC.api.get('/api/server/restart-info').then(d => { rs.info = d; paintChips(); }).catch(() => {});
    } else if(a === 'start'){ rs.s = 'hint'; paintChips(); } /* the page cannot start a server that is not running */
    else if(a === 'no' || a === 'ok'){ rs.s = 'idle'; paintChips(); }
    else if(a === 'yes'){
      rs.s = 'restarting'; paintChips();
      MC.api.post('/api/server/restart', { confirm:true })
        .then(waitForServer)
        .catch(err => { rs.s = 'failed'; rs.msg = (err && err.message) || 'Restart failed'; paintChips(); });
    }
  });
  bars.forEach(hd => {
    let hs = hd.querySelector('.hstat');
    if(!hs){ hs = document.createElement('div'); hs.className = 'hstat'; const clock = hd.querySelector('.clock'); if(clock){ clock.before(hs); hs.appendChild(clock); } else hd.appendChild(hs); }
    Array.from(hs.children).forEach(c => { if(!c.classList.contains('clock') && !c.hasAttribute('data-keep')) c.remove(); });
    const box = document.createElement('span'); box.style.display = 'contents'; box.setAttribute('data-mc-chipbox',''); hs.prepend(box);
  });
  let lastHtml = '';
  const paintChips = () => { const h = html(); if(h === lastHtml) return; lastHtml = h; document.querySelectorAll('[data-mc-chipbox]').forEach(b => b.innerHTML = h); };
  const setVram = g => {
    const used = g && num(g.vramUsedGB), total = g && num(g.vramTotalGB);
    if(used !== null && total) st.vram = { used, total, name:g.name };
  };
  const loadSystem = () => MC.api.get('/api/system').then(d => { setVram(d && d.gpu); paintChips(); }).catch(() => {});
  const seen = () => {
    lastMsg = Date.now();
    if(st.online === true) return;
    const wasOff = st.online === false;
    st.online = true; if(rs.s === 'hint') rs.s = 'idle'; paintChips();
    if(wasOff){ loadSystem(); MC.comlink.refreshRuns(true); }
  };
  MC.events.on('*', seen);
  MC.events.on('system.tick', d => { setVram(d && d.gpu); paintChips(); });
  MC.comlink.onRunning(n => { st.runs = n; paintChips(); });
  const ping = () => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
    return fetch('/api/health', { signal:c.signal, cache:'no-store' })
      .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); seen(); })
      .catch(() => { if(st.online !== false){ st.online = false; paintChips(); } })
      .finally(() => clearTimeout(t));
  };
  loadSystem();
  /* a system.tick may be slow to arrive; ask for the GPU a few more times until it is known */
  setInterval(() => { if(!st.vram && st.online && vramTries++ < 6) loadSystem(); }, 10000);
  MC.comlink.refreshRuns(true);
  ping(); setInterval(() => { if(Date.now() - lastMsg > 7000) ping(); }, 3000);
  paintChips();
  Promise.resolve(MC.whoami).then(() => { if(phone() && rs.s !== 'idle'){ rs.s = 'idle'; } paintChips(); });
};
/* background layers: Grain, Dust and Grid are independent toggles, kept per browser.
   API: MC.bg.has('grain'|'dust'|'grid'), MC.bg.mode() (old callers), MC.bg.skipDust, and a 'mc:bg' window event with detail {grain, dust, grid} on every change. */
(function(){
  const KEYS = ['grain','dust','grid'], LABELS = {grain:'Grain', dust:'Dust', grid:'Grid'};
  const OLD = [[], ['grain'], ['dust'], ['grid'], KEYS]; /* the old single-choice indexes: Plain, Grain, Dust, Grid, All */
  const fromNames = list => ({grain:list.indexOf('grain') >= 0, dust:list.indexOf('dust') >= 0, grid:list.indexOf('grid') >= 0});
  const st = fromNames(['dust']);
  function load(){
    try {
      const j = localStorage.getItem('mc-bg2');
      if(j !== null){ const o = JSON.parse(j); KEYS.forEach(k => st[k] = !!(o && o[k])); return; }
      const v = localStorage.getItem('mc-bg'); /* migrate the old single choice */
      if(v !== null){
        const t = String(v).toLowerCase();
        if(t === 'all') Object.assign(st, fromNames(KEYS));
        else if(t === 'plain') Object.assign(st, fromNames([]));
        else if(KEYS.indexOf(t) >= 0) Object.assign(st, fromNames([t]));
        else if(/^\d$/.test(t) && +t < OLD.length) Object.assign(st, fromNames(OLD[+t]));
      }
    } catch(e){}
  }
  load();
  const hm = location.hash.match(/bg=(\d)/); if(hm && +hm[1] < OLD.length) Object.assign(st, fromNames(OLD[+hm[1]]));
  MC.bg = function(){
    if(!document.getElementById('bgfx2-style')){
      const css = document.createElement('style'); css.id = 'bgfx2-style';
      /* hover grid: twice the radius, half the line opacity of the original (360px, .07) */
      css.textContent = '.spot{background-image:linear-gradient(rgba(220,231,243,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(220,231,243,.035) 1px,transparent 1px);-webkit-mask-image:radial-gradient(720px circle at var(--mx,50%) var(--my,50%),#000 0%,rgba(0,0,0,.45) 50%,transparent 100%);mask-image:radial-gradient(720px circle at var(--mx,50%) var(--my,50%),#000 0%,rgba(0,0,0,.45) 50%,transparent 100%)}';
      document.head.appendChild(css);
    }
    const cv = document.createElement('canvas'); cv.id = 'bgfx2'; document.body.prepend(cv);
    const spot = document.createElement('div'); spot.className = 'spot'; document.body.prepend(spot);
    addEventListener('pointermove', e => { spot.style.setProperty('--mx', e.clientX + 'px'); spot.style.setProperty('--my', e.clientY + 'px'); });
    const sw = document.createElement('div'); sw.className = 'bgswitch'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Background layers');
    sw.innerHTML = '<span>BG</span>' + KEYS.map(k => '<button type="button" role="switch" data-k="' + k + '">' + LABELS[k] + '</button>').join('') + '<button type="button" role="switch" class="bgview" data-view="office" title="Plain panels instead of the 3D scenes, in this browser">Office</button>';
    document.body.appendChild(sw);
    /* only Home and the project page show the switch (it covered panels on the full-height pages); the layers still apply everywhere */
    if(!/^\/(index\.html|project\.html)?$/.test(location.pathname)) sw.style.display = 'none';
    const ob = sw.querySelector('.bgview');
    if(MC.view){ const on = !!MC.view.office; ob.classList.toggle('on', on); ob.setAttribute('aria-checked', on ? 'true' : 'false'); ob.onclick = () => MC.view.set(on ? 'space' : 'office'); }
    else ob.remove();
    const dust = Array.from({length:180}, () => ({x:Math.random(), y:Math.random(), z:.3+Math.random()*.7, s:Math.random()*6.28}));
    /* grain alpha ceiling 9.75 of 255 (was 6.5, so 50% more opaque) */
    function makeGrain(){ const g = document.createElement('canvas'); g.width = g.height = 160; const x = g.getContext('2d'), d = x.createImageData(160,160); for(let i=0;i<d.data.length;i+=4){ const v = Math.random()*255; d.data[i]=d.data[i+1]=d.data[i+2]=v; d.data[i+3]=Math.random()*9.75; } x.putImageData(d,0,0); return g; }
    const grainEl = document.createElement('div'); grainEl.className = 'grain'; grainEl.style.backgroundImage = 'url(' + makeGrain().toDataURL() + ')'; document.body.prepend(grainEl);
    function paint(){
      sw.querySelectorAll('button[data-k]').forEach(b => { const on = st[b.dataset.k]; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.title = LABELS[b.dataset.k] + (on ? ': on' : ': off'); });
      spot.classList.toggle('on', st.grid); grainEl.classList.toggle('on', st.grain);
    }
    function toggle(k){
      st[k] = !st[k]; try{ localStorage.setItem('mc-bg2', JSON.stringify(st)); }catch(e){}
      paint(); window.dispatchEvent(new CustomEvent('mc:bg', {detail:{grain:st.grain, dust:st.dust, grid:st.grid}}));
    }
    sw.querySelectorAll('button[data-k]').forEach(b => b.onclick = () => toggle(b.dataset.k));
    paint();
    (function draw(now){
      const [x,w,h] = MC.fit(cv); x.clearRect(0,0,w,h);
      const dk = matchMedia('(max-width:560px)').matches ? .5 : 1; /* a phone: half the dot radius */
      if(st.dust && !MC.bg.skipDust){ /* skipDust: a page that draws its own 3D dust (Home) turns the flat layer off */
        dust.forEach(p => { if(!MC.reduce){ p.x += .00004*p.z; p.y -= .00006*p.z; p.s += .01; if(p.y < -.02){ p.y = 1.02; p.x = Math.random(); } if(p.x > 1.02) p.x = -.02; }
          const a = (.12 + .25*p.z) * (.6 + .4*Math.sin(p.s)); x.fillStyle = 'rgba(200,220,245,' + a + ')'; x.beginPath(); x.arc(p.x*w, p.y*h, (.6 + p.z*1.4)*dk, 0, 7); x.fill(); });
      }
      requestAnimationFrame(draw);
    })(0);
  };
  MC.bg.has = name => !!st[name];
  MC.bg.mode = () => { const n = KEYS.filter(k => st[k]); return n.length === 3 ? 'all' : n.length === 0 ? 'plain' : n.length === 1 ? n[0] : 'mixed'; };
})();

/* ---------- scroll fades: every scroll box fades softly where more content waits ----------
   Finds elements with overflow-y auto or scroll whose content is taller than the box, now and later
   (MutationObserver plus ResizeObserver, throttled), and sets classes that drive a CSS mask in redline.css:
   mc-fx-t when scrolled down (fade at the top), mc-fx-b when more is below (fade at the bottom).
   Skips text fields, the page itself and anything inside [data-nofade]. A sticky header at the top of a box keeps its
   full strength: the top fade starts below it (--fx-in). Scrolling costs one passive capture listener and one rAF.
   API: MC.fades.refresh(), MC.fades.enabled (set false to clear every fade). */
MC.fades = (function(){
  const F = { enabled:true };
  const SLACK = 2, MIN_H = 64;
  const SEL = 'div,section,aside,main,ul,ol,pre,article,nav,form,table,dl,tbody,details,fieldset';
  const TAGS = new Set(SEL.split(','));
  const cands = new Map(); /* element -> {t, b, inset, sh, timer} */
  const added = new Set(), touched = new Set(), dirty = new Set();
  let timer = 0, raf = 0, started = false, mo = null, ro = null;

  const scrolls = el => { const o = getComputedStyle(el).overflowY; return o === 'auto' || o === 'scroll' || o === 'overlay'; };
  const allowed = el => !el.closest('[data-nofade]');

  /* the bottom edge of a sticky header stuck to the top of this box, looked for in the first few levels only */
  function insetOf(el){
    let best = 0, seen = 0;
    const look = (node, depth) => {
      const kids = node.children, lim = depth === 0 ? 8 : depth === 1 ? 4 : 3;
      for(let i = 0; i < kids.length && i < lim; i++){
        const k = kids[i]; if(++seen > 140) return;
        const cs = getComputedStyle(k);
        if(cs.position === 'sticky'){ const top = parseFloat(cs.top); if(isFinite(top)) best = Math.max(best, top + k.offsetHeight); }
        if(depth < 2) look(k, depth + 1);
      }
    };
    look(el, 0);
    const th = el.querySelector('thead th');
    if(th){ const cs = getComputedStyle(th); if(cs.position === 'sticky'){ const top = parseFloat(cs.top); if(isFinite(top)) best = Math.max(best, top + th.offsetHeight); } }
    return Math.max(0, Math.min(Math.round(best), el.clientHeight / 2));
  }

  function drop(el){
    const st = cands.get(el); if(!st) return;
    clearTimeout(st.timer); cands.delete(el); if(ro) ro.unobserve(el);
    el.classList.remove('mc-fx', 'mc-fx-t', 'mc-fx-b'); el.style.removeProperty('--fx-in');
  }
  function consider(el){
    if(!el || el.nodeType !== 1 || !TAGS.has(el.localName)) return;
    if(cands.has(el)){ if(!scrolls(el) || !allowed(el)) drop(el); return; }
    if(!scrolls(el) || !allowed(el)) return;
    cands.set(el, { t:false, b:false, inset:-1, sh:-1, timer:0 });
    if(ro) ro.observe(el);
  }
  function scan(root){
    if(root.nodeType !== 1) return;
    consider(root);
    const list = root.querySelectorAll(SEL);
    for(let i = 0; i < list.length; i++) consider(list[i]);
  }

  /* work out the two flags for one box and write them */
  function measure(el, st, structural){
    const ch = el.clientHeight, sh = el.scrollHeight, over = sh - ch;
    const ok = F.enabled && ch >= MIN_H && over > 10;
    const t = ok && el.scrollTop > SLACK, b = ok && over - el.scrollTop > SLACK;
    if(ok && (structural || st.inset < 0 || st.sh !== sh)){
      const ins = insetOf(el);
      if(ins !== st.inset){ st.inset = ins; el.style.setProperty('--fx-in', ins + 'px'); }
      st.sh = sh;
    }
    if(t === st.t && b === st.b) return;
    st.t = t; st.b = b;
    el.classList.toggle('mc-fx-t', t); el.classList.toggle('mc-fx-b', b);
    clearTimeout(st.timer); st.timer = 0;
    if(t || b) el.classList.add('mc-fx');
    else st.timer = setTimeout(() => { st.timer = 0; if(!st.t && !st.b) el.classList.remove('mc-fx'); }, 320); /* after the fade-out transition */
  }

  function take(recs){
    for(const r of recs){
      if(r.type === 'childList'){ r.addedNodes.forEach(n => { if(n.nodeType === 1) added.add(n); }); }
      else if(r.target.nodeType === 1) touched.add(r.target);
    }
  }
  /* one pass: new elements, changed elements, then every known box measured. Our own class and style writes are discarded afterwards. */
  function run(full){
    timer = 0;
    take(mo.takeRecords());
    if(!F.enabled){ cands.forEach((st, el) => { st.t = st.b = false; el.classList.remove('mc-fx', 'mc-fx-t', 'mc-fx-b'); }); added.clear(); touched.clear(); mo.takeRecords(); return; }
    if(full === true){ added.clear(); touched.clear(); scan(document.body); }
    else {
      added.forEach(n => { if(n.isConnected) scan(n); }); added.clear();
      touched.forEach(n => { if(n.isConnected) consider(n); }); touched.clear();
    }
    cands.forEach((st, el) => { if(!el.isConnected) drop(el); else measure(el, st, full === true); });
    mo.takeRecords();
  }
  const later = () => { if(!timer) timer = setTimeout(run, 140); };

  function flush(){
    raf = 0;
    dirty.forEach(el => { const st = cands.get(el); if(st) measure(el, st, false); });
    dirty.clear();
    mo.takeRecords();
  }

  F.refresh = () => { clearTimeout(timer); run(true); };
  F.start = function(){
    if(started) return; started = true;
    mo = new MutationObserver(recs => { take(recs); later(); });
    ro = new ResizeObserver(later);
    mo.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'style', 'hidden', 'open'] });
    document.addEventListener('scroll', e => {
      const el = e.target; if(!cands.has(el)) return;
      dirty.add(el); if(!raf) raf = requestAnimationFrame(flush);
    }, { capture:true, passive:true });
    addEventListener('resize', later);
    addEventListener('load', later);
    if(document.fonts && document.fonts.ready) document.fonts.ready.then(later);
    run(true);
  };
  return F;
})();

/* ---------- the project card: shown when pointing at a planet on Home or a dot in the title bar ----------
   One card for both. It opens next to what it describes and stays there (it never follows the pointer), so its buttons can be
   reached: the project's dev run jobs, Open app for an installed program (PC only), and Project page. Leaving the
   planet or dot hides it after a moment unless the pointer is on the card. A run that needs a question first (sends something
   off this PC, or opens its own window) goes to the project page, which asks it there.
   API: MC.pcard.show(project, anchorRect, {below, area}), hideSoon(), hide(), held() (the pointer is on the card), current(). */
MC.SUN = 'mission-control'; /* the project drawn as the sun on Home and in the title bar */
/* a run job's short name for small buttons: "Run dev" is Dev, "Run game" is Game */
/* (a dev run that would also read "App" keeps its full name, so it is never confused with the installed app's button) */
MC.shortJob = l => { const s = String(l || '').replace(/^(run|start|launch)\s+/i, '').trim(); return !s || /^app$/i.test(s) ? String(l || '') : s[0].toUpperCase() + s.slice(1); };
MC.pcard = (function(){
  const W = 290;
  let el = null, cur = null, over = false, hideT = 0, noteT = 0;
  const ago = iso => { const t = Date.parse(iso); if(!t) return 'unknown'; const h = (Date.now()-t)/36e5; if(h < 1) return Math.max(1, Math.round(h*60)) + ' min ago'; if(h < 48) return Math.round(h) + 'h ago'; if(h < 24*14) return Math.round(h/24) + 'd ago'; return Math.round(h/24/7) + 'w ago'; };
  /* the server decides (needsYou, needsReasons); the same rule here only covers an older server */
  function reasons(p){
    if(Array.isArray(p.needsReasons)) return p.needsReasons;
    const why = [];
    if(p.dirty > 0) why.push(p.dirty + ' uncommitted change' + (p.dirty > 1 ? 's' : ''));
    if(p.ahead > 0) why.push(p.ahead + ' commit' + (p.ahead > 1 ? 's' : '') + ' not pushed');
    if(p.build === 'stale') why.push('build stale');
    return why;
  }
  const needs = p => typeof p.needsYou === 'boolean' ? p.needsYou : reasons(p).length > 0;
  const phone = () => document.documentElement.hasAttribute('data-remote') || MC.remote === true;
  const devJobs = p => (p.jobs || []).filter(j => j.visible !== false && j.kind === 'run-dev').sort((a, b) => (a.order || 0) - (b.order || 0));
  const appCheck = p => (p.checks || []).find(c => c.launch && c.launch.available && c.launch.installed);
  function build(){
    if(el) return el;
    el = document.createElement('div'); el.className = 'hcard pcard';
    el.innerHTML = '<div class="fr"><div class="ttl"><h3></h3></div><div class="bodyc"></div><div class="pacts"></div><div class="pnote" role="status"></div></div>';
    el.addEventListener('mouseenter', () => { over = true; clearTimeout(hideT); });
    el.addEventListener('mouseleave', () => { over = false; hideSoon(); });
    el.addEventListener('focusin', () => { over = true; clearTimeout(hideT); });
    el.addEventListener('focusout', e => { if(!el.contains(e.relatedTarget)){ over = false; hideSoon(); } });
    el.addEventListener('click', act);
    document.body.appendChild(el);
    return el;
  }
  function note(t){ const n = el && el.querySelector('.pnote'); if(!n) return; n.textContent = t || ''; clearTimeout(noteT); if(t) noteT = setTimeout(() => { n.textContent = ''; }, 5000); }
  function fill(p){
    const why = reasons(p);
    const git = p.dirty ? MC.chip('warn', p.dirty + ' uncommitted') : MC.chip('ok', 'Clean');
    const bw = p.build === 'fresh' ? MC.chip('ok', 'fresh') : p.build === 'stale' ? MC.chip('warn', 'stale') : '<span class="chip">unknown</span>';
    const also = (p.attention || []).map(x => x.label).join(', ');
    const sync = (p.ahead > 0 ? p.ahead + ' ahead' : '') + (p.ahead > 0 && p.behind > 0 ? ', ' : '') + (p.behind > 0 ? p.behind + ' behind' : '');
    el.querySelector('h3').textContent = p.name || p.id;
    el.querySelector('.bodyc').innerHTML = (p.about ? '<div class="desc">' + MC.esc(p.about) + '</div>' : '') + '<dl class="kv">' + (why.length ? '<dt>Needs you</dt><dd>' + MC.esc(why.join(', ')) + '</dd>' : '')
      + '<dt>Branch</dt><dd>' + MC.esc(p.branch || 'none') + (sync ? ', ' + sync : '') + '</dd><dt>Git</dt><dd>' + git + '</dd>'
      + '<dt>Build</dt><dd>' + bw + (also ? '<div class="alsoold">Also older: ' + MC.esc(also) + '</div>' : '') + '</dd>'
      + '<dt>Last work</dt><dd>' + (p.lastCommit ? '<span class="lw" title="' + MC.esc(p.lastCommit.subject) + '">' + ago(p.lastCommit.date) + ', ' + MC.esc(p.lastCommit.subject) + '</span>' : 'no commits') + '</dd>' + (p.server ? '<dt>Server</dt><dd>' + MC.esc(p.server) + '</dd>' : '') + '</dl>';
    el.querySelector('.pacts').innerHTML = actsHtml(p);
    note('');
  }
  /* the launch row: each dev run (Dev, Game) and the installed app (App), short names with the full one in the tooltip */
  function actsHtml(p, extra){
    const app = appCheck(p);
    return devJobs(p).map(j => '<button type="button" class="act" data-pc-job="' + MC.esc(j.id) + '" title="' + MC.esc(j.label + ': runs ' + (j.file || j.label)) + '">' + MC.esc(MC.shortJob(j.label)) + '</button>').join('')
      + (app && !phone() ? '<button type="button" class="act" data-pc-app="' + MC.esc(app.key) + '" title="' + MC.esc(app.launch.label || 'Open the app') + '">App</button>' : '')
      + (extra || '');
  }
  function act(e){ if(cur) run(cur, e.target.closest('button[data-pc-job],button[data-pc-app]'), note); }
  /* a click on one of those buttons, for project p (b: the button, say: where to write a short note) */
  async function run(p, b, say){
    if(!b || b.disabled) return;
    say = say || (() => {});
    const page = 'project.html?id=' + encodeURIComponent(p.id), note = say;
    if(b.dataset.pcApp){
      b.disabled = true; note('Opening...');
      try { await MC.api.post('/api/projects/' + encodeURIComponent(p.id) + '/checks/' + encodeURIComponent(b.dataset.pcApp) + '/launch', {}); note('Opened.'); }
      catch(err){ note('Could not open it: ' + (err.message || 'refused')); }
      b.disabled = false; return;
    }
    const j = (p.jobs || []).find(x => x.id === b.dataset.pcJob); if(!j) return;
    if(j.outward || j.interactive){ location.href = page + '#run=' + encodeURIComponent(j.id); return; } /* the project page asks first */
    b.disabled = true; note('Starting ' + j.label + '...');
    try {
      const res = await fetch('/api/projects/' + encodeURIComponent(p.id) + '/jobs/' + encodeURIComponent(j.id) + '/run', { method:'POST', headers:{ 'X-MC':'1', 'Content-Type':'application/json' }, body:'{}' });
      let d = {}; try { d = await res.json(); } catch(x){}
      if(res.ok && d.runId) note(d.mode === 'window' ? 'Opened in its own window.' : 'Started. The log is on the project page.');
      else if(res.status === 409 && d.needsConfirm){ location.href = page + '#run=' + encodeURIComponent(j.id); return; }
      else if(res.status === 409 && d.runId) note('Already running.');
      else note(d.error || 'The server answered ' + res.status + '.');
    } catch(err){ note('Could not reach Mission Control.'); }
    b.disabled = false;
  }
  /* anchor: the planet or dot (a DOMRect). below: centered under it (title bar dots); otherwise to its right, or left when there is
     no room. area: {l, t, r, b} the card must stay inside (Home keeps it in the free middle, off the docked panels). */
  function show(p, anchor, opt){
    opt = opt || {}; clearTimeout(hideT);
    build();
    if(cur && cur.id === p.id && el.classList.contains('show')) return; /* already open for it: it stays where it is */
    cur = p; fill(p);
    const A = opt.area || { l:0, t:0, r:innerWidth, b:innerHeight }, H = el.offsetHeight || 260;
    let x, y;
    if(opt.below){ x = anchor.left + anchor.width / 2 - W / 2; y = anchor.bottom + 10; if(y + H > A.b - 8) y = Math.max(A.t + 8, anchor.top - H - 10); }
    else { x = anchor.right + 10; if(x + W > A.r - 8) x = anchor.left - W - 10; y = anchor.top + anchor.height / 2 - 40; }
    x = Math.max(A.l + 8, Math.min(x, A.r - W - 8)); y = Math.max(A.t + 8, Math.min(y, A.b - H - 8));
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
    el.classList.add('show'); MC.drawFrames();
  }
  function hide(){ clearTimeout(hideT); over = false; if(el){ el.classList.remove('show'); if(el.contains(document.activeElement)) document.activeElement.blur(); } cur = null; }
  function hideSoon(ms){ clearTimeout(hideT); hideT = setTimeout(() => { if(!over) hide(); }, ms == null ? 260 : ms); }
  addEventListener('resize', hide);
  return { show, hide, hideSoon, held: () => !!cur && over, current: () => cur, needs, reasons, actsHtml, run };
})();

/* ---------- project strip in the title bar: a 1D solar system ----------
   A sun dot, then one dot per project in ring order (nearest the sun first, from /api/layout; by name if there is no layout).
   Red means the project needs you. The current project has a ring. Hover or focus shows the Home hover card; click opens the project. */
MC.projectStrip = function(){
  if(MC.projectStrip.started) return;
  const hds = Array.from(document.querySelectorAll('header.page .hd')); if(!hds.length) return;
  MC.projectStrip.started = true;
  const cur = /project\.html$/.test(location.pathname) ? new URLSearchParams(location.search).get('id') : null;
  const navs = [], data = new Map();
  let sig = null, layoutP = null, timer = 0, seq = 0, tries = 0;
  const needs = MC.pcard.needs;
  const loadLayout = () => {
    if(!layoutP) layoutP = MC.api.get('/api/layout').then(d => { const r = d && Array.isArray(d.rings) ? d.rings : null; if(!r) layoutP = null; return r; }).catch(() => { layoutP = null; return null; });
    return layoutP;
  };
  const anchorOf = hd => { let at = hd.querySelector('.hstat'); while(at && at.parentElement !== hd) at = at.parentElement; return at; };

  function makeNav(hd){
    const nav = document.createElement('nav'); nav.className = 'pstrip'; nav.setAttribute('aria-label', 'Projects'); nav.hidden = true;
    /* the sun is Mission Control itself, as on Home */
    nav.innerHTML = '<a class="psun" href="project.html?id=' + encodeURIComponent(MC.SUN) + '" data-id="' + MC.esc(MC.SUN) + '" aria-label="Mission Control"></a><span class="pdots"></span>';
    const sun = nav.querySelector('.psun');
    sun.addEventListener('mouseenter', () => show(sun)); sun.addEventListener('mouseleave', hide);
    sun.addEventListener('focus', () => show(sun)); sun.addEventListener('blur', hide);
    const at = anchorOf(hd); if(at) hd.insertBefore(nav, at); else hd.appendChild(nav);
    return nav;
  }

  const show = a => { const p = data.get(a.dataset.id); if(p) MC.pcard.show(p, a.getBoundingClientRect(), { below:true }); };
  const hide = () => MC.pcard.hideSoon();

  let ringOf = () => 1e9;
  function paint(all){
    const sunP = all.find(p => p.id === MC.SUN), list = all.filter(p => p.id !== MC.SUN);
    const dots = list.map(p => {
      const n = needs(p), here = p.id === cur;
      return '<a class="pd' + (n ? ' is-need' : '') + (here ? ' is-cur' : '') + '" href="project.html?id=' + encodeURIComponent(p.id) + '" data-id="' + MC.esc(p.id) + '" data-ring="' + (ringOf(p) < 1e9 ? ringOf(p) : '') + '"' + (here ? ' aria-current="page"' : '')
        + ' aria-label="' + MC.esc((here ? 'Current project: ' : '') + (p.name || p.id) + (n ? ', needs you' : '')) + '">' + (here ? '<canvas class="pplanet" width="22" height="22" aria-hidden="true" data-need="' + (n ? 1 : 0) + '"></canvas>' : '<i></i>') + '</a>';
    }).join('');
    navs.forEach((nav, k) => {
      if(!nav.isConnected){ const hd = hds[k]; if(hd && hd.isConnected){ const at = anchorOf(hd); if(at) hd.insertBefore(nav, at); else hd.appendChild(nav); } }
      nav.hidden = !all.length; nav.classList.toggle('has-planet', list.some(p => p.id === cur));
      const sun = nav.querySelector('.psun'), sn = !!sunP && needs(sunP), here = cur === MC.SUN;
      sun.classList.toggle('is-need', sn); sun.classList.toggle('is-cur', here);
      if(here) sun.setAttribute('aria-current', 'page'); else sun.removeAttribute('aria-current');
      sun.setAttribute('aria-label', (here ? 'Current project: ' : '') + 'Mission Control' + (sn ? ', needs you' : ''));
      nav.querySelector('.pdots').innerHTML = dots; nav.style.setProperty('--n', list.length); nav.dataset.n = list.length;
      nav.querySelectorAll('.pd').forEach(a => {
        a.addEventListener('mouseenter', () => show(a)); a.addEventListener('mouseleave', hide);
        a.addEventListener('focus', () => show(a)); a.addEventListener('blur', hide);
      });
    });
  }

  /* the current project is a small wireframe planet (same lines as Home), turning slowly; one loop draws every copy */
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SZ = 22, dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1)), cam = MC.cam(0, .42, 1, SZ / 2, SZ / 2, 400);
  let spinRaf = 0, lastDraw = 0;
  function drawPlanets(now){
    document.querySelectorAll('canvas.pplanet').forEach(cv => {
      if(cv.width !== SZ * dpr){ cv.width = SZ * dpr; cv.height = SZ * dpr; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, SZ, SZ); g.lineCap = 'round';
      MC.wireSphere(g, cam, 0, 0, 0, 8.6, still ? .6 : now * .0004, cv.dataset.need === '1' ? 'rgba(239,106,92,.95)' : 'rgba(226,233,240,.85)', {lat:5, lon:6, seg:18, lw:1});
    });
  }
  function spin(now){
    spinRaf = 0;
    if(!document.querySelector('canvas.pplanet')) return;
    if(!document.hidden && now - lastDraw > 33){ lastDraw = now; drawPlanets(now); }
    if(!still && !document.hidden) spinRaf = requestAnimationFrame(spin);
  }
  const startSpin = () => { if(!spinRaf) spinRaf = requestAnimationFrame(spin); };
  document.addEventListener('visibilitychange', startSpin);

  async function render(){
    const my = ++seq;
    layoutP = null; /* ask again every time: the layout changes while the page is open */
    const [ps, rings] = await Promise.all([MC.projectList(), loadLayout()]);
    if(my !== seq) return;
    const list = ps.filter(p => p.exists !== false);
    if(!list.length && tries++ < 12) timer = setTimeout(render, 3000); /* server not ready or offline: ask again shortly */
    else if(list.length) tries = 0;
    const ring = new Map((rings || []).map(r => [r.id, +r.ring]));
    const rk = p => ring.has(p.id) && isFinite(ring.get(p.id)) ? ring.get(p.id) : 1e9;
    ringOf = rk;
    list.sort((a, b) => rk(a) - rk(b) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    data.clear(); list.forEach(p => data.set(p.id, p));
    const s = list.map(p => p.id + (needs(p) ? '!' : '')).join('|');
    if(s === sig && navs.every(n => n.isConnected)) return; /* nothing visible changed: keep the dots (and any hover) as they are */
    sig = s; paint(list); fitLater(); if(cur) startSpin();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(render, 150); };

  /* the strip is a flexible element: it takes whatever the title bar has left between the title block and the status chips, and
     hides when that is under MIN px. Dots sit at their ring distance from the sun (a real 1D projection): the gap before a dot is
     1 unit plus half a unit per ring skipped, so inner rings are close to the sun and far rings far right. Gaps are scaled to the
     width; if that would put two dots closer than GAP px, the dots are spread evenly instead. */
  const MIN = 160, WANT = 190, GAP = 16, EDGE = 14;
  function place(nav){
    const box = nav.querySelector('.pdots'), ds = Array.from(box.children), W = box.clientWidth;
    if(!ds.length || !W) return;
    const rs = ds.map(d => d.dataset.ring === '' ? NaN : +d.dataset.ring);
    let u = [], acc = 0, prev = 0;
    rs.forEach((r, i) => { const dr = isFinite(r) ? Math.max(0, r - prev) : 0; if(isFinite(r)) prev = r; acc += 1 + .5 * dr; u.push(acc); });
    const span = Math.max(1, W - EDGE * 2), step = i => u[i] - (i ? u[i-1] : 0);
    const scale = span / acc;
    const spaced = ds.every((d, i) => step(i) * scale >= GAP);
    ds.forEach((d, i) => { d.style.left = (EDGE + (spaced ? u[i] * scale : (i + 1) * span / ds.length)).toFixed(1) + 'px'; });
  }
  let fitT = 0;
  function fit(){
    navs.forEach(nav => {
      const hd = nav.parentElement; if(!hd || nav.hidden) return;
      nav.classList.remove('off'); hd.classList.remove('mc-t1', 'mc-t2');
      let w = nav.getBoundingClientRect().width;
      /* tight: first drop the "Plan use" chip, then shorten the chip labels, before giving up the strip */
      if(w < WANT){ hd.classList.add('mc-t1'); w = nav.getBoundingClientRect().width; }
      if(w < WANT){ hd.classList.add('mc-t2'); w = nav.getBoundingClientRect().width; }
      nav.classList.toggle('off', w < MIN);
      if(w >= MIN) place(nav);
    });
  }
  const fitLater = () => { clearTimeout(fitT); fitT = setTimeout(fit, 30); };
  hds.forEach(hd => navs.push(makeNav(hd)));
  /* watch the title bar's children too: the status chips change width without the bar itself changing size */
  if(window.ResizeObserver) hds.forEach(hd => { const ro = new ResizeObserver(fitLater); ro.observe(hd); Array.from(hd.children).forEach(k => { if(!k.classList.contains('pstrip')) ro.observe(k); }); });
  addEventListener('resize', fitLater);
  setTimeout(fitLater, 1500); setTimeout(fitLater, 5000); setTimeout(fitLater, 12000); /* the status chips arrive a little after the page */
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(fitLater);
  document.addEventListener('keydown', e => { if(e.key === 'Escape') MC.pcard.hide(); });
  MC.events.on('projects.changed', later);
  MC.events.on('layout.changed', later);
  render();
};

/* ---------- number boxes: two small triangles instead of the system spin box ----------
   Every input[type=number] on the page, now or added later, gets a wrapper with an up and a down triangle (the CSS hides the
   system one). They step like the keyboard arrows (stepUp and stepDown keep min, max and step) and tell the page with input and
   change events. They are left out of the Tab order: the arrow keys already step a focused box. */
MC.numberArrows = (function(){
  const TRI = d => '<svg viewBox="0 0 8 5" aria-hidden="true"><path d="' + (d > 0 ? 'M0 5 L4 0 L8 5Z' : 'M0 0 L4 5 L8 0Z') + '" fill="currentColor"/></svg>';
  function wrap(root){
    (root || document).querySelectorAll('input[type=number]:not([data-arrows])').forEach(inp => {
      inp.setAttribute('data-arrows', '');
      const w = document.createElement('span'); w.className = 'numw';
      inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
      w.insertAdjacentHTML('beforeend', '<span class="numa"><button type="button" tabindex="-1" data-step="1" aria-label="Up">' + TRI(1) + '</button><button type="button" tabindex="-1" data-step="-1" aria-label="Down">' + TRI(-1) + '</button></span>');
    });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.numw .numa button'); if(!b) return;
    const inp = b.closest('.numw').querySelector('input[type=number]'); if(!inp || inp.disabled || inp.readOnly) return;
    try { if(b.dataset.step === '1') inp.stepUp(); else inp.stepDown(); } catch(err){ return; }
    inp.focus();
    inp.dispatchEvent(new Event('input', { bubbles:true })); inp.dispatchEvent(new Event('change', { bubbles:true }));
  });
  let raf = 0;
  const later = () => { if(!raf) raf = requestAnimationFrame(() => { raf = 0; wrap(); }); };
  return { start(){ wrap(); new MutationObserver(later).observe(document.body, { childList:true, subtree:true }); }, wrap };
})();

MC.init = function(page){
  MC.voicePanel();
  MC.bg();
  MC.rail(page); MC.ruler(); MC.barcode(); MC.clock();
  document.querySelectorAll('[data-voice-btn]').forEach(b => b.onclick = () => MC.setVoice(b.dataset.voiceBtn));
  new ResizeObserver(MC.drawFrames).observe(document.body);
  document.fonts.ready.then(MC.drawFrames);
  MC.setVoice("idle"); MC.statusChips();
  MC.projectStrip();
  MC.fades.start();
  MC.numberArrows.start();
};
