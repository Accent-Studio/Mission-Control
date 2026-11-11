// Tests for finding the claude program (server/lib/claudeExe.js) when Claude Code updates itself: the link on PATH moves to
// a new version, and the old one may be removed.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

describe('the claude program after an update', { skip: process.platform === 'win32' && 'the link is a POSIX symlink' }, () => {
  test('a fresh look finds the new version, and a version that is gone is never given out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claudeexe-'));
    const bin = path.join(dir, 'bin'), vers = path.join(dir, 'versions');
    fs.mkdirSync(bin);
    fs.mkdirSync(vers);
    const v1 = path.join(vers, '1.0.0'), v2 = path.join(vers, '1.0.1');
    for (const v of [v1, v2]) fs.writeFileSync(v, '#!/bin/sh\n', { mode: 0o755 });
    const link = path.join(bin, 'claude');
    fs.symlinkSync(v1, link);
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    try {
      const { resolveClaude, isClaudeCommand } = await import('../../server/lib/claudeExe.js');
      const real = (p) => fs.realpathSync(p);
      assert.equal((await resolveClaude()).cmd, real(v1));
      fs.unlinkSync(link);
      fs.symlinkSync(v2, link); // the update
      assert.equal((await resolveClaude()).cmd, real(v1), 'kept while the old version is there');
      const fresh = await resolveClaude({ fresh: true });
      assert.equal(fresh.cmd, real(v2));
      assert.ok(isClaudeCommand(fresh, real(v2), []));
      assert.ok(!isClaudeCommand(fresh, real(v1), []));
      fs.unlinkSync(link);
      fs.symlinkSync(v1, link);
      await resolveClaude({ fresh: true }); // back on v1
      fs.unlinkSync(link);
      fs.symlinkSync(v2, link);
      fs.rmSync(v1); // the updater removed the old version
      assert.equal((await resolveClaude()).cmd, real(v2), 'a version that is gone is looked up again');
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
