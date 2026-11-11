// Claude Code deletes every conversation not used for cleanupPeriodDays (30 by default) each time it starts, here and on
// any other computer. Mission Control keeps everything: when it starts, it raises that setting in the user's Claude
// settings (~/.claude/settings.json) to KEEP_DAYS when it is missing or lower. A settings file it cannot read is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from '../config.js';
import { writeAtomic } from '../lib/jsonStore.js';

export const KEEP_DAYS = 36500; // a hundred years

export function keepTranscripts(home = process.env.MC_CLAUDE_HOME ? path.resolve(process.env.MC_CLAUDE_HOME) : CLAUDE_HOME) {
  const file = path.join(home, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[keep] ${file} could not be read, so Claude Code may still delete conversations after 30 days:`, err.message);
      return false;
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  if (Number(settings.cleanupPeriodDays) >= KEEP_DAYS) return false;
  settings.cleanupPeriodDays = KEEP_DAYS;
  try {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(file, JSON.stringify(settings, null, 2) + '\n');
    console.log(`[keep] Claude Code now keeps conversations ${KEEP_DAYS} days (cleanupPeriodDays in ${file})`);
    return true;
  } catch (err) {
    console.error(`[keep] could not save ${file}:`, err.message);
    return false;
  }
}

keepTranscripts();
