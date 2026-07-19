/**
 * `rb ffprobe` -- Run a raw ffprobe command against a media URL, in the cloud.
 *
 * Raw-command redesign: argv (ffprobe flags plus the media URL) is joined
 * verbatim into `params.command`, exactly like `rb ffmpeg` does for its own
 * command string. There is no separate `inputs.source` -- the URL lives
 * inside `command`, and there is no local-file upload step; ffprobe targets
 * a media URL only.
 *
 * Data-only job: `client.jobs.wait()` already resolves on the job's terminal
 * state, so this command skips the WebSocket/machine-context dance
 * `rb ffmpeg` uses for longer-running renders -- a probe is fast, and the
 * SDK's own discriminated `JobResponse` union already narrows
 * `output`/`error` for us.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { isApiError, jobData, WaitTimeoutError } from "@rendobar/sdk";
import { createCliClient } from "../lib/client.js";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, getDashboardBaseUrl } from "../lib/auth.js";
import { shellEscape } from "../lib/shell-escape.js";
import { StepRenderer } from "../lib/progress.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;

// ── Documented contract of the `ffprobe` job's `output.data` ──────
//
// (rendobar/rendobar, raw-command redesign). The SDK types `data` as
// `unknown` because `jobs.create`/`jobs.wait` are generic over job type --
// these interfaces encode the ffprobe-specific shape so the rest of the
// command works with real fields instead of `unknown`. `summary` is always
// present; every other field is best-effort probe output.

interface StreamCounts {
  video?: number;
  audio?: number;
  subtitle?: number;
  data?: number;
}

interface SummaryCommon {
  container?: string;
  durationSec?: number;
  sizeBytes?: number;
  bitrateBps?: number;
  streamCounts?: StreamCounts;
  tags?: Record<string, string>;
}

interface VideoBlock {
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
}

interface AudioBlock {
  codec?: string;
  channels?: number;
  sampleRateHz?: number;
}

interface ImageBlock {
  codec?: string;
  width?: number;
  height?: number;
}

export type ProbeSummary =
  | (SummaryCommon & { kind: "video"; video: VideoBlock; audio?: AudioBlock })
  | (SummaryCommon & { kind: "audio"; audio: AudioBlock })
  | (SummaryCommon & { kind: "image"; image: ImageBlock })
  | (SummaryCommon & { kind: "other" });

interface ProbeData {
  summary: ProbeSummary;
  format?: unknown;
  streams?: unknown;
  chapters?: unknown;
  warnings?: string[];
}

// ── Pure helpers (unit-tested without network) ────────────────────

/** Parses `--timeout`, falling back to the default and clamping to the API max. */
export function resolveTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_SEC;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val) || val <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(val, MAX_TIMEOUT_SEC);
}

/**
 * Client-side poll budget for `jobs.wait()`. Must OUTLAST the server-side
 * `timeout` so the CLI observes the job's terminal state (completion, or the
 * server's own timeout failure) instead of giving up first. Server bound plus
 * a fixed margin, floored at the SDK's own default wait budget.
 */
export function resolveWaitBudgetMs(timeoutSec: number): number {
  return Math.max((timeoutSec + 60) * 1000, 300_000);
}

/**
 * Joins ffprobe flags + URL into a single `ffprobe ...` command string,
 * mirroring `rb ffmpeg`'s command passthrough. Each argv element is
 * POSIX-shell-escaped before joining -- see `shell-escape.ts` for why this
 * round-trips losslessly through the API's command-string parser.
 */
export function buildCommand(args: string[]): string {
  return "ffprobe " + args.map(shellEscape).join(" ");
}

/** Job submission params: `command` carries the URL + flags, `timeout` bounds server-side execution. */
export function buildProbeParams(command: string, timeoutSec: number): Record<string, unknown> {
  return { command, timeout: timeoutSec };
}

interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  noWait: boolean;
  timeout: number;
}

/** CLI-level flags recognized anywhere in argv; everything else passes through to ffprobe. */
const GLOBAL_FLAGS = new Set(["--json", "--quiet", "--no-wait"]);
const GLOBAL_FLAGS_WITH_VALUE = new Set(["--timeout"]);

