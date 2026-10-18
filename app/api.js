// Front end client for the Mission Control server.
window.MC = window.MC || {};

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
  async function request(method, path, body) {
    const opts = { method: method, headers: { 'X-MC': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 403 && data && data.error === 'not_paired') MC.removed();
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

MC.events = (function () {
  var handlers = {};
  var source = null;

  function connect() {
    source = new EventSource('/api/events');
    source.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      var list = (handlers[msg.type] || []).concat(handlers['*'] || []);
      list.forEach(function (fn) {
        try { fn(msg.data, msg); } catch (err) { console.error(err); }
      });
    };
    // EventSource reconnects on its own; recreate it only if it was closed.
    source.onerror = function () {
      if (source.readyState !== 2) return;
      // A refused stream tells nothing about why, so ask a plain call whether the phone was removed.
      fetch('/api/whoami', { headers: { 'X-MC': '1' } }).then(function (res) {
        return res.status === 403 ? res.json().catch(function () { return null; }) : null;
      }).then(function (data) {
        if (data && data.error === 'not_paired') MC.removed();
      }).catch(function () { /* unreachable: retry below */ });
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
  function ask(tries) {
    return fetch('/api/whoami').then(function (res) {
      if (!res.ok && res.status !== 403 && tries > 0) throw new Error('retry');
      return res;
    }).catch(function (e) {
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
