// What a paired phone may do. One table, default deny for anything that changes state.
//
// Reading (GET and HEAD) is always allowed for a device. Every other route must be classified here, once:
//   REMOTE_OK    a phone may call it
//   COMPUTER_OK  only a device marked as one of the user's other computers may call it (devices.json "computer",
//                set at this PC on the Connections page; on a hub, a PC that posts its conversations there)
//   PC_ONLY      only a request on the local listener may call it (a phone gets 403 {"error":"pc_only"})
//   PC_ONLY_READ the few reads a device may not make either (GET is otherwise always allowed): same 403
// A route in neither list is refused for phones, and unclassifiedRoutes() reports it (the server logs it at
// start, and tools\test\bridge-listener.test.mjs fails), so a new feature is classified in this file and nowhere else.
//
// Keys are "METHOD /route/pattern" exactly as the route file registers it.

export const REMOTE_OK = new Set([
  // Claude conversations: the point of the phone
  'POST /api/chat',
  // The hub's mailbox (only served by a hub): the PCs post and pick up their conversations as paired devices
  'PUT /api/hub/transcripts/:id',
  'POST /api/hub/baton/:id',
  'POST /api/hub/asks/:id',
  'POST /api/hub/asks/:id/:askId',
  'PUT /api/hub/drafts/:id',
  'POST /api/hub/tasks',
  'PUT /api/hub/shared/:key', // the settings every PC shares, such as the panel layouts (services/hubShared.js)
  // only for a PC that posts there (routes/hub.js checks it): the hub has no page of its own to show a pairing code
  'POST /api/hub/pair-phone',
  'POST /api/hub/sends/:id',
  'POST /api/hub/sends/:id/:sendId',
  // A machine's own notes vaults: git fetch and push to their mirror on the hub (each machine reaches only its own)
  'POST /api/hub/git/:repo/git-upload-pack',
  'POST /api/hub/git/:repo/git-receive-pack',
  // A message for a code conversation of a PC that is off: it waits on the hub until that PC runs it
  'POST /api/waiting/:id',
  'POST /api/waiting/:id/:sendId/cancel',
  // The same for the PC this one is linked to, straight through the link while it is on (routes/pcLink.js): what a
  // phone of that PC may send it
  'POST /api/pc/chat',
  'POST /api/pc/runs/:id/permission',
  'POST /api/pc/runs/:id/permission/typing',
  'POST /api/pc/sessions/:id/mode',
  'POST /api/pc/sessions/:id/meta',
  'POST /api/pc/sessions/:id/archive',
  'POST /api/pc/sessions/:id/delete',
  'POST /api/sessions/:id/mode',
  'POST /api/pc/runs/:id/stop',
  // One request to this PC's local model (routes/models.js): text in, text out, no tools; a phone may already run a
  // whole conversation on it
  'POST /api/models/ask',
  // The benchmark of that model (System page, Local model speed): a few fixed requests, and its own results file
  'POST /api/local-models/bench',
  'POST /api/runs/:id/permission',
  'POST /api/runs/:id/permission/typing',
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
  // the phone app's own link log, written to a file of its own
  'POST /api/phone-log',
  // Projects: the settings and outward jobs stay at the PC (see PC_ONLY and startJob)
  'POST /api/projects/refresh',
  'POST /api/projects/:id/git/commit',
  'POST /api/projects/:id/checks/:key',
  'POST /api/projects/:id/jobs/:jobId/run', // outward jobs are refused inside startJob when the call is remote
  'POST /api/jobs/:runId/stop',
  'POST /api/schedules/:name/run',
  'PUT /api/layout',
  'PUT /api/shared/:key',
  // the PIN lock (services/pcLock.js): the other computer types the PIN; anyone paired may lock
  'POST /api/pc-lock/unlock',
  'POST /api/pc-lock/lock',
  'POST /api/pc-link/lock',
  'POST /api/shared/sync',
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
  // A restart of the server alone (the runner keeps the conversations going); the handler refuses "all" from a phone, since
  // that restarts the bridge the phone talks through and stops every run
  'POST /api/server/restart',
  // Syncing the notes with the hub now only does early what the sync does on its own
  'POST /api/notes/sync',
  // The notes are edited from every device (design/notes-spec.md): a note of a project's notes folder (never the project
  // folder itself), of the linked PC's project, a note of this PC's vault for the linked PC while this PC is on (a
  // linked computer never reaches the Home only folders), and on a hub the copy of a vault whose machine is off
  'PUT /api/projects/:id/file',
  'PUT /api/pc/projects/:id/file',
  'PUT /api/notes/:repo/file',
  'PUT /api/hub/notes/:owner/:repo/file',
  // The Documents panel's file actions in a notes folder (new note or folder, rename, move, duplicate, delete to the
  // Recycle Bin), never in the project folder; the other PC's vault only while that PC is on
  'POST /api/projects/:id/notes-op',
  'POST /api/pc/projects/:id/notes-op',
  // Tasks are plain data the user keeps from anywhere
  'POST /api/tasks',
  'PUT /api/tasks/:id',
  'POST /api/tasks/:id/step',
  'POST /api/tasks/:id/note',
  'POST /api/tasks/:id/delete',
  'POST /api/task-lanes/:status',
  'POST /api/targets',
  'PUT /api/targets/:id',
  'POST /api/targets/:id/delete',
  // Removing a device only reduces access, and it is the answer to "my phone is lost and I am away from the PC"
  'POST /api/devices/:id/remove',
]);

