/**
 * `rb doctor` — diagnostics for broken installs, platform gotchas, auth status.
 * Runs 8 health checks and reports results. Supports --json and --fix.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { spawnSync } from "node:child_process";
import { defineCommand } from "citty";
import { VERSION } from "../generated/version.js";
import { getConfigDir } from "../lib/auth.js";

// Compile-time defines from `bun build --compile --define`. In dev mode they're undefined.
declare const IS_STANDALONE: boolean | undefined;
declare const PLATFORM: string | undefined;

const IS_BIN = typeof IS_STANDALONE !== "undefined" && IS_STANDALONE === true;
const BIN_PLATFORM = typeof PLATFORM !== "undefined" ? PLATFORM : "";

type CheckStatus = "ok" | "warn" | "fail";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": `rendobar-cli/${VERSION}` },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const CLI_TAG_PREFIX = "v";

async function checkVersion(): Promise<Check> {
  try {
    const res = await fetchWithTimeout(
      "https://api.github.com/repos/rendobar/cli/releases?per_page=20"
    );
    if (!res.ok) {
      return {
        name: "version",
        status: "warn",
        detail: `GitHub API returned ${res.status}; cannot check latest`,
      };
    }
    const releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
    if (!Array.isArray(releases)) {
      return { name: "version", status: "warn", detail: `unexpected GitHub API response` };
    }
    // Find first non-prerelease CLI release
    const cliRelease = releases.find(
      (r) => typeof r.tag_name === "string" &&
        r.tag_name.startsWith(CLI_TAG_PREFIX) &&
        r.prerelease !== true
    );
    const latest = cliRelease?.tag_name?.replace(CLI_TAG_PREFIX, "") ?? "";
    if (!latest) {
      return { name: "version", status: "warn", detail: `no releases yet (current ${VERSION})` };
    }
    if (latest === VERSION) {
      return { name: "version", status: "ok", detail: `${VERSION} (latest)` };
    }
    return {
      name: "version",
      status: "warn",
      detail: `${VERSION} (latest is ${latest})`,
      fix: "Run: rb update",
    };
  } catch (err) {
    return {
      name: "version",
      status: "warn",
      detail: `cannot reach GitHub: ${(err as Error).message}`,
    };
  }
}

function checkInstallMethod(): Check {
  if (IS_BIN) {
    return {
      name: "install method",
      status: "ok",
      detail: `standalone binary (${BIN_PLATFORM || "unknown platform"})`,
    };
  }
  return { name: "install method", status: "ok", detail: "dev mode (bun run)" };
}

function checkOS(): Check {
  return { name: "OS/arch", status: "ok", detail: `${platform()} ${arch()}` };
}

function checkUpdateCache(): Check {
  const cachePath = join(homedir(), ".rendobar", "update-check.json");
  if (!existsSync(cachePath)) {
    return { name: "update cache", status: "ok", detail: "no cache file (first run)" };
  }
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      latest: string;
      checkedAt: number;
    };
    const age = Date.now() - data.checkedAt;
    const hours = Math.round(age / (60 * 60 * 1000));
    return {
      name: "update cache",
      status: "ok",
      detail: `cached latest=${data.latest} (${hours}h old)`,
    };
  } catch (err) {
    return {
      name: "update cache",
      status: "warn",
      detail: `corrupt cache: ${(err as Error).message}`,
      fix: `Delete ${cachePath}`,
    };
  }
}

async function checkApiReachable(): Promise<Check> {
  try {
    const res = await fetchWithTimeout("https://api.rendobar.com/health");
    if (res.ok) {
      return { name: "api.rendobar.com", status: "ok", detail: `HTTP ${res.status}` };
    }
    return { name: "api.rendobar.com", status: "warn", detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      name: "api.rendobar.com",
      status: "fail",
      detail: (err as Error).message,
      fix: "Check your internet connection or status.rendobar.com",
    };
  }
}

function checkAuth(): Check {
  let authPath: string;
  try {
    authPath = join(getConfigDir(), "credentials.json");
  } catch (err) {
    return {
      name: "auth",
      status: "warn",
      detail: `cannot resolve config dir: ${(err as Error).message}`,
    };
  }
  if (process.env.RENDOBAR_API_KEY) {
    return { name: "auth", status: "ok", detail: "RENDOBAR_API_KEY env var set" };
  }
  if (!existsSync(authPath)) {
    return {
      name: "auth",
      status: "warn",
      detail: "no credentials file — not logged in",
      fix: "Run: rb login",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    if (raw.type === "oauth" && typeof raw.accessToken === "string") {
      return { name: "auth", status: "ok", detail: "oauth token present (not verified)" };
    }
    if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
      return { name: "auth", status: "ok", detail: "api key present (not verified)" };
    }
    return {
      name: "auth",
      status: "warn",
      detail: "credentials file has no token or api key",
      fix: "Run: rb login",
    };
  } catch (err) {
    return {
      name: "auth",
      status: "warn",
      detail: `corrupt credentials file: ${(err as Error).message}`,
      fix: `Delete ${authPath} and run: rb login`,
    };
  }
}

function checkMacQuarantine(binPath: string, fix: boolean): Check {
  if (platform() !== "darwin" || !IS_BIN) {
    return { name: "macOS quarantine", status: "ok", detail: "N/A" };
  }
  if (!binPath || !existsSync(binPath)) {
    return {
      name: "macOS quarantine",
      status: "warn",
      detail: `binary path unknown: ${binPath || "(empty)"}`,
    };
  }
  const res = spawnSync("xattr", ["-l", binPath], { encoding: "utf-8" });
  if (res.status !== 0) {
    return {
      name: "macOS quarantine",
      status: "warn",
      detail: `xattr failed: ${res.stderr || "unknown error"}`,
    };
  }
  if (!res.stdout.includes("com.apple.quarantine")) {
    return { name: "macOS quarantine", status: "ok", detail: "not quarantined" };
  }
  if (fix) {
    const rm = spawnSync("xattr", ["-d", "com.apple.quarantine", binPath], { encoding: "utf-8" });
    if (rm.status === 0) {
      return { name: "macOS quarantine", status: "ok", detail: "removed quarantine bit" };
    }
    return {
      name: "macOS quarantine",
      status: "fail",
      detail: `xattr remove failed: ${rm.stderr || "unknown error"}`,
    };
  }
  return {
    name: "macOS quarantine",
    status: "warn",
    detail: "binary is quarantined — Gatekeeper may block execution",
    fix: "Run: rb doctor --fix  (or manually: xattr -d com.apple.quarantine $(which rb))",
  };
}

async function checkGhRateLimit(): Promise<Check> {
  try {
    const res = await fetchWithTimeout("https://api.github.com/rate_limit");
    if (!res.ok) {
      return { name: "GitHub rate limit", status: "warn", detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { rate?: { remaining?: number; limit?: number } };
    const remaining = body.rate?.remaining ?? 0;
    const limit = body.rate?.limit ?? 60;
    if (remaining < 5) {
      return {
        name: "GitHub rate limit",
        status: "warn",
        detail: `${remaining}/${limit} remaining — update check may fail`,
      };
    }
    return {
      name: "GitHub rate limit",
      status: "ok",
      detail: `${remaining}/${limit} remaining`,
    };
  } catch (err) {
    return { name: "GitHub rate limit", status: "warn", detail: (err as Error).message };
  }
}

export async function runDoctor(opts: { json?: boolean; fix?: boolean } = {}): Promise<void> {
  const binPath = process.argv[0] ?? "";
  const checks: Check[] = [
    await checkVersion(),
    checkInstallMethod(),
    checkOS(),
    checkUpdateCache(),
    await checkApiReachable(),
    checkAuth(),
    checkMacQuarantine(binPath, opts.fix ?? false),
    await checkGhRateLimit(),
  ];

  if (opts.json) {
    console.log(JSON.stringify({ version: VERSION, checks }, null, 2));
    return;
  }

  console.log(`rb ${VERSION} doctor`);
  console.log("");
  let hasFail = false;
  let hasWarn = false;
  for (const c of checks) {
    const icon = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    console.log(`  [${icon}] ${c.name}: ${c.detail}`);
    if (c.fix) console.log(`         fix: ${c.fix}`);
    if (c.status === "fail") hasFail = true;
    if (c.status === "warn") hasWarn = true;
  }
  console.log("");
  if (hasFail) {
    console.log("Some checks failed. See fixes above.");
    process.exit(1);
  } else if (hasWarn) {
    console.log("Some checks returned warnings. CLI is functional but review fixes above.");
  } else {
    console.log("All checks passed.");
  }
}

export default defineCommand({
  meta: { name: "doctor", description: "Diagnostic checks for the CLI installation" },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
    fix: {
      type: "boolean",
      description: "Attempt to fix issues (e.g., remove macOS quarantine)",
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runDoctor({ json: args.json as boolean, fix: args.fix as boolean });
    } catch (err) {
      console.error(`doctor failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});
