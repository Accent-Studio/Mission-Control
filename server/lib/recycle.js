// Moves files and folders to the Windows Recycle Bin, many in one PowerShell call, so a mistake can be undone there.
// On Linux (the hub), or with MC_RECYCLE=move (tests, so they never fill the real Recycle Bin), they move into
// .data/trash/<date>/ instead.
// recycle(paths) resolves { done: [path], failed: [{ path, error }] }. A path that is already gone counts as done.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { run } from './run.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// The list is read from a file of base64 lines, so nothing from a file name can become script text, and the command
// line stays short however many paths there are.
const SCRIPT =
  "& { param($list) Add-Type -AssemblyName Microsoft.VisualBasic; " +
  "foreach ($line in [IO.File]::ReadAllLines($list)) { if ($line -eq '') { continue }; " +
  "$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)); " +
  "try { " +
  "if (Test-Path -LiteralPath $p -PathType Leaf) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
  "elseif (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
  "} catch { [Console]::Error.WriteLine($line + ' ' + $_.Exception.Message) } } }";

function moveToTrash(paths) {
  const dir = path.join(DATA_DIR, 'trash', new Date().toISOString().replace(/[:.]/g, '-'));
  const done = [];
  const failed = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) { done.push(p); continue; }
      fs.mkdirSync(dir, { recursive: true });
      let to = path.join(dir, path.basename(p));
      for (let n = 2; fs.existsSync(to); n++) to = path.join(dir, `${n}-${path.basename(p)}`);
      fs.renameSync(p, to);
      done.push(p);
    } catch (err) {
      failed.push({ path: p, error: err.message });
    }
  }
  return { done, failed };
}

export async function recycle(paths) {
  paths = [...new Set(paths.filter(Boolean))];
  if (!paths.length) return { done: [], failed: [] };
  if (process.platform !== 'win32' || process.env.MC_RECYCLE === 'move') return moveToTrash(paths);
  const list = path.join(DATA_DIR, `.recycle-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(list, paths.map(b64).join('\n') + '\n');
  let r;
  try {
    r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT, `'${list.replace(/'/g, "''")}'`], { timeoutMs: 10 * 60e3 });
  } finally {
    try { fs.rmSync(list, { force: true }); } catch { /* gone */ }
  }
  const why = new Map();
  for (const line of String((r && r.stderr) || '').split(/\r?\n/)) {
    const [k, ...rest] = line.split(' ');
    if (k) try { why.set(Buffer.from(k, 'base64').toString('utf8'), rest.join(' ')); } catch { /* not ours */ }
  }
  const done = [];
  const failed = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) done.push(p);
    else failed.push({ path: p, error: why.get(p) || 'Could not move it to the Recycle Bin' });
  }
  return { done, failed };
}
