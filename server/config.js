// Paths and settings shared by the server.
//
// Machine-specific settings (which folders hold projects, where notes live, ...) come from .data/config.json, which is
// never in git. config.example.json at the top of the repository shows every key. Without the file, Mission Control
// looks for projects in the folder that holds Mission Control itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(ROOT, 'app');
// MC_DATA_DIR points the catalog, logs and job history somewhere else (used by tests).
export const DATA_DIR = process.env.MC_DATA_DIR ? path.resolve(process.env.MC_DATA_DIR) : path.join(ROOT, '.data');
export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const LOCAL_CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readLocalConfig() {
  try {
    const raw = fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[config] could not read .data/config.json:', err.message);
    return {};
  }
}
const local = readLocalConfig();
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Folders whose direct subfolders are scanned for projects. MC_DISCOVERY_ROOTS (semicolon separated) overrides them for tests.
export const DISCOVERY_ROOTS = process.env.MC_DISCOVERY_ROOTS
  ? process.env.MC_DISCOVERY_ROOTS.split(';').map((s) => s.trim()).filter(Boolean)
  : strings(local.discoveryRoots).length ? strings(local.discoveryRoots) : [path.dirname(ROOT)];
// The root folders as .data/config.json lists them now: the runner adds them to its own list, which it read at its start,
// so a root folder added from the project tree (services/roots.js) works without restarting it.
export function savedDiscoveryRoots() {
  return process.env.MC_DISCOVERY_ROOTS ? [] : strings(readLocalConfig().discoveryRoots);
}
// The folder a conversation starts in when no project is chosen.
export const DEFAULT_CWD = typeof local.defaultCwd === 'string' && local.defaultCwd.trim() ? local.defaultCwd.trim() : DISCOVERY_ROOTS[0];
// Drives on which Claude may work in any folder, not only inside the discovery roots and projects (for example ["D:"]).
export const OPEN_DRIVES = strings(local.openDrives).map((d) => d.slice(0, 1).toLowerCase()).filter((d) => /^[a-z]$/.test(d));
// The persona prompt (prompt plus memory) that persona.js writes and runs.js hands to claude with --append-system-prompt-file.
export const PERSONA_SYSTEM_FILE = path.join(DATA_DIR, 'comlink-system.md');
// The name of this computer in the Sessions list (its tab), "Home" or "Work" for example. Without it, the computer's own name.
export const MACHINE_NAME = typeof local.machineName === 'string' && local.machineName.trim() ? local.machineName.trim().slice(0, 40) : os.hostname();
// "hub" makes this Mission Control the hub: the always-on server the PCs share (the mailbox for their conversations, see
// services/hub.js). Anything else is a PC. MC_ROLE overrides it (tests).
export const ROLE = (process.env.MC_ROLE || (typeof local.role === 'string' ? local.role : '')).trim().toLowerCase() === 'hub' ? 'hub' : 'pc';
// How a PC reaches the hub: .data/hub.json, { url, headers }. No file, no hub (services/hubSync.js).
export const HUB_LINK_FILE = path.join(DATA_DIR, 'hub.json');
// Plain chats (no project, no file tools) all run in this one folder, so a transcript recorded here is a chat.
export const CHATS_DIR = path.join(DATA_DIR, 'chats');
// Single projects that live outside the discovery roots: { id, name, folder }. Merged like discovered folders.
export const EXTRA_PROJECTS = process.env.MC_DISCOVERY_ROOTS
  ? []
  : (Array.isArray(local.extraProjects) ? local.extraProjects : []).filter(
      (p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.folder === 'string',
    );
// Old folder names of renamed projects, so their earlier Claude sessions still match: { projectId: [folder, ...] }.
export const PROJECT_ALIASES = Object.fromEntries(Object.entries(object(local.projectAliases)).map(([k, v]) => [k, strings(v)]));
// A one line subtitle for projects that have none of their own yet: { projectId: text }.
export const PROJECT_ABOUT = Object.fromEntries(Object.entries(object(local.projectAbout)).filter(([, v]) => typeof v === 'string'));
// A notes folder (an Obsidian vault, for example). A project's notes are the folders listed for it in NOTES_FOLDERS,
// plus a folder named like the project inside NOTES_PROJECT_DIR. The Docs and Screenshots tabs show them read only,
// next to the project's own files. MC_NOTES_ROOT points somewhere else (tests use an empty folder), or "off".
export const NOTES_ROOT = process.env.MC_NOTES_ROOT === 'off' ? null
  : process.env.MC_NOTES_ROOT ? path.resolve(process.env.MC_NOTES_ROOT)
  : process.env.MC_DISCOVERY_ROOTS ? null
  : typeof local.notesRoot === 'string' && local.notesRoot.trim() ? local.notesRoot.trim() : null;
export const NOTES_FOLDERS = Object.fromEntries(Object.entries(object(local.notesFolders)).map(([k, v]) => [k, strings(v)]));
export const NOTES_PROJECT_DIR = typeof local.notesProjectDir === 'string' ? local.notesProjectDir.trim() : '';
// The notes vaults this machine owns, each a git repo kept in step with its mirror on the hub (services/notesSync.js):
// [{ id, dir }], id a short name ("notes", "wiki"). MC_NOTES_REPOS (JSON) overrides it (tests).
const notesRepos = (() => {
  try {
    return process.env.MC_NOTES_REPOS ? JSON.parse(process.env.MC_NOTES_REPOS) : process.env.MC_DISCOVERY_ROOTS ? [] : local.notesRepos;
  } catch {
    return [];
  }
})();
export const NOTES_REPOS = (Array.isArray(notesRepos) ? notesRepos : [])
  .filter((r) => r && typeof r.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id) && typeof r.dir === 'string' && r.dir.trim())
  .map((r) => ({ id: r.id, dir: path.resolve(r.dir.trim()) }));
