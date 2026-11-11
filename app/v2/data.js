/* Fake data for the revamp mockups. Nothing here talks to a server. */
window.MC = window.MC || {};
MC.data = (() => {
  const shots = '../redline-soft/shots/';
  const refs = '../../research/gallery/images/DarkMode/';
  const img = (src, title, kind, when, by) => ({ src, title, kind, when, by });

  const places = [
    { id: 'home', name: 'Home PC', sub: 'This computer', online: true, icon: 'pc' },
    { id: 'work', name: 'Work PC', sub: 'Last seen 2 h ago', online: false, icon: 'pc' },
    { id: 'hub', name: 'Hub', sub: 'Linux, always on', online: true, icon: 'server' },
  ];

  const roots = [
    { path: 'D:\\Dev', open: true, items: [
      { name: 'MissionControl', fav: true, running: 2, due: 3, tint: '#8fb0ff' },
      { name: 'BlitzRaw', fav: true, running: 1, due: 1, tint: '#e8a25a' },
      { name: 'BlitzVoice', running: 0, due: 0, tint: '#7fd0c8' },
      { name: 'PhotoSync', tint: '#b59cff' },
      { name: 'Website', tint: '#d58fb8' },
      { name: 'WakeTrainer', tint: '#9ccf7a' },
      { name: 'Scratch', tint: '#c9c9c9' },
      { name: 'ReadingList', tint: '#c9b27a' },
      { name: 'TimeTracker', tint: '#7aa7c9' },
      { name: 'ImageLab', tint: '#c97a7a' },
      { name: 'Experiments', folder: true, items: [
        { name: 'NotesPlugin', tint: '#a08fd5' },
        { name: 'MediaKeys', tint: '#8fd5a0' },
        { name: 'McpTools', tint: '#d5c08f' },
      ] },
    ] },
    { path: 'D:\\Games', open: false, items: [
      { name: 'SpaceRacer', due: 2, tint: '#e0b04a' },
      { name: 'RedPlanet', tint: '#d0705a' },
      { name: 'CardTable', tint: '#8fc07a' },
      { name: 'SkyCity', tint: '#7a9fe0' },
      { name: 'AvatarLab', tint: '#c08fd0' },
    ] },
  ];

  const chats = [
    { id: 'c1', title: 'Best way to store RAW previews', when: '2 h' },
    { id: 'c2', title: 'Which monitor arm for a 34 inch screen', when: 'yesterday' },
    { id: 'c3', title: 'Explain Tauri vs Electron', when: 'Oct 24' },
    { id: 'c4', title: 'Translate the press kit to French', when: 'Oct 19' },
  ];

  /* Sessions: groups hold sessions; a session can hold children (nested sessions started by a master) and side chats. */
  const sessions = [
    { group: 'Pinned', items: [
      { id: 's1', title: 'UI revamp: viewports and themes', state: 'run', when: 'now', model: 'Opus 5.5', msgs: 64, master: true, children: [
        { id: 's1a', title: 'Mockup A: Dual rail', state: 'done', when: '4 min', kind: 'nested' },
        { id: 's1b', title: 'Mockup B: Studio', state: 'run', when: 'now', kind: 'nested' },
        { id: 's1c', title: 'Mockup C: Spine', state: 'wait', when: '1 min', kind: 'nested' },
        { id: 's1d', title: 'Side chat: Electron or Tauri?', state: 'idle', when: '12 min', kind: 'side' },
      ] },
    ] },
    { group: 'Hub and phone', items: [
      { id: 's2', title: 'The phone works with every PC off', state: 'done', when: '4 d', model: 'Opus 5.5', msgs: 212 },
      { id: 's3', title: 'Hub trash folder on Linux', state: 'done', when: '4 d', model: 'Sonnet 5.5', msgs: 48 },
      { id: 's4', title: 'Pairing code opens pairing screen', state: 'fail', when: '4 d', model: 'Opus 5.5', msgs: 77 },
    ] },
    { group: 'Conversations page', items: [
      { id: 's5', title: 'Shrink: drop heavy parts you tick', state: 'done', when: '5 d', model: 'Opus 5.5', msgs: 301, children: [
        { id: 's5a', title: 'Side chat: what counts as heavy?', state: 'idle', when: '5 d', kind: 'side' },
      ] },
      { id: 's6', title: 'Show more lists older conversations', state: 'done', when: '5 d', model: 'Sonnet 5.5', msgs: 39 },
    ] },
    { group: 'Earlier', items: [
      { id: 's7', title: 'Send later past 360 days', state: 'done', when: '5 d', model: 'Haiku 5.5', msgs: 12 },
      { id: 's8', title: 'cleanupPeriodDays to 100 years', state: 'done', when: '5 d', model: 'Opus 5.5', msgs: 58 },
      { id: 's9', title: 'Wake word retraining keeps runs', state: 'done', when: '5 d', model: 'Opus 5.5', msgs: 140 },
    ] },
  ];

  const messages = [
    { who: 'me', t: '10:02', text: 'Can you make the project page and the Talk page one thing? I want to see the conversation next to the tasks and the docs.' },
    { who: 'claude', t: '10:02', text: 'Yes. I read how both pages build their panels. The plan: one project screen with up to three viewports. Each viewport has a menu to pick what it shows.', steps: [
      { k: 'Read', d: '4 files', x: 'app/chat.html, app/project.html, app/redline.js, app/redline.css', ok: true },
      { k: 'Grep', d: '"data-tab"', x: '9 matches in 2 files', ok: true },
    ] },
    { who: 'claude', t: '10:04', text: 'I added three tasks for this to the project, and saved a screenshot of the current project page to the gallery.', actions: [
      { icon: 'check', text: 'Added task', ref: 'Viewport layout engine', mod: 'tasks' },
      { icon: 'check', text: 'Added task', ref: 'Project tree selector', mod: 'tasks' },
      { icon: 'image', text: 'Saved to gallery', ref: '2-project.png', mod: 'gallery' },
    ] },
    { who: 'me', t: '10:06', text: 'Nice. Open the dev server and check the hamburger menu works at 3440 wide.' },
    { who: 'claude', t: '10:07', text: 'I opened localhost:1700 in the built-in browser at 3440 × 1440 and clicked each viewport menu. All three open, and the module list fits.', steps: [
      { k: 'Browser', d: 'open localhost:1700', x: '3440 × 1440, 0 console errors', ok: true },
      { k: 'Browser', d: 'click .vp-menu × 3', x: 'menus open, nothing clipped', ok: true },
      { k: 'Screenshot', d: 'viewports-3col.png', x: 'saved to gallery', ok: true },
    ], actions: [
      { icon: 'globe', text: 'Used the browser', ref: 'localhost:1700', mod: 'browser' },
      { icon: 'tick', text: 'Ticked off', ref: 'Hamburger menu per viewport', mod: 'tasks' },
    ] },
    { who: 'claude', t: '10:08', text: 'The desktop build is ready. I cannot run installers from my own shell (they land in a sandbox copy that Windows never sees), so please run this one yourself:', cmd: { shell: 'PowerShell', line: '& "D:\\Dev\\Installers\\MissionControl\\MissionControl-Setup-2.0.0.exe"' } },
    { who: 'claude', t: '10:08', ask: { title: 'Claude wants to run a command', body: 'npm run build:desktop', note: 'Builds the desktop app in D:\\Dev\\Temp\\builds\\missioncontrol' } },
  ];

  const tasks = [
    { id: 't1', title: 'Viewport layout engine', status: 'doing', urg: 'high', due: 'Oct 30', tags: ['UI'], by: 'claude', subs: [
      ['Columns with drag handles', true], ['Save layout per project', true], ['Rows inside a column', false], ['Pop a viewport out to its own window', false] ] },
    { id: 't2', title: 'Project tree selector', status: 'doing', urg: 'med', due: 'Nov 2', tags: ['UI'], by: 'claude', subs: [
      ['Roots from settings', true], ['Places: Home, Work, Hub', false], ['Search and favorites', false] ] },
    { id: 't3', title: 'Hamburger menu per viewport', status: 'done', urg: 'med', due: 'Oct 27', tags: ['UI'], by: 'me', subs: [['Grouped list', true], ['Keyboard', true]] },
    { id: 't4', title: 'Pick Electron or Tauri', status: 'todo', urg: 'crit', due: 'Oct 29', tags: ['Desktop'], by: 'me', subs: [['Try Tauri with the Node server as a sidecar', false], ['Tray icon and autostart', false]] },
    { id: 't5', title: 'Slate theme', status: 'review', urg: 'med', due: 'Nov 4', tags: ['Theme'], by: 'me', subs: [['Tokens', true], ['Redline still works', true], ['Charts', false]] },
    { id: 't6', title: 'Task tools for Claude (MCP)', status: 'todo', urg: 'high', due: 'Nov 8', tags: ['Claude'], by: 'me', subs: [['add_task', false], ['tick_task', false], ['set_reminder', false], ['gallery_search', false]] },
    { id: 't7', title: 'Pairing code test fails on the hub', status: 'blocked', urg: 'high', due: 'Oct 28', tags: ['Hub'], by: 'claude', subs: [['Find why the code expires', true], ['Fix the clock skew', false]] },
    { id: 't8', title: 'Release notes for 2.0', status: 'todo', urg: 'low', due: 'Nov 15', tags: ['Docs'], by: 'me', subs: [] },
    { id: 't9', title: 'Shrink: test with a 40 MB conversation', status: 'done', urg: 'low', due: 'Oct 23', tags: ['Talk'], by: 'claude', subs: [['Make the test file', true], ['Measure', true]] },
  ];

  /* tasks of other projects, for the Everything switch */
  const otherTasks = [
    { id: 'o1', proj: 'BlitzRaw', title: 'Release 1.4.3', status: 'blocked', urg: 'crit', due: 'Oct 29', tags: ['Release'], by: 'me', subs: [['Build', true], ['Release notes', false], ['Sign the installer', false]] },
    { id: 'o2', proj: 'BlitzRaw', title: 'History panel: export list', status: 'doing', urg: 'high', due: 'Oct 30', tags: ['UI'], by: 'claude', subs: [['List view', true], ['CSV export', false]] },
    { id: 'o3', proj: 'BlitzVoice', title: 'Rebuild the installed copy', status: 'todo', urg: 'med', due: 'Oct 31', tags: ['Build'], by: 'me', subs: [] },
    { id: 'o4', proj: 'PhotoSync', title: 'Settings backup restore test', status: 'review', urg: 'med', due: 'Nov 1', tags: ['Test'], by: 'claude', subs: [['Restore', true], ['Compare', false]] },
    { id: 'o5', proj: 'SpaceRacer', title: 'Track 2 lighting pass', status: 'todo', urg: 'low', due: 'Nov 9', tags: ['Art'], by: 'me', subs: [['Bake the lightmaps', false]] },
  ];

  /* time tracking: hours of the day (decimal) per project and per session, events, and a week of totals */
  const timeline = {
    now: 10.15,
    projects: [
      ['MissionControl', '#8fb0ff', [[0.2, 1.1], [8.7, 10.15]]],
      ['BlitzRaw', '#e8a25a', [[1.1, 2.4], [9.3, 9.9]]],
      ['BlitzVoice', '#7fd0c8', [[7.9, 8.5]]],
      ['SpaceRacer', '#e0b04a', [[22.0, 23.6]]],
    ],
    sessions: [
      ['Shrink: lighter conversations', 'done', [[0.2, 1.1]]],
      ['UI revamp (master)', 'run', [[8.7, 10.15]]],
      ['Mockup A: Dual rail', 'done', [[9.66, 10.05]]],
      ['Mockup B: Studio', 'run', [[9.85, 10.15]]],
    ],
    events: [[0.9, 'git', 'Commit c9de470: Shrink'], [8.67, 'play', 'Start server'], [9.2, 'bell', 'Reminder: Pick Electron or Tauri'], [9.5, 'git', 'Commit 8cc338b'], [10.07, 'check', 'Claude added 2 tasks'], [10.11, 'image', 'Screenshot saved'], [10.13, 'lock', 'Asks to run npm run build:desktop']],
    week: [['Mon 23', [['MissionControl', 4.2], ['BlitzRaw', 2.1]]], ['Tue 24', [['MissionControl', 6.0], ['BlitzVoice', 1.2]]], ['Wed 25', [['BlitzRaw', 5.1], ['MissionControl', 1.5]]], ['Thu 26', [['MissionControl', 3.4], ['SpaceRacer', 2.6]]], ['Fri 27', [['MissionControl', 7.2]]], ['Sat 28', [['SpaceRacer', 3.9], ['BlitzRaw', 1.4]]], ['Sun 29', [['MissionControl', 1.9], ['BlitzRaw', 1.9], ['BlitzVoice', 0.6]]]],
  };

  /* what fills the context window, like Claude Code's /context (thousands of tokens, of 200k) */
  const context = [['System prompt', 3.1], ['System tools', 14.2], ['MCP tools', 9.8], ['Custom agents', 0.6], ['Memory files', 4.4], ['Skills', 2.1], ['Messages', 41.3], ['Free space', 79.5], ['Auto-compact buffer', 45]];

  /* every Claude that runs now, in every project */
  const agents = [
    { name: 'Revamp lead', proj: 'MissionControl', model: 'Opus 5.5 · high', job: 'Planning the viewports', state: 'run', for: '42 m' },
    { name: 'Helper 1', proj: 'MissionControl', model: 'Sonnet 5.5 · medium', job: 'Mockup B: Studio', state: 'run', for: '18 m' },
    { name: 'Helper 2', proj: 'MissionControl', model: 'Sonnet 5.5 · medium', job: 'Waiting for your answer', state: 'wait', for: '6 m' },
    { name: 'Release builder', proj: 'BlitzRaw', model: 'Sonnet 5.5 · high', job: 'Building release 1.4.3', state: 'run', for: '2 m' },
    { name: 'Voice check', proj: 'BlitzVoice', model: 'Haiku 5.5', job: 'Waiting for your answer', state: 'wait', for: '14 m' },
  ];

  const docs = [
    { name: 'README.md', where: 'repo', when: '2 d', kind: 'MD' },
    { name: 'SPEC.md', where: 'design/revamp', when: 'now', kind: 'MD' },
    { name: 'hub-spec.md', where: 'design', when: '6 d', kind: 'MD' },
    { name: 'CONTRIBUTING.md', where: 'repo', when: '3 w', kind: 'MD' },
    { name: 'design-modern.md', where: 'research/notes', when: '1 mo', kind: 'MD' },
    { name: 'Roadmap', where: 'Obsidian', when: '2 d', kind: 'OB' },
    { name: 'Launch day checklist', where: 'Obsidian', when: '5 d', kind: 'OB' },
    { name: 'Feature comparison', where: 'artifact', when: '2 w', kind: 'ART' },
    { name: 'Datasheet.pdf', where: 'attached', when: '1 w', kind: 'PDF' },
  ];

  const gallery = [
    img(shots + '1-home.png', 'Home, star system', 'shot', '10-27 14:02', 'claude'),
    img(shots + '2-project.png', 'Project page', 'shot', '10-27 13:40', 'claude'),
    img(shots + '6-chat.png', 'Talk page', 'shot', '10-26 22:14', 'claude'),
    img(shots + '3-system.png', 'System page', 'shot', '10-26 21:58', 'claude'),
    img(shots + '7-crew.png', 'Crew ship', 'shot', '10-25 18:12', 'claude'),
    img(shots + '4-connections.png', 'Connections', 'shot', '10-25 16:30', 'claude'),
    img(refs + 'vetted1.jpg', 'Reference: approvals', 'ref', '10-28 09:10', 'me'),
    img(refs + 'vetted3.jpg', 'Reference: vendor table', 'ref', '10-28 09:10', 'me'),
    img(refs + 'brandlix1.jpg', 'Reference: analytics', 'ref', '10-28 09:11', 'me'),
    img(refs + 'TreeLevels.jpg', 'Tree levels', 'ref', '10-28 09:12', 'me'),
    img(refs + 'NestedProjectLists.jpg', 'Nested project lists', 'ref', '10-28 09:12', 'me'),
    img(refs + 'aab8bc42b2c95b68480788f6a755d084.jpg', 'Collapsing sidebar', 'ref', '10-28 09:13', 'me'),
    img(shots + '5-automation.png', 'Automation', 'attach', '10-24 11:05', 'me'),
    img(shots + '7g-bridge.png', 'Bridge deck', 'gen', '10-22 20:44', 'claude'),
  ];

  const commits = [
    ['8cc338b', '4 d', 'The hub has no tab row: its one tab filled the phone screen', '+6 −31'],
    ['8fb845c', '4 d', 'Connections on the phone: Scan a pairing code opens the pairing screen', '+88 −12'],
    ['33bb28d', '4 d', 'The hub deletes a conversation into its trash folder', '+41 −9'],
    ['b690957', '4 d', 'The phone works with every PC off: it pairs with the hub too', '+512 −140'],
    ['c9de470', '5 d', 'Shrink: a code conversation keeps every message and loses the heavy parts you tick', '+903 −77'],
    ['20fd8fa', '5 d', 'System page: Conversations and attachments shows what is kept', '+230 −18'],
    ['0cff06e', '5 d', 'Send later test: past 360 days is refused', '+14 −2'],
    ['ca3acd9', '5 d', 'Talk page and project page: Show more lists older conversations', '+96 −40'],
    ['58c1e45', '5 d', 'Mission Control sets cleanupPeriodDays to 100 years at start', '+22 −3'],
    ['489207d', '5 d', 'Retraining a wake word keeps the earlier run and its model', '+64 −21'],
  ];
  const changes = [
    ['M', 'app/chat.html', '+142 −38'],
    ['M', 'app/redline.css', '+61 −12'],
    ['A', 'app/viewports.js', '+380'],
    ['A', 'app/theme-slate.css', '+210'],
  ];

  const builds = [
    { step: 'Source', state: 'done', note: 'main, 4 changed' },
    { step: 'Tests', state: 'done', note: '412 passed, 2 m 10 s' },
    { step: 'Desktop build', state: 'run', note: 'electron-builder, 61%' },
    { step: 'Installer', state: 'idle', note: 'waits for the build' },
    { step: 'Installed', state: 'warn', note: '1.9.4 is 6 d old' },
  ];

  const scripts = [
    { name: 'Start server', cmd: 'start.bat', state: 'run', last: 'running 3 h' },
    { name: 'Run tests', cmd: 'node --test', state: 'done', last: '412 passed, 1 h' },
    { name: 'Start hub (WSL)', cmd: 'server/run-hub.sh', state: 'done', last: 'yesterday' },
    { name: 'Build phone APK', cmd: 'phone/build.bat', state: 'fail', last: 'failed 2 d ago' },
    { name: 'Build desktop app', cmd: 'npm run build:desktop', state: 'idle', last: 'never' },
  ];

  const skills = [
    ['commit-here', 'Commit what changed'],
    ['release', 'Build and package a release'],
    ['handoff', 'Write a handoff before the cache runs out'],
    ['delegate', 'Hand narrow jobs to Sonnet helpers'],
    ['run', 'Launch the app and look at it'],
    ['code-review', 'Review the current diff'],
  ];

  const slash = [
    ['/task', 'Add a task to this project', 'MC'],
    ['/remind', 'Set a reminder (in 2 h, Friday 9:00 ...)', 'MC'],
    ['/browse', 'Open a page in the built-in browser', 'MC'],
    ['/side', 'Start a side chat about the last answer', 'MC'],
    ['/spawn', 'Start a nested session with its own job', 'MC'],
    ['/gallery', 'Attach pictures from the gallery', 'MC'],
    ['/layout', 'Switch viewport layout', 'MC'],
    ['/compact', 'Make the conversation shorter', 'Claude'],
    ['/handoff', 'Write a handoff and a prompt to continue', 'skill'],
    ['/commit-here', 'Commit the current changes', 'skill'],
    ['/code-review', 'Review the current diff', 'skill'],
    ['/model', 'Change the model', 'Claude'],
  ];

  const reminders = [
    { t: 'Today 16:00', text: 'Check the hub pairing fix on the phone', by: 'claude', src: 'Pairing code opens pairing screen' },
    { t: 'Tomorrow 9:00', text: 'Pick Electron or Tauri', by: 'me' },
    { t: 'Fri 18:00', text: 'Prompt cache handoff for the revamp session', by: 'claude', src: 'UI revamp: viewports and themes' },
    { t: 'Nov 15', text: 'Release notes for 2.0', by: 'me' },
  ];

  const activity = [
    ['10:07', 'tick', 'Claude ticked off "Hamburger menu per viewport"', 'UI revamp'],
    ['10:07', 'image', 'Claude saved viewports-3col.png to the gallery', 'UI revamp'],
    ['10:04', 'check', 'Claude added 2 tasks', 'UI revamp'],
    ['09:51', 'branch', 'Nested session "Mockup B: Studio" started', 'UI revamp'],
    ['09:30', 'commit', 'Commit 8cc338b: The hub has no tab row', 'Hub and phone'],
    ['09:12', 'bell', 'Reminder: Pick Electron or Tauri', 'You'],
    ['08:40', 'play', 'Start server ran (3 h ago, still running)', 'Scripts'],
  ];

  const usage = {
    days: [41, 22, 63, 58, 12, 0, 35, 77, 81, 44, 66, 90, 52, 18, 9, 61, 70, 88, 47, 39, 72, 96, 64, 30, 58, 83, 91, 49, 67, 74],
    plan: [['Session (5 h)', 62, 'resets 13:00'], ['Week, all models', 38, 'resets Mon'], ['Week, Opus', 51, 'resets Mon']],
    tiles: [['Cost at API prices', '$412', 'this month'], ['Tokens', '18.2 M', 'this month'], ['Conversations', '61', 'this month'], ['Cache hits', '91%', 'of input']],
  };

  const gpu = [
    ['ComfyUI (Flux)', 11.2], ['llama-swap: qwen3-14b', 6.1], ['BlitzVoice (Kokoro)', 1.4], ['Chrome', 0.9], ['Desktop', 0.7],
  ];

  const consoleLines = [
    ['09:12:01', 'info', 'server', 'Mission Control 1.9.4 on http://127.0.0.1:1700'],
    ['09:12:01', 'info', 'bridge', 'phone bridge on 1701, 1 phone paired'],
    ['09:12:02', 'info', 'runner', 'runner on 1702 took over 2 runs'],
    ['09:40:18', 'warn', 'hub', 'hub answered in 2.4 s (slow link)'],
    ['10:07:22', 'info', 'browser', 'Claude opened localhost:1700 (3440 × 1440)'],
    ['10:07:31', 'error', 'phone', 'pairing code expired: clock skew 41 s'],
    ['10:08:02', 'info', 'claude', 'session s1 asks to run: npm run build:desktop'],
  ];

  const crew = [
    { name: 'Revamp lead', model: 'Opus 5.5', job: 'Planning the viewports', state: 'run' },
    { name: 'Helper 1', model: 'Sonnet 5.5', job: 'Mockup B: Studio', state: 'run' },
    { name: 'Helper 2', model: 'Sonnet 5.5', job: 'Waiting for your answer', state: 'wait' },
  ];

  const inbox = [
    { proj: 'MissionControl', sess: 'UI revamp', what: 'Run npm run build:desktop', kind: 'perm' },
    { proj: 'MissionControl', sess: 'Mockup C: Spine', what: 'Which amber for Slate?', kind: 'ask' },
    { proj: 'BlitzRaw', sess: 'History panel export list', what: 'Push 2 commits to GitHub', kind: 'perm' },
  ];

  return { otherTasks, timeline, context, agents, places, roots, chats, sessions, messages, tasks, docs, gallery, commits, changes, builds, scripts, skills, slash, reminders, activity, usage, gpu, consoleLines, crew, inbox };
})();
