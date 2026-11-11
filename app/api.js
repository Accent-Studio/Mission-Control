// Front end client for the Mission Control server.
window.MC = window.MC || {};

// The phone app opens on the Talk page's conversation list rather than Home. Only the first page of a run of the app moves:
// Home picked later from the menu stays Home. The PC's pages open in an Android browser only through the phone app.
(function () {
  if (!/Android/i.test(navigator.userAgent)) return;
  try {
    if (sessionStorage.getItem('mc-opened')) return;
    sessionStorage.setItem('mc-opened', '1');
  } catch (e) { return; }
  if (/^\/(index\.html)?$/.test(location.pathname)) location.replace('/chat.html');
})();

// A phone page brought back from the browser's page cache (Back after visiting another page) has lost its live link to the PC
// and may hold calls that will never answer, so it loads again instead.
addEventListener('pageshow', function (e) { if (e.persisted && /Android/i.test(navigator.userAgent)) location.reload(); });

// On a phone, the PC can remove the phone while a page is open. The phone's proxy then answers every call with
// 403 not_paired. Reload once so the page the proxy shows next explains it (on the PC this answer never happens).
MC.removed = (function () {
  var KEY = 'mc-removed-reload';
  return function () {
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (e) { /* storage may be blocked */ }
    if (Date.now() - last < 60000) return; // reloaded just now: never loop
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) { /* ignore */ }
    location.reload();
  };
})();

MC.api = (function () {
  const GET_MAX = 25000;
  async function request(method, path, body) {
    const opts = { method: method, headers: { 'X-MC': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // A read gives up after GET_MAX: when the link to the PC drops, a phone's call can otherwise wait for ever and the page
    // never finishes loading. Writes keep waiting, since giving up on one would not undo it.
    let timer = 0;
    if (method === 'GET' && window.AbortController) {
      const ac = new AbortController();
      opts.signal = ac.signal;
      timer = setTimeout(function () { ac.abort(); }, GET_MAX);
    }
    let res;
    try { res = await fetch(path, opts); }
    catch (e) {
      clearTimeout(timer);
      const err = new Error(opts.signal && opts.signal.aborted ? 'timeout' : 'offline');
      err.status = 0;
      throw err;
    }
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 403 && data && data.error === 'not_paired') MC.removed();
    if (res.status === 423 && data && data.error === 'pc_locked') MC.lockScreen();
    if (res.status === 423 && data && data.error === 'peer_locked') MC.peerLockBox(data.pc);
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  return {
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body === undefined ? {} : body); },
    put: function (path, body) { return request('PUT', path, body === undefined ? {} : body); },
  };
})();

// A PIN box over the page. submit(pin) answers, or throws an error whose .data says why (tries left, locked out until).
// closable: false for the lock screen, which only goes away with the right PIN. Resolves true once submit went through.
MC.pinBox = function (title, submit, closable, okLabel) {
  return new Promise(function (done) {
    var d = document.createElement('div');
    d.setAttribute('style', 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.82)');
    d.innerHTML = '<form style="display:flex;flex-direction:column;gap:12px;min-width:280px;padding:24px;border-radius:12px;background:var(--panel,#1b1f27);color:var(--text,#e8ebf0);border:1px solid var(--line,#333a46);font:15px var(--font,system-ui)">'
      + '<b style="font-size:18px"></b>'
      + '<input type="password" inputmode="numeric" autocomplete="off" maxlength="8" style="font-size:24px;letter-spacing:8px;text-align:center;padding:8px;border-radius:8px;border:1px solid var(--line,#333a46);background:var(--bg,#11141a);color:inherit">'
      + '<span data-msg style="min-height:20px;font-size:14px"></span>'
      + '<span style="display:flex;gap:8px;justify-content:flex-end">' + (closable === false ? '' : '<button type="button" data-x class="btn sm ghost">Cancel</button>') + '<button class="btn sm primary"></button></span></form>';
    d.querySelector('b').textContent = title;
    d.querySelector('.primary').textContent = okLabel || 'Unlock';
    document.body.appendChild(d);
    var inp = d.querySelector('input'), msg = d.querySelector('[data-msg]'), busy = false;
    inp.focus();
    var end = function (v) { d.remove(); done(v); };
    if (closable !== false) d.querySelector('[data-x]').onclick = function () { end(false); };
    d.querySelector('form').onsubmit = function (e) {
      e.preventDefault();
      if (busy || !/^\d{4,8}$/.test(inp.value)) { msg.textContent = 'Type the 4 to 8 digits'; return; }
      busy = true; msg.textContent = '';
      Promise.resolve(submit(inp.value)).then(function () { end(true); }, function (err) {
        busy = false; inp.value = ''; inp.focus();
        var x = (err && err.data) || {};
        msg.textContent = x.outUntil ? 'Too many wrong PINs. Try again at ' + new Date(x.outUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.'
          : x.tries != null ? 'Wrong PIN. ' + x.tries + (x.tries === 1 ? ' try' : ' tries') + ' left.' : (err && err.message) || 'No answer';
      });
    };
  });
};

// This PC is locked for the computer this page runs on (server/services/pcLock.js): the PIN, then the page again. Only
// when this PC has a PIN: with none set there is nothing to type, so no lock screen.
MC.lockScreen = function () {
  if (MC._locked) return;
  MC._locked = true;
  fetch('/api/pc-lock').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }).then(function (st) {
    if (!st || !st.pin) { MC._locked = false; return; }
    MC.pinBox((MC.place || 'This PC') + ' is locked', function (pin) { return MC.api.post('/api/pc-lock/unlock', { pin: pin }); }, false)
      .then(function () { location.reload(); });
  });
};

