# Mission Control

**A dev dashboard for people who build with Claude Code.** Every project on your computer in one place: its build state, its changes, its conversations with Claude, its tasks, its notes, and the GPU memory your local AI models are using. Talk to Claude from the browser or your phone, by text or by voice.

Mission Control is a small local web server (Node.js, no npm packages) that you open in a browser tab. It drives the official Claude Code command line tool, signed in with your own account.

## Mission Control 2

Version 2 is a new interface at http://127.0.0.1:1700/v2/, and the start scripts open it by default. The version 1 pages are still there at http://127.0.0.1:1700/ while you move over.

Coming from version 1? See [UPGRADING-TO-V2.md](UPGRADING-TO-V2.md). It is a prompt you give your own Claude to move your own pages and tools over.

## What it does

**One window, built from panels**
- A rail with the pages (Home, Projects, Automation, Connections, Usage, System, Settings) and browser-like tabs: each tab shows a page or a project, and tabs drag sideways like a browser's
- A project is a layout of panels you arrange yourself: Conversation, Overview, Tasks, Documents, Gallery, Console, Usage and more. Drag a panel to move or copy it, maximize it, and save layouts per workspace
- A project tree with your root folders, favorites, simple chats, and the projects of your other computers
- A status bar with the server, the GPU meter, the hub and your other computers, and a Sync panel

**Conversations**
- Chat with Claude Code about any project: model, permission mode (including Auto and Accept all) and effort per conversation; a conversation remembers its mode
- Plain chats, like on claude.ai: no project and no files, web search only. Bring your claude.ai chats over from a data export with `node tools/import-claude-ai.mjs conversations-000.zip`
- Attach pictures and files (with upload progress), send a message while Claude is still answering, answer Claude's permission requests and questions (a question now waits up to 24 hours)
- Claude names its own conversation, and renames it when the subject has moved for good
- Shrink: drop the heavy parts of a long conversation (pictures, big tool outputs) and keep every message
- Prompt cache countdown, with an automatic compact before it runs out when the cache is large
- Mission Control keeps your conversations: Claude Code's 30-day cleanup is turned off

**Tasks**
- One task list for every project: a board (Inbox, To do, Doing, Review, Done), a list and a week view, with goals that a set of tasks counts toward
- Claude reads and writes the same list through Mission Control's own MCP server (wired in automatically), so it can add tasks, tick steps and send work to Review
- A task id in a message (MC-40) is a link to the task

**Documents and notes**
- The project folder and your notes folders (an Obsidian vault, for example) as folder trees: read, edit, make, rename, move and delete notes
- Notes can sync between computers through the hub, with git under the hood

**Local models**
- llama.cpp models in the model list next to Claude's, started when a message needs them and stopped when idle
- Their cost in electricity on the Usage page, and a speed benchmark on the System page

