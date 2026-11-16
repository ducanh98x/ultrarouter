const fs = require("fs");
const path = require("path");
const os = require("os");

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

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return resolveDefaultDir();
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return resolveDefaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");
try { fs.mkdirSync(MITM_DIR, { recursive: true }); } catch {}

module.exports = { DATA_DIR, MITM_DIR };
