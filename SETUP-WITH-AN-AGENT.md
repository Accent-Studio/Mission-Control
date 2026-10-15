# Set up Mission Control with an agent

Copy everything below the line into Claude Code (or another coding agent that can run commands on your PC), started in the folder where you keep your code. The agent installs Mission Control, BlitzVoice and the phone app, and sets them up for your projects with you.

---

You are setting up Mission Control, a local dev dashboard, for me on my Windows PC, together with BlitzVoice (dictation and read aloud, which gives Mission Control its voice) and the Mission Control phone app. Work through the steps below in order. Read each repository's README before you work in it.

## How to work with me

- Ask me before you install anything, change anything outside the folders we agree on, or run anything that takes a long time. Tell me roughly how long it takes.
- Ask one question at a time, with a sensible default I can accept by saying "yes". Explain any technical word in a few plain words.
- Never ask me to paste a password, key or token into this chat. When something needs one, tell me where to type it myself.
- Check each step before you move on, and tell me in one or two lines what worked. If something fails, say so plainly with the error, and suggest the fix.
- If your shell runs in a sandbox or app container that redirects writes under AppData, do not run installers or launch the apps from it. Ask me to double-click the script instead.
- At the end, give me a short summary: what is installed where, how to start each thing, and what was skipped.

## Step 1: Check the system

First find out which operating system I am on, and tell me.

Mission Control, BlitzVoice and the phone app are built and tested on Windows 10 and 11 only. On Linux or macOS, expect to adapt things as you go: the `.bat` and `.ps1` scripts need shell equivalents, Windows paths and drive letters in the settings become normal paths, and some features call Windows tools (GPU and process lists, opening Explorer, the BlitzVoice build scripts). BlitzVoice is based on Handy, which also runs on Linux and macOS: follow its BUILD.md for those systems instead of the Windows scripts. Tell me before each change you make to the code, keep the changes small, and list them in the summary at the end. If something cannot work on my system, say so and skip it.

## Step 2: Check the basics

