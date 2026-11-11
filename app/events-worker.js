// One /api/events stream shared by every Mission Control tab (a SharedWorker, started by api.js).
// A browser allows only 6 connections to one http:// host. When each tab held its own stream, a few open tabs used them
// all up, and the next page's calls waited behind the streams for 20 s or more. Here the stream is opened once and every
// message goes to every tab that is still connected.
var ports = [];
var source = null;

function connect() {
  source = new EventSource('/api/events');
  source.onmessage = function (e) {
    ports = ports.filter(function (p) {
      try { p.postMessage({ kind: 'msg', data: e.data }); return true; } catch (err) { return false; }
    });
  };
  // EventSource reconnects on its own; recreate it only if it was closed, and let the tabs check why.
  source.onerror = function () {
    if (source.readyState !== 2) return;
    ports.forEach(function (p) { try { p.postMessage({ kind: 'closed' }); } catch (err) { /* gone */ } });
    setTimeout(connect, 2000);
  };
}

onconnect = function (e) {
  var port = e.ports[0];
  ports.push(port);
  port.onmessage = function (m) { if (m.data === 'bye') ports = ports.filter(function (p) { return p !== port; }); };
  port.start();
  if (!source) connect();
};
