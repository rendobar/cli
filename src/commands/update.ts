/**
 * `rb update` — Self-replace for standalone binary, print install instructions for dev mode.
 * Detects install method via compile-time IS_STANDALONE define.
 */
import { writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defineCommand } from "citty";
import { VERSION } from "../generated/version.js";

// Compile-time defines from `bun build --compile --define`. In dev mode they're undefined.
declare const IS_STANDALONE: boolean | undefined;
declare const PLATFORM: string | undefined;

const IS_BIN = typeof IS_STANDALONE !== "undefined" && IS_STANDALONE === true;
const BIN_PLATFORM = typeof PLATFORM !== "undefined" ? PLATFORM : "";

const LOG_PATH = join(homedir(), ".rendobar", "update.log");

function log(msg: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    writeFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`, { flag: "a" });
  } catch {
    // Silent — never error on log write
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const CLI_TAG_PREFIX = "v";

async function fetchLatestTag(): Promise<string> {
  const res = await fetchWithTimeout("https://api.github.com/repos/rendobar/cli/releases?per_page=20", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `rendobar-cli/${VERSION}` },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
  if (!Array.isArray(releases)) throw new Error("unexpected response format from GitHub API");
  // Find first non-prerelease CLI release
  const cliRelease = releases.find(
    (r) => typeof r.tag_name === "string" &&
      r.tag_name.startsWith(CLI_TAG_PREFIX) &&
      r.prerelease !== true
  );
  if (!cliRelease || typeof cliRelease.tag_name !== "string") {
    throw new Error("404: no CLI releases found");
  }
  return cliRelease.tag_name; // e.g., "v1.1.0"
}

export function parseVersion(tag: string): string {
  // "v1.1.0" → "1.1.0"
  const match = tag.match(/^v(.+)$/);
  return match ? (match[1] as string) : tag;
}

async function fetchChecksums(tag: string): Promise<Map<string, string>> {
  const url = `https://github.com/rendobar/cli/releases/download/${encodeURIComponent(tag)}/checksums.txt`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`failed to fetch checksums: ${res.status}`);
  const text = await res.text();
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, ...fileParts] = trimmed.split(/\s+/);
    if (!hash || fileParts.length === 0) continue;
    map.set(fileParts.join(" "), hash);
  }
  return map;
}

async function downloadArchive(tag: string, archiveName: string): Promise<Uint8Array> {
  const url = `https://github.com/rendobar/cli/releases/download/${encodeURIComponent(tag)}/${archiveName}`;
  const res = await fetchWithTimeout(url, {}, 300_000);
  if (!res.ok) throw new Error(`failed to download ${archiveName}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function getBinPath(): string {
  // argv[0] in a compiled bun binary is the binary path
  return process.argv[0] ?? "";
}

function isSameVersion(latest: string): boolean {
  return parseVersion(latest) === VERSION;
}

export function printInstallInstructions(): void {
  console.log(`Rendobar CLI ships as a standalone binary. To update, re-run the installer:`);
  console.log(`  curl -fsSL https://rendobar.com/install.sh | sh`);
  console.log(`  # Windows: iwr https://rendobar.com/install.ps1 -useb | iex`);
}

async function updateBinary(latest: string): Promise<void> {
  console.log(`Updating rb ${VERSION} → ${parseVersion(latest)}`);

  const binPath = getBinPath();
  if (!binPath || !existsSync(binPath)) {
    throw new Error(`cannot locate current binary at ${binPath}`);
  }

  const ext = BIN_PLATFORM.startsWith("rb-windows") ? ".zip" : ".tar.gz";
  const archiveName = `${BIN_PLATFORM}${ext}`;

  console.log(`Fetching checksums...`);
  const checksums = await fetchChecksums(latest);
  const expectedHash = checksums.get(archiveName);
  if (!expectedHash) {
    throw new Error(`no checksum found for ${archiveName}`);
  }

  console.log(`Downloading ${archiveName}...`);
  const archive = await downloadArchive(latest, archiveName);
  const actualHash = sha256(archive);
  if (actualHash !== expectedHash) {
    throw new Error(`checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log(`Checksum verified: ${actualHash}`);

  // Extract archive to temp path alongside current binary
  const binDir = dirname(binPath);
  const tmpBinPath = `${binPath}.new`;
  const bakBinPath = `${binPath}.bak`;

  if (ext === ".tar.gz") {
    const tmpArchivePath = join(binDir, `update-${Date.now()}.tar.gz`);
    writeFileSync(tmpArchivePath, archive);
    const tar = spawnSync("tar", ["-xzf", tmpArchivePath, "-C", binDir], { stdio: "inherit" });
    try {
      unlinkSync(tmpArchivePath);
    } catch {
      // non-fatal
    }
    if (tar.status !== 0) throw new Error("tar extraction failed");
    const extractedPath = join(binDir, "rb");
    if (existsSync(extractedPath) && extractedPath !== binPath) {
      renameSync(extractedPath, tmpBinPath);
    }
  } else {
    const tmpArchivePath = join(binDir, `update-${Date.now()}.zip`);
    writeFileSync(tmpArchivePath, archive);
    const expand = spawnSync(
      "powershell",
      [
        "-Command",
        `Expand-Archive -Path '${tmpArchivePath}' -DestinationPath '${binDir}' -Force`,
      ],
      { stdio: "inherit" }
    );
    try {
      unlinkSync(tmpArchivePath);
    } catch {
      // non-fatal
    }
    if (expand.status !== 0) throw new Error("Expand-Archive failed");
    const extractedPath = join(binDir, "rb.exe");
    if (existsSync(extractedPath) && extractedPath !== binPath) {
      renameSync(extractedPath, tmpBinPath);
    }
  }

  if (!existsSync(tmpBinPath)) {
    throw new Error("extracted binary not found at expected location");
  }

  chmodSync(tmpBinPath, 0o755);

  // Atomic-ish swap: current → bak, new → current
  renameSync(binPath, bakBinPath);
  try {
    renameSync(tmpBinPath, binPath);
  } catch (err) {
    // Rollback on swap failure
    renameSync(bakBinPath, binPath);
    throw err;
  }

  // Verify the new binary actually runs before declaring success
  const verify = spawnSync(binPath, ["--version"], { timeout: 10_000 });
  if (verify.status !== 0) {
    // New binary is broken — restore backup before reporting failure
    try {
      renameSync(bakBinPath, binPath);
    } catch {
      // If restore fails, at least the backup still exists alongside
    }
    throw new Error(
      `updated binary failed to run (exit ${verify.status ?? "timeout"}) — rolled back to previous version`
    );
  }

  // Keep .bak permanently — provides a one-version rollback.
  // It will be overwritten on the next update.
  log(`Updated ${VERSION} → ${parseVersion(latest)} at ${binPath}`);
  console.log(`\nUpdate complete. Run 'rb --version' to verify.`);
}

export async function runUpdate(): Promise<void> {
  const latest = await fetchLatestTag();
  if (isSameVersion(latest)) {
    console.log(`Already on the latest version (${VERSION}).`);
    return;
  }

  if (!IS_BIN) {
    // Dev mode (bun run src/main.ts). IS_STANDALONE is undefined.
    printInstallInstructions();
    return;
  }

  await updateBinary(latest);
}

export default defineCommand({
  meta: { name: "update", description: "Check for and install the latest version" },
  async run() {
    try {
      await runUpdate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 means no releases published yet — give a clear message
      if (msg.includes("404")) {
        console.error(`No releases found yet. Check back after the first release is published.`);
      } else {
        console.error(`Update failed: ${msg}`);
      }
      process.exit(1);
    }
  },
});