export function extractGlobalFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = { json: false, quiet: false, noWait: false, timeout: DEFAULT_TIMEOUT_SEC };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--no-wait") flags.noWait = true;
    else if (arg === "--timeout" && i + 1 < argv.length) {
      flags.timeout = resolveTimeout(argv[i + 1]);
      i++;
    }
  }
  return flags;
}

/**
 * Everything after the `ffprobe` subcommand name in argv, minus the
 * recognized CLI-level flags above -- i.e. the raw ffprobe flags plus the
 * media URL, in the order the user typed them.
 */
export function extractProbeArgs(argv: string[]): string[] {
  const idx = argv.indexOf("ffprobe");
  if (idx === -1) return [];
  const result: string[] = [];
  for (let i = idx + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (GLOBAL_FLAGS.has(arg)) continue;
    if (GLOBAL_FLAGS_WITH_VALUE.has(arg)) { i++; continue; }
    result.push(arg);
  }
  return result;
}

/** `12` -> `"12"`, `75` -> `"1:15"`, `3661` -> `"1:01:01"`. */
function fmtDuration(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** One-line concise summary: kind, container, duration, plus per-kind detail. */
export function formatSummary(summary: ProbeSummary): string {
  const kindLabel = summary.kind.charAt(0).toUpperCase() + summary.kind.slice(1);
  const parts = [kindLabel, summary.container ?? "unknown"];
  if (summary.durationSec !== undefined) parts.push(fmtDuration(summary.durationSec));

  if (summary.kind === "video") {
    if (summary.video.width && summary.video.height) parts.push(`${summary.video.width}x${summary.video.height}`);
    if (summary.video.fps) parts.push(`${summary.video.fps}fps`);
  } else if (summary.kind === "audio") {
    if (summary.audio.codec) parts.push(summary.audio.codec);
    if (summary.audio.channels) parts.push(`${summary.audio.channels}ch`);
  } else if (summary.kind === "image") {
    if (summary.image.width && summary.image.height) parts.push(`${summary.image.width}x${summary.image.height}`);
  }

  return parts.join("  ");
}

// ── Help ───────────────────────────────────────────────────────

function showHelp(): void {
  process.stderr.write(`
${pc.bold("Usage:")} rb ffprobe [ffprobe-flags] <url>

${pc.bold("Examples:")}
  rb ffprobe https://example.com/video.mp4
  rb ffprobe -show_format -show_streams https://example.com/video.mp4
  rb ffprobe --json https://cdn.rendobar.com/uploads/abc.mp4

${pc.bold("Flags:")}
  --json         Print the full probe data as JSON, not just the summary
  --quiet        No progress output, exit code only
  --no-wait      Submit and exit immediately (prints job ID)
  --timeout N    Max probe execution time in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC})

${pc.dim("Run a raw ffprobe command against a media URL.")}
${pc.dim("All ffprobe flags are passed through to the cloud runner.")}
`);
}

// ── Command ────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "ffprobe", description: "Run a raw ffprobe command against a media URL" },
  async run() {
    const argv = process.argv;
    const flags = extractGlobalFlags(argv);
    const probeArgs = extractProbeArgs(argv);

    if (probeArgs.length === 0) { showHelp(); process.exit(0); }

    const isTTY = Boolean(process.stderr.isTTY);

    let cred = resolveAuth();
    if (!cred) {
      process.stderr.write(pc.red("  ✗ Not authenticated. Run `rb login` or set RENDOBAR_API_KEY.\n"));
      process.exit(2);
    }

    // Auto-refresh if OAuth and expired
    if (cred.type === "oauth") {
      try {
        cred = await refreshTokenIfNeeded(cred);
      } catch (err) {
        process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : "Auth error"}\n`));
        process.exit(2);
      }
    }

    const baseUrl = getApiBaseUrl();
    const clientConfig = cred.type === "apikey"
      ? { apiKey: cred.apiKey, baseUrl }
      : { accessToken: cred.accessToken, baseUrl };
    const client = createCliClient(clientConfig);
    const steps = new StepRenderer({ isTTY, quiet: flags.quiet });

    const command = buildCommand(probeArgs);

    const controller = new AbortController();
    let jobId: string | undefined;

    process.on("SIGINT", async () => {
      controller.abort();
      if (jobId) {
        if (!flags.quiet) process.stderr.write(pc.yellow(`\n  Cancelling job ${jobId}...\n`));
        // Best-effort cancellation with 3s hard timeout
        try { await Promise.race([client.jobs.cancel(jobId), new Promise((r) => setTimeout(r, 3000))]); } catch { /* best-effort */ }
      }
      process.exit(130);
    });

    try {
      // ── 1. Submit ────────────────────────────────────────
      const job = await steps.step("Submitting", async () => {
        return client.jobs.create(
          { type: "ffprobe", params: buildProbeParams(command, flags.timeout) },
          { signal: controller.signal },
        );
      });

      jobId = job.id;

      if (flags.noWait) {
        if (flags.json) console.log(JSON.stringify({ id: job.id, status: job.status }));
        else if (!flags.quiet) console.log(job.id);
        process.exit(0);
      }

      // ── 2. Wait for the probe to finish ──────────────────
      // The wait budget must outlast the server-side `params.timeout` so we
      // observe the job's terminal state rather than giving up first.
      const result = await steps.step("Probing", async () => {
        return client.jobs.wait(job.id, { timeout: resolveWaitBudgetMs(flags.timeout), signal: controller.signal });
      });

      const dashboardLine = `    ${pc.dim(`${getDashboardBaseUrl()}/jobs/${job.id}`)}\n`;

      // ── Handle failure ───────────────────────────────────
      if (result.status === "failed") {
        if (flags.json) console.log(JSON.stringify(result));
        else if (!flags.quiet) {
          const err = result.error;
          steps.info(pc.red(`✗ ${err.code}: ${err.message}`));
          if (err.detail) {
            for (const line of err.detail.trimEnd().split("\n")) steps.info(pc.dim(line));
          }
        }
        process.exit(1);
      }
      if (result.status === "cancelled") process.exit(130);

      if (result.status !== "complete") {
        // jobs.wait() only resolves on a terminal status; reaching here would be
        // an SDK contract violation, not a real job outcome.
        const nonTerminal: "waiting" | "dispatched" | "running" = result.status;
        if (!flags.quiet) process.stderr.write(pc.red(`  ✗ Unexpected status: ${nonTerminal}\n`));
        process.exit(1);
      }

      // API contract: ffprobe's output.data always has this shape (see header
      // comment). `jobData<T>()` does the status check plus the SDK's own
      // justified cast -- this is the command's one claim about ffprobe's shape.
      const data = jobData<ProbeData>(result);
      if (!data) {
        if (!flags.quiet) process.stderr.write(pc.red("  ✗ Probe completed with no data\n"));
        process.exit(1);
      }

      // ── Output modes ─────────────────────────────────────
      // Structured answer goes to stdout so it can be piped (e.g. to jq).
      if (flags.json) console.log(JSON.stringify(data, null, 2));
      else console.log(formatSummary(data.summary));

      if (!flags.quiet && isTTY) process.stderr.write(`\n${dashboardLine}`);

      process.exit(0);

    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") process.exit(130);
      if (err instanceof WaitTimeoutError) {
        process.stderr.write(pc.red(`  ✗ Timed out waiting for job ${err.jobId} (last status: ${err.lastStatus})\n`));
        process.exit(1);
      }
      if (isApiError(err)) {
        if (err.code === "INSUFFICIENT_CREDITS") {
          process.stderr.write(pc.red(`  ✗ Insufficient credits. ${err.message}\n`));
          process.stderr.write(`    Top up: ${pc.cyan(`${getDashboardBaseUrl()}/billing`)}\n`);
          process.exit(2);
        }
        if (flags.json) console.log(JSON.stringify({ error: { code: err.code, message: err.message } }));
        else if (!flags.quiet) process.stderr.write(pc.red(`  ✗ ${err.message}\n`));
        process.exit(1);
      }
      if (!flags.quiet) process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  },
});