// The other PC's PIN, typed here (a lock's Unlock button): resolves true once it is open
MC.unlockPc = function (name) {
  var r = null;
  return MC.pinBox((name || 'The other PC') + "'s PIN", function (pin) { return MC.api.post('/api/pc-link/unlock', { pin: pin }).then(function (x) { r = x; }); }, true)
    .then(function (ok) {
      if (ok && MC.toast) MC.toast((name || 'The other PC') + ' is open' + (r && r.until ? ' until ' + new Date(r.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''), 'lock');
      return ok;
    });
};

// The other PC is locked for this one (its PIN, services/pcLink.js): its PIN, in a box that can be closed. Closed, it
// stays away for 10 minutes; this PC's own projects work as before.
MC.peerLockBox = function (name) {
  if (MC._peerBox || Date.now() < (MC._peerQuiet || 0)) return;
  MC._peerBox = true;
  MC.pinBox((name || 'The other PC') + ' is locked', function (pin) { return MC.api.post('/api/pc-link/unlock', { pin: pin }); }, true)
    .then(function (ok) { MC._peerBox = false; if (!ok) MC._peerQuiet = Date.now() + 600e3; });
};

MC.events = (function () {
  var handlers = {};
  var source = null;

  function dispatch(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    var list = (handlers[msg.type] || []).concat(handlers['*'] || []);
    list.forEach(function (fn) {
      try { fn(msg.data, msg); } catch (err) { console.error(err); }
    });
  }
  // A refused stream tells nothing about why, so ask a plain call whether the phone was removed.
  function checkRemoved() {
    fetch('/api/whoami', { headers: { 'X-MC': '1' } }).then(function (res) {
      return res.status === 403 || res.ok ? res.json().catch(function () { return null; }) : null;
    }).then(function (data) {
      if (data && data.error === 'not_paired') MC.removed();
      if (data && data.locked) MC.lockScreen(); // locked from somewhere else: this PC ended the stream (services/pcLock.js)
    }).catch(function () { /* unreachable: the stream retries */ });
  }

  function connect() {
    // Every tab shares one stream through events-worker.js, so open tabs no longer use up the browser's 6 connections to
    // this host. A browser without SharedWorker (the phone's web view) gets a stream of its own, as before.
    if (typeof SharedWorker === 'function') {
      try {
        var worker = new SharedWorker('/events-worker.js', { name: 'mc-events' });
        source = worker.port;
        worker.port.onmessage = function (e) {
          if (e.data && e.data.kind === 'msg') dispatch(e.data.data);
          else if (e.data && e.data.kind === 'closed') checkRemoved();
        };
        worker.port.start();
        addEventListener('pagehide', function () { try { worker.port.postMessage('bye'); } catch (err) { /* closing */ } }, { once: true });
        // back/forward cache: the page said bye on the way out, so it joins again when it comes back
        addEventListener('pageshow', function (ev) { if (ev.persisted) connect(); }, { once: true });
        return;
      } catch (err) { /* fall back to a stream of our own */ }
    }
    source = new EventSource('/api/events');
    source.onmessage = function (e) { dispatch(e.data); };
    // EventSource reconnects on its own; recreate it only if it was closed.
    source.onerror = function () {
      if (source.readyState !== 2) return;
      checkRemoved();
      setTimeout(connect, 2000);
    };
  }

  return {
    // on('type', fn) or on('*', fn). Returns an unsubscribe function.
    on: function (type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
      if (!source) connect();
      return function () {
        handlers[type] = (handlers[type] || []).filter(function (f) { return f !== fn; });
      };
    },
  };
})();

// Who is asking: the PC itself or a phone (through the bridge). On a phone <html> gets data-remote, and
// redline.css hides everything marked .pc-only. The last answer is kept for the tab, so a phone does not flash
// PC-only buttons while this loads (the phone and the PC never share an origin, so the guess cannot cross over).
MC.whoami = (function () {
  var KEY = 'mc-remote';
  function mark(remote) {
    if (remote) document.documentElement.setAttribute('data-remote', '');
    else document.documentElement.removeAttribute('data-remote');
  }
  // The PC's pages never open in an Android browser except through the phone app, so Android is a phone until told otherwise.
  var guess = /Android/i.test(navigator.userAgent);
  try { if (sessionStorage.getItem(KEY) === '1') guess = true; } catch (e) { /* storage may be blocked */ }
  if (guess) mark(true);
  // A phone opens Mission Control 2 once it was opened there; the hub opens it unless Open the old Mission Control was picked.
  function v2(hub) {
    try { var o = localStorage.getItem('mc2-on-phone'); return o === '1' || (hub && o !== '0'); } catch (e) { return false; /* storage blocked: the old pages stay */ }
  }
  var inV2 = /^\/v2\//.test(location.pathname);
  try {
    if (guess && !inV2 && v2(sessionStorage.getItem('mc-hub') === '1')) location.replace('/v2/');
  } catch (e) { /* storage blocked: the old pages stay */ }
  // The hub (the always-on server) shows the conversations only: the rest needs a PC. <html> gets data-hub.
  function hubPage(hub) {
    MC.hub = hub;
    if (hub) document.documentElement.setAttribute('data-hub', '');
    else document.documentElement.removeAttribute('data-hub');
    if (!hub || inV2) return;
    if (guess && v2(true)) location.replace('/v2/');
    else if (!/(^|\/)chat\.html$/.test(location.pathname)) location.replace('/chat.html');
  }
  try { if (sessionStorage.getItem('mc-hub') === '1') hubPage(true); } catch (e) { /* ignore */ }
  function ask(tries) {
    var ac = window.AbortController ? new AbortController() : null, t = ac ? setTimeout(function () { ac.abort(); }, 8000) : 0;
    return fetch('/api/whoami', ac ? { signal: ac.signal } : undefined).then(function (res) {
      clearTimeout(t);
      if (!res.ok && res.status !== 403 && tries > 0) throw new Error('retry');
      return res;
    }).catch(function (e) {
      clearTimeout(t);
      if (tries > 0) return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return ask(tries - 1); });
      throw e;
    });
  }
  return ask(3).then(function (res) {
    if (res.status === 403) res.clone().json().then(function (d) { if (d && d.error === 'not_paired') MC.removed(); }).catch(function () {});
    return res.ok ? res.json() : null;
  }).then(function (who) {
    var remote = who ? !!who.remote : guess;
    MC.remote = remote;
    mark(remote);
    if (who) { MC.place = who.name || null; if (who.locked) MC.lockScreen(); hubPage(who.role === 'hub'); try { sessionStorage.setItem('mc-hub', who.role === 'hub' ? '1' : '0'); } catch (e) { /* ignore */ } }
    try { sessionStorage.setItem(KEY, remote ? '1' : '0'); } catch (e) { /* ignore */ }
    return who;
  }).catch(function () { MC.remote = guess; mark(guess); return null; }); // no answer after a few tries: the best guess
})();

