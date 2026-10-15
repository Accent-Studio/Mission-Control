// Run programs without a shell.
// Note: Node 22 refuses to launch .cmd and .bat files without a shell (spawn EINVAL), so run() resolves
// with code -1 for them. Start the real executable behind a shim instead (claude.cmd calls
// node_modules\@anthropic-ai\claude-code\bin\claude.exe, which can be launched directly).
import { execFile } from 'node:child_process';

export function run(cmd, args = [], { cwd, timeoutMs = 15000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : -1;
      resolve({
        code,
        stdout: stdout || '',
        stderr: stderr || (err && code === -1 ? String(err.message) : ''),
        timedOut: !!(err && err.killed && code === -1),
      });
    };
    try {
      execFile(
        cmd,
        args,
        { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' },
        done,
      );
    } catch (err) {
      // spawn can throw synchronously (for example EINVAL for .cmd files). Report it the same way.
      done(err, '', '');
    }
  });
}

// PowerShell writes pipes in the console code page (932 on a Japanese system), so force UTF-8.
const UTF8_PREFIX = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';

// Runs a PowerShell script. If it ends in ConvertTo-Json, `json` holds the parsed output (null when
// the output is empty or is not valid JSON). Note that PowerShell prints a one-element array as a bare object.
export async function runPS(script, opts = {}) {
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', UTF8_PREFIX + script],
    { timeoutMs: 20000, ...opts },
  );
  r.stdout = r.stdout.replace(/^﻿/, '');
  let json = null;
  if (/ConvertTo-Json/i.test(script) && r.stdout.trim()) {
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = null;
    }
  }
  return { ...r, json };
}
