// Resolve a writable data directory: DATA_DIR first, then ~/.ultrarouter, then
// tmpdir. Some installs point DATA_DIR at root-owned paths (e.g. /var/lib) that
// the server process cannot write browser profiles or runtime installs into.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

function migrateLegacyDefault(target) {
  const legacy = path.join(os.homedir(), ".9router");
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    try {
      fs.renameSync(legacy, target);
    } catch {
      fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    }
  } catch {
    // Best effort: fall back to a fresh writable directory.
  }
}

export function getWritableDataDir() {
  if (cached) return cached;
  const homeDir = path.join(os.homedir(), ".ultrarouter");
  migrateLegacyDefault(homeDir);
  const candidates = [
    process.env.DATA_DIR,
    homeDir,
    path.join(os.tmpdir(), "ultrarouter"),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.accessSync(base, fs.constants.W_OK);
      cached = base;
      return base;
    } catch {
      // Not writable — try the next candidate.
    }
  }
  cached = process.cwd();
  return cached;
}