export const COMPUTER_OK = new Set([
  // The Documents panel of the linked computer makes, moves, renames, copies or deletes a file in this PC's notes vault
  // (lib/noteOps.js; a deleted one goes to the Recycle Bin), never in a Home only folder
  'POST /api/notes/:repo/op',
  // The Sync panel of the other computer: this PC pushes the commits it already has (it never commits, and never touches
  // an uncommitted file), or pulls what is new, in the project that has that remote. Never a force push; a public
  // repository is never pushed this way either (services/sync.js)
  'POST /api/sync/remote',
  // A conversation about that sync when it stopped on this PC (a conflict here): Sonnet or Opus, told not to push
  // anything without the user's yes
  'POST /api/sync/remote/ask',
  // That computer's link to this one is up; it gives a pairing code of its own bridge, so this PC can call it too
  // (services/pcLink.js pairBack). This PC then reads that computer's projects and conversations, as it reads this one's
  'POST /api/pc-link/pair-back',
]);

export const PC_ONLY = new Set([
  // setting the PIN and its lock time, and typing the other PC's PIN, happen at this PC
  'PUT /api/pc-lock/pin',
  'PUT /api/pc-lock/time',
  'POST /api/pc-link/unlock',
  // The Sync panel: it drives the other computers through their links, so it is started here only
  'POST /api/sync/machines/refresh',
  'POST /api/sync/machines/sync',
  'POST /api/sync/machines/ask',
  'POST /api/sync/machines/restart',
  // Which paired device is one of the user's other computers (COMPUTER_OK): set at the PC only
  'POST /api/devices/:id/computer',
  // Mission Control's MCP endpoint: only the Claude processes this PC starts call it
  'POST /api/mcp',
  // Sync pushes to GitHub, like the outward jobs: started at the PC only
  'POST /api/projects/:id/sync',
  'POST /api/projects/:id/sync/ask',
  // Which hub this PC trusts with its conversations: set at the PC only
  'POST /api/hub-link/pair',
  'POST /api/hub-link/forget',
  // A pairing code for a phone, from the hub
  'POST /api/hub-link/pair-phone',
  // The link to another PC: an address that opens that PC's pages, and reading its projects again
  'POST /api/pc-link/enter',
  'POST /api/pc-link/refresh',
  'POST /api/pc-link/back',
  // Kills arbitrary PC processes
  'POST /api/processes/:pid/kill',
  // Defines the scripts that jobs run: persistent code execution on the PC
  'PUT /api/projects/:id/settings',
  // Root folders: a new one lets Claude work in every folder inside it
  'POST /api/roots',
  'POST /api/roots/remove',
  // Opens a window on the PC
  'POST /api/projects/:id/checks/:key/launch',
  // Opens Windows Explorer on the PC (a path from a conversation)
  'POST /api/path/reveal',
  'POST /api/path/code',
  // Deletes files on the PC (an item in the temp folder)
  'POST /api/temp/delete',
  // Moves conversations and attached files to the Recycle Bin (System page, Conversations and attachments)
  'POST /api/storage/delete',
  // Rewrites code conversations without their tool pictures (the old files go to the Recycle Bin)
  'POST /api/storage/shrink',
  // Only measures what a shrink would save, but reads every picked conversation through
  'POST /api/storage/shrink-estimate',
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
  // The Console module: a terminal runs any command on the PC
  'POST /api/console/:id/open',
  'POST /api/console/:id/input',
  'POST /api/console/:id/stop',
  'POST /api/console/:id/restart',
  'POST /api/console/:id/close',
]);

// Reads that stay at the PC: what a terminal printed, and the server's own log (paths, names, errors).
export const PC_ONLY_READ = new Set([
  'GET /api/console',
  'GET /api/console/stream',
  'GET /api/console/server-log',
  'GET /api/console/:id',
]);

const READ_ONLY = new Set(['GET', 'HEAD']);

export function routeKey(method, routePath) {
  return `${String(method).toUpperCase()} ${routePath}`;
}

// May a device call this matched route? `route.path` is the pattern the route file registered; `device` is
// req.mcDevice ({ id, name, computer }).
export function remoteAllowed(method, route, device = null) {
  const m = String(method).toUpperCase();
  if (READ_ONLY.has(m)) return !PC_ONLY_READ.has(routeKey('GET', route && route.path));
  const key = routeKey(m, route && route.path);
  return REMOTE_OK.has(key) || (!!(device && device.computer) && COMPUTER_OK.has(key));
}

// Keys of the state-changing routes that are in neither list. `routeList` items need { method, path }.
export function unclassifiedRoutes(routeList) {
  const missing = [];
  for (const r of routeList) {
    const m = String(r.method).toUpperCase();
    if (READ_ONLY.has(m)) continue;
    const key = routeKey(m, r.path);
    if (!REMOTE_OK.has(key) && !COMPUTER_OK.has(key) && !PC_ONLY.has(key)) missing.push(key);
  }
  return missing;
}
