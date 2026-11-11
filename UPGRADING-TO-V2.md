# Upgrading to Mission Control 2

For people who run Mission Control 1 and have added their own pages, routes or tools to it. Copy everything below the line into Claude Code, started in the folder that holds your Mission Control checkout. Claude sets up Mission Control 2 next to your current copy, brings your settings and data over, and moves your own additions across with you.

In short: Mission Control 2 is a fresh install next to the old one. Your `.data` folder works as it is, and the old copy stays untouched as a backup until you delete it yourself.

---

You are helping me move my Mission Control from version 1 to version 2. I have added my own pages, server routes or tools to version 1, and I want to keep them. Mission Control is a local Node.js dashboard for Claude Code (no npm packages). Its repository is https://github.com/Accent-Studio/Mission-Control.

## How to work with me

- Ask before you install anything, stop a running program, or change anything outside the two Mission Control folders. Never delete my version 1 folder or its `.data`: copy, never move.
- Ask one question at a time, with a sensible default I can accept by saying "yes".
- Never ask me to paste a password, key or token into this chat.
- Check each step before you go on, and tell me in one or two lines what worked. If something fails, show the error and suggest the fix.
- Commit my own work in the new copy as you go, on a branch of its own, with plain commit messages. Never push anywhere unless I ask.
- At the end, give me a short summary: where version 2 lives, what was moved over and how, what still uses an old page, and what was skipped.

## What changed in version 2

Read this first, then read `README.md` in the new copy.

- **A new interface at `/v2/`** (`app/v2/`). It is one window: a rail with pages, browser-like tabs, and projects built from panels that the user arranges. The start scripts open it. The version 1 pages (`app/*.html`) are still served at `/`, so an old-style page keeps working, but the version 2 interface is where new work goes.
- **Server routes plug in as before.** Every `server/routes/*.js` that exports `routes = [{ method, path, handler }]` is loaded on its own. What is stricter: every route that is not a GET must be named in `server/lib/remote-policy.js` (`REMOTE_OK`, `PC_ONLY`, `PC_ONLY_READ` or `COMPUTER_OK`), or phones and other computers get `403` and the server logs an error at start. When a PIN lock is set, another computer can only reach routes listed in `LOCK_OPEN` in `server/services/pcLock.js` until it unlocks.
- **`.data` carries over as it is.** Every version 1 file is still read under the same name and format; version 2 only adds files (tasks, chats, links, local models and more). `config.json` keeps every version 1 key and adds optional ones (`machineName`, `localModels`, `electricity`, `notesRepos`, `role`). Version 2 may now rewrite `discoveryRoots` in `config.json` when root folders are added or removed in the project tree.
- **Claude gets Mission Control's own MCP server** (tasks, conversation names, local models). It is wired in automatically, there is nothing to set up. Custom tools for Claude can go into the `TOOLS` list in `server/services/mcp.js`.
- **The runner must be restarted cold.** The runner (the program that owns the Claude processes) survives server restarts on purpose. A version 1 runner left running will not start version 2 conversations properly. Stop the old server, its runner and its phone bridge completely before starting version 2.
- **The bridge needs a fresh build**, because version 2 adds a second program to it (`mc-link`, for the hub and linked computers). See "The phone app" in the README.
- **macOS works now** (`start-mac.command`), and an optional hub runs on Linux.

## Step 1: Take stock of my version 1 copy

1. Find my version 1 folder and confirm it with me.
2. Find the upstream commit my copy started from. Add the upstream repository if it is missing (`git remote add upstream https://github.com/Accent-Studio/Mission-Control.git`; if a remote still points at `github.com/Guts501/Mission-Control`, change it to the Accent-Studio address), fetch it, and use `git merge-base HEAD upstream/main`. If my copy is not a git checkout, compare it file by file with the upstream commit that matches it best and tell me which one you used.
3. List everything I changed since that commit, committed or not (`git diff --stat <base>`, `git status`). Sort it into:
   - new pages (`app/*.html`, and their lines in the rail in `app/redline.js`)
   - new server routes (`server/routes/`), services (`server/services/`), libraries and prompts
   - new settings (`server/config.js`, `config.example.json`) and per-project jobs (`.data/jobs-seed.json`)
   - edits to files that came with Mission Control
   - anything else (scripts, assets, notes)
