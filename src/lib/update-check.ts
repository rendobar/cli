// Background version check against GitHub Releases API with 24h cache + jitter.
// Silent on failure — never errors on the user.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const GH_RELEASES_API = "https://api.github.com/repos/rendobar/cli/releases?per_page=20";
const CLI_TAG_PREFIX = "v";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const JITTER_MS = 2 * 60 * 60 * 1000; // ±2h

type CacheFile = {
  latest: string;
  checkedAt: number;
  ttl: number;
};

function shouldSkip(): boolean {
  if (process.env.RB_NO_UPDATE_CHECK === "1") return true;
  if (process.env.CI === "true") return true;
  if (process.argv.includes("--quiet")) return true;
  if (process.argv.includes("--json")) return true;
  if (process.argv.includes("--url-only")) return true;
  return false;
}

function getCachePath(): string {
  // Re-read env each call so tests can change RB_CACHE_DIR between cases
  const dir = process.env.RB_CACHE_DIR ?? join(homedir(), ".rendobar");
  return join(dir, "update-check.json");
}

function readCache(): CacheFile | null {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    if (typeof data.latest !== "string" || typeof data.checkedAt !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data: CacheFile): void {
  try {
    const path = getCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {
    // Silent — never error on cache write
  }
}

function isCacheFresh(cache: CacheFile): boolean {
  // ±2h jitter prevents thundering-herd on release day
  const jitter = (Math.random() * 2 - 1) * JITTER_MS;
  const effectiveTtl = cache.ttl + jitter;
  return Date.now() - cache.checkedAt < effectiveTtl;
}

function parseVersion(tag: string): string {
  // "v1.1.0" → "1.1.0"
  const match = tag.match(/^v(.+)$/);
  return match ? (match[1] as string) : tag;
}

function versionGt(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * Non-blocking background check. Updates cache file if network succeeds.
 * Uses injected fetch so tests can mock it.
 */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (shouldSkip()) return;

  const cache = readCache();
  if (cache && isCacheFresh(cache)) return;

  try {
    const res = await fetchImpl(GH_RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `rendobar-cli/${currentVersion}`,
      },
    });
    if (!res.ok) return;
    const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
    if (!Array.isArray(releases)) return;
    // Find first non-prerelease CLI release
    const cliRelease = releases.find(
      (r) => typeof r.tag_name === "string" &&
        r.tag_name.startsWith(CLI_TAG_PREFIX) &&
        r.prerelease !== true
    );
    if (!cliRelease || typeof cliRelease.tag_name !== "string") return;
    const latest = parseVersion(cliRelease.tag_name);
    writeCache({
      latest,
      checkedAt: Date.now(),
      ttl: TTL_MS,
    });
  } catch {
    // Silent — never error on update check
  }
}

/**
 * Returns a notification message if cached latest > current version.
 * Called after command output so the notification appears at the bottom.
 */
export function getPendingNotification(currentVersion: string): string | null {
  if (shouldSkip()) return null;
  const cache = readCache();
  if (!cache) return null;
  if (!versionGt(cache.latest, currentVersion)) return null;
  return `Update available: ${currentVersion} → ${cache.latest}  Run \`rb update\` to upgrade`;
}