// Space or office view. Office drops the 3D scenes (the solar system on Home, the crew ship on project pages) for
// plain panels, and <html> gets data-view="office". The choice is kept per browser, so the home PC, the office PC
// and the phone each keep their own; with no choice yet, a narrow screen (a phone) starts in office. It is read
// once per page: changing it reloads the page.
MC.view = (function () {
  var KEY = 'mc-view';
  var chosen = null;
  try { chosen = localStorage.getItem(KEY); } catch (e) { /* storage may be blocked */ }
  if (chosen !== 'office' && chosen !== 'space') chosen = null;
  var office = chosen ? chosen === 'office' : window.matchMedia('(max-width: 760px)').matches;
  if (office) document.documentElement.setAttribute('data-view', 'office');
  return {
    office: office,
    set: function (v) {
      if (v !== 'office' && v !== 'space') return;
      try { localStorage.setItem(KEY, v); } catch (e) { /* ignore */ }
      if ((v === 'office') !== office) location.reload();
    },
  };
})();

// Pull to refresh on a phone. Pull past the edge of a scroll box (or the page) and the content follows the finger by half
// the distance. Let go past AT and a small red spinner turns while it loads: at least SPIN_MIN, so a quick load still shows
// it happened, and at most PULL_MAX, so a link to the PC that dropped never leaves it turning.
// MC.pull.page(run): the whole page, pulled down at its top. MC.pull.box(el, 'top' | 'bottom', run): one scroll box.
// run may return a promise; the spinner stops when it settles.
MC.pull = (function () {
  var AT = 64, HOLD = 44, PULL_MAX = 12000, SPIN_MIN = 300;
  var phone = window.matchMedia('(max-width:1100px)');
  // A touch that starts inside a box scrolled away from the edge (or a fixed panel, on the page) scrolls that, not the pull.
  function blocked(t, box, edge) {
    for (var el = t && t.nodeType === 1 ? t : t && t.parentElement; el && el !== box && el !== document.body; el = el.parentElement) {
      var cs = getComputedStyle(el);
      if (!box && cs.position === 'fixed') return true;
      if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(cs.overflowY)
        && (edge === 'top' ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 2)) return true;
    }
    return false;
  }
  function attach(box, edge, run) {
    var page = !box, sc = page ? document.scrollingElement : box, on = page ? document : box;
    var y0 = null, d = 0, busy = 0;
    var gap = document.createElement('div'); gap.className = 'pullgap'; gap.hidden = true;
    gap.innerHTML = '<i class="pullspin" role="status" aria-label="Refreshing"></i>';
    function atEdge() { return edge === 'top' ? sc.scrollTop <= 0 : sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2; }
    function place() {
      if (page) {
        var app = document.querySelector('.app') || document.body, rail = app.querySelector(':scope > .rail');
        var at = rail ? rail.nextSibling : app.firstChild;
        if (gap.parentNode !== app || (at !== gap && gap.nextSibling !== at)) app.insertBefore(gap, at);
      } else if (edge === 'top') { if (box.firstChild !== gap) box.insertBefore(gap, box.firstChild); } else if (box.lastChild !== gap) box.appendChild(gap);
    }
    function show(px, spin) {
      place();
      gap.hidden = !px; gap.style.height = px + 'px'; gap.classList.toggle('on', !!spin);
      if (px && edge === 'bottom') sc.scrollTop = sc.scrollHeight;
    }
    function end() {
      if (y0 == null) return;
      y0 = null;
      if (d < AT) { d = 0; show(0); return; }
      d = 0; show(HOLD, true);
      var me = ++busy, stop = function () { if (busy === me) { busy = 0; show(0); } };
      setTimeout(stop, PULL_MAX);
      var shown = new Promise(function (ok) { setTimeout(ok, SPIN_MIN); });
      Promise.all([Promise.resolve().then(run).catch(function () {}), shown]).then(stop);
    }
    on.addEventListener('touchstart', function (e) {
      y0 = !busy && phone.matches && e.touches.length === 1 && atEdge() && !blocked(e.target, box, edge) ? e.touches[0].clientY : null; d = 0;
    }, { passive: true });
    on.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      var dy = (e.touches[0].clientY - y0) * (edge === 'top' ? 1 : -1);
      if (dy <= 0) { if (d) { d = 0; show(0); } else y0 = null; return; } /* the usual direction: it just scrolls */
      if (e.cancelable) e.preventDefault();
      d = Math.min(130, dy / 2);
      show(d);
    }, { passive: false });
    on.addEventListener('touchend', end);
    on.addEventListener('touchcancel', function () { y0 = null; d = 0; if (!busy) show(0); });
  }
  return {
    page: function (run) { attach(null, 'top', run); },
    box: function (el, edge, run) { if (el) attach(el, edge, run); },
  };
})();

