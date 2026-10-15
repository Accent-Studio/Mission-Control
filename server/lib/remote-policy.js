// What a paired phone may do. One table, default deny for anything that changes state.
//
// Reading (GET and HEAD) is always allowed for a device. Every other route must be classified here, once:
//   REMOTE_OK  a phone may call it
//   PC_ONLY    only a request on the local listener may call it (a phone gets 403 {"error":"pc_only"})
// A route in neither list is refused for phones, and unclassifiedRoutes() reports it (the server logs it at
// start, and tools\test\bridge-listener.test.mjs fails), so a new feature is classified in this file and nowhere else.
//
// Keys are "METHOD /route/pattern" exactly as the route file registers it.

export const REMOTE_OK = new Set([
  // Claude conversations: the point of the phone
  'POST /api/chat',
  'POST /api/runs/:id/permission',
  'POST /api/runs/:id/stop',
  'POST /api/uploads',
  'POST /api/sessions/order',
  'POST /api/sessions/:id/meta',
  // Archiving only hides a conversation (and takes it off claude.ai); the Com Link end phrase on a phone calls it too
  'POST /api/sessions/:id/archive',
  'POST /api/sessions/:id/delete',
  // At 5 min left (handoff or compact) only sends a message a phone could send itself
  'POST /api/sessions/:id/expiry-action',
  'POST /api/usage/refresh',
  // Send later: the same messages a phone may send now, only at a later time
  'POST /api/delayed',
  'POST /api/delayed/:id/cancel',
  'POST /api/delayed/:id/now',
  // the unsent message box, shared by the phone and the PC
  'PUT /api/drafts',
  // Projects: the settings and outward jobs stay at the PC (see PC_ONLY and startJob)
  'POST /api/projects/refresh',
  'POST /api/projects/:id/git/commit',
  'POST /api/projects/:id/checks/:key',
  'POST /api/projects/:id/jobs/:jobId/run', // outward jobs are refused inside startJob when the call is remote
  'POST /api/jobs/:runId/stop',
  'POST /api/schedules/:name/run',
  'PUT /api/layout',
  'POST /api/connections/:id/test',
  // Memory and models
  'POST /api/engines/comfyui/free',
  'POST /api/engines/:engine/unload',
  'POST /api/ollama/unload',
  // Voice preferences are plain settings; the PC microphone and speakers are not the phone's
  'PUT /api/voice/prefs',
  // A phone's own microphone and speaker: the recording is transcribed and a reply is spoken into a WAV, on the PC's
  // speech engines only (nothing is recorded or played on the PC)
  'POST /api/voice/transcribe',
  'POST /api/voice/tts',
  // Removing a device only reduces access, and it is the answer to "my phone is lost and I am away from the PC"
  'POST /api/devices/:id/remove',
]);

export const PC_ONLY = new Set([
  // Kills arbitrary PC processes
  'POST /api/processes/:pid/kill',
  // Stops every live Claude run and job, and strands the owner if the new code fails to start
  'POST /api/server/restart',
  // Defines the scripts that jobs run: persistent code execution on the PC
  'PUT /api/projects/:id/settings',
  // Opens a window on the PC
  'POST /api/projects/:id/checks/:key/launch',
  // They drive the PC's microphone and speakers through BlitzVoice
  'POST /api/voice/start',
  'POST /api/voice/stop',
  'POST /api/voice/cancel',
  'POST /api/voice/wake',
  'POST /api/voice/focus',
  'POST /api/voice/speak',
  'POST /api/voice/speak/stop',
  'POST /api/voice/discard',
  // The Com Link's memory goes into its system prompt: edited at the PC only
  'PUT /api/voice/memory',
  // Wake word training: runs a program on the PC's GPU, writes voice clips, and installs models into BlitzVoice
  'POST /api/waketrain/start',
  'POST /api/waketrain/stop',
  'POST /api/waketrain/install',
  'POST /api/waketrain/clips/:slug',
  'POST /api/waketrain/clips/:slug/:name/delete',
  // A phone must not pair another phone, or restart the bridge
  'POST /api/devices/pair',
  'POST /api/devices/pair/cancel',
  'POST /api/devices/:id/rename',
  'POST /api/devices/bridge/restart',
]);

const READ_ONLY = new Set(['GET', 'HEAD']);

export function routeKey(method, routePath) {
  return `${String(method).toUpperCase()} ${routePath}`;
}

// May a device (phone) call this matched route? `route.path` is the pattern the route file registered.
export function remoteAllowed(method, route) {
  const m = String(method).toUpperCase();
  if (READ_ONLY.has(m)) return true;
  return REMOTE_OK.has(routeKey(m, route && route.path));
}

// Keys of the state-changing routes that are in neither list. `routeList` items need { method, path }.
export function unclassifiedRoutes(routeList) {
  const missing = [];
  for (const r of routeList) {
    const m = String(r.method).toUpperCase();
    if (READ_ONLY.has(m)) continue;
    const key = routeKey(m, r.path);
    if (!REMOTE_OK.has(key) && !PC_ONLY.has(key)) missing.push(key);
  }
  return missing;
}
