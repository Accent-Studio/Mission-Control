# Mission Control

**A dev dashboard for people who build with Claude Code.** Every project on your PC in one place: its build state, its changes, its conversations with Claude, its scripts, and the GPU memory your local AI models are using. Talk to Claude from the browser or your phone, by text or by voice.

Mission Control is a small local web server (Node.js, no npm packages) that you open in a browser tab. It drives the official Claude Code command line tool, signed in with your own account.

## What it does

**Home**
- Your projects as planets in a star system, or as cards in an office view
- What is running right now: Claude conversations, helper agents, dev servers

**Project pages**
- A status panel: build checks, uncommitted changes and unpushed commits, each with its fix button
- Launch buttons for the project's own scripts (dev run, build, install, release), found in its folder
- Docs and Screenshots tabs: the project's files and its notes folders, read only
- Commits, conversations and settings tabs
- A little spaceship whose crew shows the Claude agents working on the project, live

**Talk page**
- Chat with Claude Code about any project: model, permission mode and effort per conversation
- Attach pictures and files, send a message while Claude is still answering, answer Claude's permission requests and questions
- Drafts follow you between the PC and the phone, and a message can be sent later
- Prompt cache countdown, with an automatic handoff or compact before it runs out

**Com Link, the voice assistant**
- Talk to an assistant by voice: wake word, live words while you speak, spoken answers
- Its own name, personality and memory, which you can change on the Settings page
- Needs [BlitzVoice](https://github.com/Accent-Studio/BlitzVoice) for speech-to-text and read aloud

**System**
- GPU memory and RAM per process, models loaded in Ollama, llama.cpp, llama-swap, LM Studio and ComfyUI, with Unload buttons
- A 24 hour GPU memory history, and a planner that shows what to unload to make room

**Usage**
- What Claude did and what it would cost at API prices, by day, model, project and conversation, plus your plan usage over time

**Connections**
- MCP servers and AI services in one list
- Pair your phone, and train your own wake word (see `waketrainer`)

**Phone app**
- An Android app that pairs with your PC by QR code and shows Mission Control from anywhere, through an encrypted peer-to-peer link ([iroh](https://www.iroh.computer)): no port forwarding and no account

## Requirements

- Windows 10 or 11 (the only system it is tested on; Linux and macOS may need changes to the scripts and a few Windows-only features)
- [Node.js](https://nodejs.org) 22 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude` works in a terminal)
- Git

Optional:
- [BlitzVoice](https://github.com/Accent-Studio/BlitzVoice), for the voice assistant
- [Rust](https://rustup.rs), for the phone bridge
- Android Studio with NDK 25.1, [Bun](https://bun.sh) and Rust's Android target, to build the phone app
- Python 3.11 and an NVIDIA GPU, to train a wake word

## Start it

```powershell
git clone https://github.com/Accent-Studio/Mission-Control.git
cd Mission-Control
.\start.bat
```

`start.bat` starts the server in a small window of its own and opens http://127.0.0.1:1700 in your browser. Mission Control only listens on your own PC.

## Your settings

By default Mission Control shows every project folder next to its own folder. To choose other folders, copy `config.example.json` to `.data\config.json` and edit it:

- `discoveryRoots`: folders whose subfolders are your projects
- `defaultCwd`: where a new conversation starts when no project is chosen
- `extraProjects`: single projects that live somewhere else
- `notesRoot`, `notesProjectDir`, `notesFolders`: a notes folder (an Obsidian vault, for example) whose folders show up on project pages
- `openDrives`: drives on which Claude may work in any folder, not only inside your projects
- `projectAliases`, `projectAbout`: old folder names of renamed projects, and one-line descriptions
- `wakeTrainerDir`: where the wake word trainer lives, if not in `waketrainer`
- `mcpStarterServers`: the `servers.json` of a lazy MCP starter, if you use one; Connections then lists every server in it and marks the ones Claude Code no longer starts as "not registered"

Restart Mission Control after a change. Everything Mission Control saves (your settings, keys, logs, drafts) stays in `.data`, which is never in git.

The assistant's personality lives in `server\prompts\comlink.md`. To write your own, put it in `.data\comlink-prompt.md`; `{{name}}` in it becomes the name set on the Settings page.

## The phone app

1. Build the bridge once: `bridge\build-bridge.bat`. Mission Control starts it by itself from then on.
2. Make a signing key and copy `phone\src-tauri\gen\android\keystore.properties.example` to `keystore.properties` next to it.
3. Build the app: `powershell -File phone\build-android.ps1 -ReleaseOnly`. It prints where the APK is.
4. Install the APK on your phone, open Connections in Mission Control, and scan the pairing code.

## Set it up with an agent

[SETUP-WITH-AN-AGENT.md](SETUP-WITH-AN-AGENT.md) is a prompt for Claude Code (or another coding agent). Paste it in and the agent installs Mission Control, BlitzVoice and the phone app, asks about your folders and projects, and sets everything up with you.

## License

[PolyForm Shield 1.0.0](LICENSE). You may use, change and share Mission Control, including for your own paid work. You may not offer it, or anything built from it, as a product that competes with it (sold, hosted or free). Keep the license and the `Required Notice` line when you share it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