// A conversation read while a process is answering it (GET /api/sessions/:id). The saved part (messages) stops where the
// turn began, and the turn itself comes as "live" (events: the message that started it, what Claude wrote so far). A page
// that lists messages shows both, or it misses the current prompt and the answer so far, and counts the turn from the
// message before. messages() gives the two together in one list; startedAt() says when the turn in progress began.
MC.liveTurn = (function () {
  function liveOf(s) { return s && s.live && s.live.cut && Array.isArray(s.live.events) ? s.live : null; }
  function textOf(content) {
    return (Array.isArray(content) ? content : []).filter(function (b) { return b && b.type === 'text' && b.text; }).map(function (b) { return String(b.text); }).join('\n\n');
  }
  return {
    messages: function (s) {
      var out = s && Array.isArray(s.messages) ? s.messages.slice() : [];
      var L = liveOf(s);
      if (!L) return out;
      L.events.forEach(function (e) {
        var ev = e.event;
        if (e.sent) out.push({ role: 'user', text: String(e.sent.text || ''), at: e.at || null, live: true });
        else if (ev && ev.mcNotice) out.push({ role: 'notice', label: ev.mcNotice.label, text: String(ev.mcNotice.text || ''), at: null, live: true });
        else if (ev && ev.type === 'assistant' && ev.message) {
          var t = textOf(ev.message.content);
          if (t) out.push({ role: 'assistant', text: t, at: null, live: true });
        }
      });
      return out;
    },
    // Milliseconds since 1970 when the turn in progress began, or null when no process is answering this conversation.
    startedAt: function (s) {
      var t = s && s.live && s.live.turn ? Date.parse(s.live.turn.startedAt) : NaN;
      return isFinite(t) ? t : null;
    },
  };
})();