// The wake word trainer (waketrainer/ in this repository unless .data/config.json says otherwise).
export const WAKETRAINER_DIR = typeof local.wakeTrainerDir === 'string' && local.wakeTrainerDir.trim()
  ? local.wakeTrainerDir.trim() : path.join(ROOT, 'waketrainer');
// The servers.json of a lazy MCP starter, if you use one. The Connections page lists every server in it, and says
// which ones Claude Code no longer knows about.
export const MCP_STARTER_FILE = typeof local.mcpStarterServers === 'string' && local.mcpStarterServers.trim()
  ? local.mcpStarterServers.trim() : null;
// One folder for everything that can be thrown away: build caches, test runs, scratch files. Each subfolder is a group
// (builds, scratch, ...) and each item in a group can be deleted from the System page. MC_TEMP_ROOT overrides it (tests).
export const TEMP_ROOT = process.env.MC_TEMP_ROOT ? path.resolve(process.env.MC_TEMP_ROOT)
  : typeof local.tempRoot === 'string' && local.tempRoot.trim() ? path.resolve(local.tempRoot.trim()) : null;
// Default jobs per project. Applied only to projects that have no `jobs` key in the catalog yet. Your own seed file in
// .data/jobs-seed.json wins over the empty one in git.
export const JOBS_SEED_FILE = fs.existsSync(path.join(DATA_DIR, 'jobs-seed.json'))
  ? path.join(DATA_DIR, 'jobs-seed.json') : path.join(ROOT, 'server', 'data', 'jobs-seed.json');
export const HOST = process.env.MC_HOST || '127.0.0.1';
export const PORT = Number(process.env.MC_PORT) || 1700;
// Second listener, for the phone bridge only (mc-bridge.exe). It is always bound to 127.0.0.1 and needs the bridge secret.
// MC_BRIDGE_PORT=off turns it off, a number moves it (tests use 47xxx ports).
export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = process.env.MC_BRIDGE_PORT === 'off' ? null : Number(process.env.MC_BRIDGE_PORT) || 1701;
// The runner (server/runner/index.js) owns the claude processes so they survive a restart of this server. It listens on
// 127.0.0.1 only and wants the secret in .data\runner\secret. MC_RUNNER_PORT=off means no runner (the server starts
// claude directly), a number moves it (tests use 488xx ports).
export const RUNNER_HOST = '127.0.0.1';
export const RUNNER_PORT = process.env.MC_RUNNER_PORT === 'off' ? null : Number(process.env.MC_RUNNER_PORT) || 1702; // 1710 to 1719 belong to BlitzVoice's link
// Local models (llama.cpp's llama-server) offered in the chat next to Claude's models: "localModels" in .data/config.json,
// see config.example.json. A conversation on one still runs the claude program, pointed at the gate (server/llmgate),
// which starts llama-server when needed and turns the chosen effort into its thinking settings.
export const LOCAL_MODELS = (Array.isArray(local.localModels) ? local.localModels : []).filter((m) => m && typeof m === 'object');
export const LOCAL_MODELS_DIR = path.join(DATA_DIR, 'local-models'); // the settings file per model and effort, and the logs
export const GATE_HOST = '127.0.0.1';
export const GATE_PORT = Number(process.env.MC_GATE_PORT) || 1705; // 1703 and 1704 are the hub and PC links
// What a local model's work costs in electricity (the Usage page): the price of a kWh, the exchange rate to the page's
// dollars, and the watts the rest of the PC adds while the model works (the graphics card's own draw is measured).
const elec = object(local.electricity);
const pos = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
export const ELECTRICITY = { pricePerKWh: pos(elec.pricePerKWh, 0.17), currency: typeof elec.currency === 'string' ? elec.currency : 'USD', perDollar: pos(elec.perDollar, 1), otherWatts: pos(elec.otherWatts, 60) };
