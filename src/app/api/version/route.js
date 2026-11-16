import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { GITHUB_CONFIG } from "@/shared/constants/config";

const NPM_PACKAGE_NAME = "ultrarouter";
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // cache npm lookup for 5 min

// Survive hot reload; one cache per process
const versionCache = (global.__ultrarouterVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch the latest version of this fork's npm package.
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
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
            resolve(JSON.parse(data)?.version || null);
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
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = await getLatestVersionCached();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    source: "npm",
    package: NPM_PACKAGE_NAME,
    repo: GITHUB_CONFIG.repo,
  });
}
