// Anonymous, opt-out CLI telemetry.
//
// What it is: a single anonymous event per command run (which command, whether
// it succeeded, how long it took, CLI version, OS). That is all. It exists so we
// can see which commands matter and make the CLI better.
//
// What it is NOT: it never sends your file names, arguments, URLs, API keys,
// user id, org, or any file contents. The identifier is a random per-machine id,
// not tied to your account.
//
// Off switches (any one disables it): `rb telemetry off`, DO_NOT_TRACK=1,
// RENDOBAR_TELEMETRY=0, or CI environments (skipped automatically).
//
// Mirrors the platform's snake_case event convention. Kept self-contained per
// the cross-repo rule (the CLI can't import @rendobar/shared).

import * as fs from "node:fs";
import { getConfigDir } from "./auth.js";
import { VERSION, TELEMETRY_KEY } from "../generated/version.js";

const TELEMETRY_FILE = "telemetry.json";
// First-party reverse proxy (same host the dashboard uses). Overridable for dev.
const HOST = process.env.RENDOBAR_TELEMETRY_HOST ?? "https://e.rendobar.com";
// Public write-only project token, injected at build. Env override for testing.
const KEY = process.env.RENDOBAR_TELEMETRY_KEY ?? TELEMETRY_KEY ?? "";
// Bounded so a slow network never delays the user's command by more than this.
const FLUSH_TIMEOUT_MS = 1200;

interface TelemetryState {
  anonymousId: string;
  enabled: boolean;
  noticeShown: boolean;
}

function statePath(): string {
  return `${getConfigDir()}/${TELEMETRY_FILE}`;
}

// A random, non-identifying id. Not derived from anything about the user or
// machine — just a stable key so repeat runs group together in aggregate.
function newAnonymousId(): string {
  return `cli_anon_${crypto.randomUUID()}`;
}

function readState(): TelemetryState {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      return {
        anonymousId:
          typeof r.anonymousId === "string" ? r.anonymousId : newAnonymousId(),
        enabled: r.enabled !== false, // default on
        noticeShown: r.noticeShown === true,
      };
    }
  } catch {
    /* missing/corrupt -> fresh state */
  }
  return { anonymousId: newAnonymousId(), enabled: true, noticeShown: false };
}

function writeState(state: TelemetryState): void {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    try {
      fs.chmodSync(statePath(), 0o600);
    } catch {
      /* Windows */
    }
  } catch {
    /* telemetry state is best-effort; never block the CLI */
  }
}

// Env-level opt-outs. DO_NOT_TRACK is the community standard (consoledonottrack.com).
function optedOutByEnv(): boolean {
  if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== "0") return true;
  const flag = (process.env.RENDOBAR_TELEMETRY ?? "").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return true;
  if (process.env.RENDOBAR_NO_TELEMETRY || process.env.RENDOBAR_DISABLE_TELEMETRY) return true;
  if (process.env.CI === "true") return true; // CI runs are noise, and not a person
  return false;
}

export function telemetryEnabled(): boolean {
  if (!KEY) return false; // no token baked in -> disabled (dev/source)
  if (optedOutByEnv()) return false;
  return readState().enabled;
}

// One-time, respectful first-run notice. Printed to stderr so it never pollutes
// piped stdout. Shown once, then remembered.
export function maybeShowFirstRunNotice(): void {
  if (!telemetryEnabled()) return;
  const state = readState();
  if (state.noticeShown) return;
  process.stderr.write(
    "\n" +
      "Rendobar CLI sends anonymous usage stats (which commands run, the CLI\n" +
      "version, and your OS) so we can make it better. It never sends your files,\n" +
      "arguments, URLs, or credentials. Turn it off anytime with `rb telemetry off`\n" +
      "or DO_NOT_TRACK=1.\n\n",
  );
  writeState({ ...state, noticeShown: true });
}

export function setTelemetryEnabled(enabled: boolean): void {
  const state = readState();
  writeState({ ...state, enabled, noticeShown: true });
}

export interface TelemetryStatus {
  enabled: boolean;
  optedOutByEnv: boolean;
  keyPresent: boolean;
  anonymousId: string;
}

export function telemetryStatus(): TelemetryStatus {
  const state = readState();
  return {
    enabled: telemetryEnabled(),
    optedOutByEnv: optedOutByEnv(),
    keyPresent: Boolean(KEY),
    anonymousId: state.anonymousId,
  };
}

/**
 * Capture one anonymous command event. Best-effort and bounded: awaited by the
 * caller so it flushes before the process exits, but never longer than
 * FLUSH_TIMEOUT_MS and never throws.
 */
export async function captureCommand(
  command: string,
  success: boolean,
  durationMs: number,
): Promise<void> {
  if (!telemetryEnabled()) return;
  const { anonymousId } = readState();

  const body = {
    api_key: KEY,
    event: "cli_command",
    distinct_id: anonymousId,
    properties: {
      command,
      success,
      duration_ms: durationMs,
      cli_version: VERSION,
      os: process.platform,
      arch: process.arch,
      // $process_person_profile:false keeps this an anonymous event in PostHog
      // (cheaper, and never creates a person profile for the machine id).
      $process_person_profile: false,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(`${HOST}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
    });
  } catch {
    // Never let telemetry surface an error or delay the user.
  }
}
