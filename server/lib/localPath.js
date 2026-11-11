// A full local path, as Mission Control accepts one from a transcript, a request or a setting: on Windows a path on a
// drive letter (C:\x or C:/x), on macOS and Linux a path from the root (/Users/x), never the // network form.
export const IS_WIN = process.platform === 'win32';

export function isLocalAbs(p) {
  if (typeof p !== 'string' || !p) return false;
  return IS_WIN ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/') && !p.startsWith('//');
}