4. Show me the list with one line per item saying what it does, and ask me which ones I still want. Skip what I no longer use.

## Step 2: Install version 2 next to it

1. Ask me where version 2 should live (default: a folder named `Mission-Control-2` next to the old one).
2. Clone it: `git clone https://github.com/Accent-Studio/Mission-Control.git <folder>`, and make a branch for my own work (`git switch -c mine`).
3. Copy my `.data` folder from version 1 into the new folder. On macOS or Linux, keep it private (`chmod 700 .data`).
4. Ask me to stop version 1 completely: its server window, the runner and the phone bridge. Check that nothing answers on ports 1700, 1701 and 1702 before going on.
5. Build the bridge as the README says, if I use the phone app.
6. Start version 2 (`start.bat` on Windows, `start-mac.command` on macOS) and ask me to check that my projects, conversations and settings are there before you move anything over.

## Step 3: Move my additions over

Work through the items I kept, one at a time, and let me check each one in the browser before the next.

**Server routes, services and settings.** Copy them over mostly as they are, then:
- Compare every Mission Control file they import with its version 2 copy, and adapt calls that changed.
- Name every route that is not a GET in `server/lib/remote-policy.js`. Ask me whether my phone or my other computers should be allowed to call it.
- Add new settings to `server/config.js` and `config.example.json` the way the existing ones are written.
- Run `npm test` (it includes a check that every route is in the policy).

**Pages.** For each page, ask me which way I want it, and recommend the second:
1. *Keep the old page as it is.* Copy the `.html` file into `app/` and its line into the rail in `app/redline.js`. Quick, but it lives in the old interface at `/`, not in version 2.
2. *Make it a version 2 page.* Use an existing page as the model (`app/v2/pg-usage.js` and `pg-usage.css`, or `pg-automation.js`). A page needs: a `<section class="page" data-page="<name>"><div class="spage" id="pg<Name>"></div></section>` in `app/v2/index.html`, an entry in its `PAGES` list (which draws the rail) and its `INFO` list (the title), the `<link>` and `<script>` tags for its files, and a `pg-<name>.js` that sets `MC.drawPage.<name> = (el) => { ... }` (and optionally `MC.pageBar.<name>`). Use the shared styles and helpers in `app/v2/base.css`, `panels.js` and `modules.js` so it matches the rest.
3. *Make it a panel* when it belongs to a project and should sit next to a conversation or the tasks. Use `app/v2/pg-crew.js` as the model: it sets `MC.modules.<id> = { label, icon, render(vp), mount(el, vp) }`, and the id goes into the `MC.groups` list in `app/v2/modules.js` so it shows in the panel menu.

Keep my code in files of its own wherever you can, and edits to Mission Control's own files small (a line in a list, a script tag). That keeps later updates easy.

**Edits I made to Mission Control's own files.** Many of these files changed a lot in version 2. Do not paste old versions over new ones. For each edit, find where that behavior lives now, tell me whether version 2 already does it, and redo it by hand only if I still need it.

**Tools for Claude.** If I gave Claude tools of my own (skills, MCP servers, slash commands), check that they still work from a version 2 conversation. A tool that should read or change Mission Control's own data can go into `server/services/mcp.js`.

## Step 4: Check and wrap up

1. Run `npm test` and fix what my changes broke. A failing test that also fails on a clean version 2 checkout is not mine: tell me and move on.
2. Open each moved page and panel in the browser with me, on the computer and on the phone if I use it.
3. Commit my work on my branch.
4. Tell me how to take later updates: `git fetch origin`, then `git merge origin/main` on my branch, then restart Mission Control, and its runner too when the server log says the runner is older.
5. Remind me that the version 1 folder is still there as a backup, and that I can delete it once I am happy.
