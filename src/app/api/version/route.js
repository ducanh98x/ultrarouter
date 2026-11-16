import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { GITHUB_CONFIG } from "@/shared/constants/config";

const NPM_PACKAGE_NAME = "ultrarouter";
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // cache npm lookup for 5 min

// Survive hot reload; one cache per process
const versionCache = (global.__ultrarouterVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch a JSON document and pull its top-level version field.
function fetchVersionJson(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { timeout: 5000, headers: { "User-Agent": "ultrarouter-update-check" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const version = JSON.parse(data)?.version;
            resolve(typeof version === "string" && version ? version : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Prefer the published npm package; before the first publish (or during an npm
// outage) fall back to the fork's master package.json.
async function fetchLatestVersion() {
  const fromNpm = await fetchVersionJson(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`);
  if (fromNpm) return { version: fromNpm, source: "npm" };
  const fromRepo = await fetchVersionJson(GITHUB_CONFIG.packageJsonUrl);
  if (fromRepo) return { version: fromRepo, source: "repo" };
  return { version: null, source: "npm" };
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache;
  }
  const latest = await fetchLatestVersion();
  if (latest.version) {
    versionCache.value = latest.version;
    versionCache.source = latest.source;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latest = await getLatestVersionCached();
  const latestVersion = latest.value ?? latest.version ?? null;
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    source: latest.source || "npm",
    package: NPM_PACKAGE_NAME,
    repo: GITHUB_CONFIG.repo,
  });
}