Check these and offer to install what is missing (winget works well on Windows; use the system's package manager elsewhere):

- Git: `git --version`
- Node.js 22 or newer: `node --version`
- Claude Code, installed and signed in: `claude --version`, and ask me to confirm it is signed in to my account

## Step 3: Choose the folders

Ask me:

1. Where should Mission Control and BlitzVoice live? Suggest a folder next to my other code, on a drive with free space.
2. Which folders hold my projects? Mission Control lists every subfolder of these folders as a project (for example `D:\Dev` and `D:\Games`).
3. Are there single projects somewhere else (for example an Unreal plugin inside a host project)? For each, I need an id (lowercase, dashes), a display name and the folder.
4. Where should a new conversation start when no project is chosen? Default: the first project folder.
5. Do I keep notes about my projects in a folder, for example an Obsidian vault? If yes: where is it, is there one folder inside it that holds a folder per project (`notesProjectDir`), and should any project show other note folders too (`notesFolders`)?
6. Should Claude be allowed to work in any folder on some drives, not only inside my projects (`openDrives`)? Explain that this widens what a conversation started from Mission Control can touch. Default: no.
7. Did I rename any project folder? Its old folder name lets Mission Control match older conversations (`projectAliases`).

## Step 4: Install Mission Control

1. Clone it into the chosen folder: `git clone https://github.com/Accent-Studio/Mission-Control.git`
2. Copy `config.example.json` to `.data\config.json` and fill it in with my answers from step 3. Remove the example entries I do not need. Use double backslashes in Windows paths, because it is JSON.
3. Start it with `start.bat` (ask me to double-click it if your shell is sandboxed). It opens http://127.0.0.1:1700.
4. Check `http://127.0.0.1:1700/api/health` answers, then ask me to confirm my projects show up on Home.

## Step 5: Add my projects' scripts and build checks

For each project I care about (ask me which ones):

1. Look in its folder for scripts (`.bat`, `.cmd`, `.ps1`) that run a dev build, build a release, install the app, publish, and so on. Ask me which ones should get a button.
2. Read each chosen script. If it contains paths that only fit one machine (a drive letter, a user folder), offer to make them relative to the script's own folder (`%~dp0` in a .bat, `$PSScriptRoot` in PowerShell) or to read them from an environment variable. Ask before changing anything, and keep the change small.
3. Add the buttons on the project's Settings tab in Mission Control (Jobs, then "Other scripts in this folder"), or show me how. Scripts that send something off the PC (publish, push, deploy) must be marked as such.
4. Optional, build checks: Mission Control can tell whether a build is fresh or stale by comparing a built file with the source. These live in `.data\projects.json`, one entry per project, in this shape:

```json
{
  "id": "my-app",
  "name": "My App",
  "folder": "D:\\Dev\\MyApp",
  "about": "One line about it.",
  "watch": [".", ":!*.md"],
  "checks": [
    {
      "key": "exe",
      "label": "Exe",
      "artifact": ["D:\\Dev\\MyApp\\build\\MyApp.exe"],
      "against": "",
      "watch": [],
      "build": { "run": "build-release.bat", "args": "" },
      "launch": { "run": "@artifact", "args": "" },
      "launch_label": "App"
    }
  ]
}
```

`artifact` accepts wildcards and `%LOCALAPPDATA%`-style variables. `against: "check:exe"` makes a check (such as an installed copy) stale whenever the `exe` check is newer. Stop Mission Control (close its server window) before you edit `.data\projects.json`, and start it again afterwards. The file has a top-level `"projects"` list; keep the entries Mission Control already wrote.

## Step 6: Set up the voice assistant's personality

Mission Control has a voice assistant, the Com Link. Ask me:

1. What should it be called? Default: Com Link.
2. What personality should it have? Offer a few ideas (a calm mission controller, a cheerful copilot, a dry butler, a character I like), and ask how it should address me.
3. Anything it should know about me or how I like answers?

Then:

- Set the name on Mission Control's Settings page, or with `PUT http://127.0.0.1:1700/api/voice/prefs` and the body `{"comlinkName": "<name>"}` (the request needs the header `X-MC: 1`).
- Write my own prompt to `.data\comlink-prompt.md`. Start from `server\prompts\comlink.md` and change only "Who you are", "Your personality" and the examples. Keep the rules in "How you speak", "How you report" and "Your memory" as they are: the answers are read aloud, and the memory tags must keep their exact form. `{{name}}` in the prompt becomes the name from the Settings page.
- Show me the personality part and ask if it sounds right.

## Step 7: Install BlitzVoice

BlitzVoice turns speech into text for the Com Link and reads its answers aloud. Ask me if I want it; without it, Mission Control works but has no voice.

1. Clone it next to Mission Control: `git clone https://github.com/Accent-Studio/BlitzVoice.git`
2. Follow its README, "Build it on Windows": Rust, Bun, Visual Studio 2022 with the C++ workload, CMake, the Vulkan SDK, and ONNX Runtime 1.24.2 unpacked into its `_deps` folder. Check each one and ask before installing.
3. If I want the downloads or the build folder somewhere else, copy `scripts\local-paths.example.ps1` to `scripts\local-paths.ps1` and set them there. Never edit the scripts themselves for that.
4. `bun install`, then `scripts\install-release.bat`. The first build takes a long time (often 20 to 40 minutes). Ask me to double-click it if your shell is sandboxed. Some antivirus tools kill fresh, unsigned builds that write many files: if the build dies with no error, check the antivirus log and allow the build folder.
5. Ask me to open BlitzVoice, pick a speech model, and in Advanced settings turn on the Mission Control link. Then check that Mission Control's Talk button works.

## Step 8: Build the phone app (optional)

Ask me if I want to use Mission Control from my Android phone.

1. Install Rust if it is missing, then build the bridge: `bridge\build-bridge.bat`. Close Mission Control's server window and start `start.bat` again, so the bridge starts.
2. Install Android Studio, then the Android SDK and NDK 25.1.8937393 from its SDK Manager. Add Rust's Android target: `rustup target add aarch64-linux-android`. Run `bun install` in the `phone` folder.
3. Make my signing key with the JDK's `keytool` (the command is in `phone\src-tauri\gen\android\keystore.properties.example`), in a folder outside the repository that I choose. Let me type the password myself. Copy the example file to `keystore.properties` next to it and fill it in. Tell me to back up the key: every update needs the same key.
4. Build: `powershell -File phone\build-android.ps1 -ReleaseOnly`. It prints where the APK is.
5. Ask me how I get files onto my phone (a cable, or a cloud folder like Dropbox or Google Drive) and put the APK there.
6. On the phone: install the APK, open it, and scan the pairing code from Mission Control's Connections page.

## Step 9: Train a wake word (optional)

Mission Control can train a custom wake phrase ("hey mission control", or anything else) for BlitzVoice. It needs an NVIDIA GPU, Python 3.11 and about 30GB of disk space, and a training run takes about 45 minutes. Ask me first.

Follow `waketrainer\README.md` ("One-time setup"). Then the Wake words section on Mission Control's Settings page runs the training and installs the model into BlitzVoice.

## Step 10: Wrap up

- Confirm Mission Control starts with `start.bat` and lists my projects.
- Offer to put a shortcut to `start.bat` on my desktop or in the Start menu.
- Give me the summary described at the top.
