import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "ultrarouter";
const LEGACY_APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function legacyDefaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME);
  }
  return path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
}

// Move an existing 9router data directory into the UltraRouter location once.
// Keeping the old data avoids a fresh install after the rebrand.
function migrateLegacyDefault(target) {
  const legacy = legacyDefaultDir();
  if (target === legacy || fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(legacy, target);
    } catch {
      fs.cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    }
  } catch (e) {
    console.warn(`[DATA_DIR] could not migrate ${legacy} → ${target}: ${e.message}`);
  }
}

function resolveDefaultDir() {
  const target = defaultDir();
  migrateLegacyDefault(target);
  return target;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return resolveDefaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return resolveDefaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