**Com Link, the voice assistant**
- Talk to an assistant by voice: wake word, live words while you speak, spoken answers. Train your own wake word on the Settings page
- Its own name, personality and memory, which you can change on the Settings page
- Needs [BlitzVoice](https://github.com/Accent-Studio/BlitzVoice) for speech-to-text and read aloud

**System and usage**
- GPU memory and RAM per process, models loaded in Ollama, llama.cpp, llama-swap, LM Studio and ComfyUI, with Unload buttons, a 24 hour history and a planner that shows what to unload to make room
- What Claude did and what it would cost at API prices, by day, model, project and conversation, plus your plan usage over time

**More than one computer (optional)**
- A hub: an always-on Mission Control (a small Linux box is enough) that keeps your chats, tasks, layouts and notes, so the phone works with every PC off
- Linked computers: see and continue another computer's conversations live, open its projects, start a conversation in one of them, and sync shared repositories from the Sync panel
- A PIN lock for a computer, typed once a day on the other one

**Phone app**
- An Android app that pairs with your computer (or the hub) by QR code and shows Mission Control 2 from anywhere, through an encrypted peer-to-peer link ([iroh](https://www.iroh.computer)): no port forwarding and no account. It dictates on the phone itself, so the mic works with the PC off

## Requirements

- Windows 10 or 11, or macOS. A hub runs on Linux
- [Node.js](https://nodejs.org) 22 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in a terminal)
- Git

Optional:
- [BlitzVoice](https://github.com/Accent-Studio/BlitzVoice), for the voice assistant
- [Rust](https://rustup.rs), for the phone bridge and the link to the hub and to your other computers
- Android Studio with NDK 25.1, [Bun](https://bun.sh) and Rust's Android target, to build the phone app
- Python 3.11 and an NVIDIA GPU, to train a wake word
- [llama.cpp](https://github.com/ggml-org/llama.cpp), for local models

## Start it

On Windows:

```powershell
git clone https://github.com/Accent-Studio/Mission-Control.git
cd Mission-Control
.\start.bat
```

`start.bat` starts the server in a small window of its own and opens Mission Control 2 in your browser.

On macOS, double-click `start-mac.command` in Finder (or run it in Terminal). The server's output shows in that Terminal window.

Mission Control only listens on your own computer.

## Your settings

By default Mission Control shows every project folder next to its own folder. To choose other folders, copy `config.example.json` to `.data/config.json` and edit it:

- `machineName`: the name of this computer, "Home" or "Work" for example
- `discoveryRoots`: folders whose subfolders are your projects (you can also add and remove them from the project tree)
- `defaultCwd`: where a new conversation starts when no project is chosen
- `extraProjects`: single projects that live somewhere else
- `notesRoot`, `notesProjectDir`, `notesFolders`: a notes folder (an Obsidian vault, for example) whose folders show up on project pages
- `notesRepos`: notes vaults to keep in step with the hub, each `{ "id": "notes", "dir": "<folder>" }` and a git repository
- `openDrives`: drives on which Claude may work in any folder, not only inside your projects
- `projectAliases`, `projectAbout`: old folder names of renamed projects, and one-line descriptions
- `wakeTrainerDir`: where the wake word trainer lives, if not in `waketrainer`
- `mcpStarterServers`: the `servers.json` of a lazy MCP starter, if you use one; Connections then lists every server in it and marks the ones Claude Code no longer starts as "not registered"
- `localModels`: llama.cpp models to offer in conversations (see the example)
- `electricity`: the price of a kWh in your currency and its exchange rate to the dollar, to price local models
- `role`: `"hub"` on the computer that should be the hub

Restart Mission Control after a change. Everything Mission Control saves (your settings, keys, logs, drafts, tasks) stays in `.data`, which is never in git.

The assistant's personality lives in `server/prompts/comlink.md`. To write your own, put it in `.data/comlink-prompt.md`; `{{name}}` in it becomes the name set on the Settings page.

## The phone app

1. Build the bridge once: `bridge\build-bridge.bat` on Windows. On macOS or Linux, run `cargo build --release` in `bridge` and copy `mc-bridge` and `mc-link` from the build's `release` folder into `bridge/run`. Mission Control starts the bridge by itself from then on.
2. Make a signing key and copy `phone\src-tauri\gen\android\keystore.properties.example` to `keystore.properties` next to it.
3. Build the app: `powershell -File phone\build-android.ps1 -ReleaseOnly`. It prints where the APK is.
4. Install the APK on your phone, open Connections in Mission Control, and scan the pairing code.

## The hub

1. On an always-on Linux machine, clone Mission Control, build the bridge (step 1 above), sign Claude Code in, and put `{ "role": "hub", "machineName": "Hub" }` in `.data/config.json`.
2. Start it with `server/run-hub.sh`. Its first lines show the cron lines that start it at boot and bring it back if it stops.
3. On each computer, open Connections and pair it with the hub in the Hub panel. The panel also shows what the sync is doing.

## Set it up with an agent

[SETUP-WITH-AN-AGENT.md](SETUP-WITH-AN-AGENT.md) is a prompt for Claude Code (or another coding agent). Paste it in and the agent installs Mission Control, BlitzVoice and the phone app, asks about your folders and projects, and sets everything up with you.

## License

[PolyForm Shield 1.0.0](LICENSE). You may use, change and share Mission Control, including for your own paid work. You may not offer it, or anything built from it, as a product that competes with it (sold, hosted or free). Keep the license and the `Required Notice` line when you share it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
