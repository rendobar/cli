/**
 * `rb ffprobe` -- Probe media metadata in the cloud.
 *
 * Data-only job: submit a URL (or local file, auto-uploaded first) and get back
 * `output.data = { summary, format, streams, chapters, keyframes?, probe }`.
 * `client.jobs.wait()` already resolves on the job's terminal state, so this
 * command skips the WebSocket/machine-context dance `rb ffmpeg` uses for
 * longer-running renders -- a probe is fast, and the SDK's own discriminated
 * `JobResponse` union already narrows `output`/`error` for us.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { isApiError, jobData, WaitTimeoutError } from "@rendobar/sdk";
import { createCliClient } from "../lib/client.js";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, getDashboardBaseUrl } from "../lib/auth.js";
import { uploadLocalFiles } from "../lib/upload.js";
import { StepRenderer, fmtBytes } from "../lib/progress.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;

/**
 * Documented contract of the `ffprobe` job's `output.data` (rendobar/rendobar
 * PR #349). The SDK types `data` as `unknown` because `jobs.create`/`jobs.wait`
 * are generic over job type -- this interface encodes the ffprobe-specific
 * shape so the rest of the command works with real fields instead of `unknown`.
 */
interface ProbeData {
  summary: unknown;
  format?: unknown;
  streams?: unknown;
  chapters?: unknown;
  keyframes?: unknown;
  probe?: unknown;
}

// ── Pure helpers (unit-tested without network) ────────────────────

/** A bare `http(s)://` URL is remote; anything else is a local file path. */
export function isLocalSource(source: string): boolean {
  return !source.startsWith("http://") && !source.startsWith("https://");
}

/** Parses `--timeout`, falling back to the default and clamping to the API max. */
export function resolveTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_SEC;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val) || val <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(val, MAX_TIMEOUT_SEC);
}

/**
 * Job submission params: `timeout` always bounds server-side probe execution
 * (mirrors `rb ffmpeg`'s `params.timeout`); `keyframes` is only included when
 * requested.
 */
export function buildProbeParams(keyframes: boolean, timeoutSec: number): Record<string, unknown> {
  return { timeout: timeoutSec, ...(keyframes ? { keyframes: true } : {}) };
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

/** `--raw` prints everything; the default prints just the normalized summary. */
export function selectPayload(data: ProbeData, raw: boolean): unknown {
  return raw ? data : data.summary;
}

// ── Help ───────────────────────────────────────────────────────

function showHelp(): void {
  process.stderr.write(`
${pc.bold("Usage:")} rb ffprobe [flags] <url-or-file>

${pc.bold("Examples:")}
  rb ffprobe https://example.com/video.mp4
  rb ffprobe ./local-video.mp4
  rb ffprobe --raw https://cdn.rendobar.com/uploads/abc.mp4
  rb ffprobe --keyframes video.mp4 | jq '.video.fps'

${pc.bold("Flags:")}
  --keyframes    Include a keyframe index in the probe
  --raw          Print the full probe data (format, streams, chapters), not just the summary
  --json         Output the full job result as JSON
  --quiet        No progress output, exit code only
  --no-wait      Submit and exit immediately (prints job ID)
  --timeout N    Max probe execution time in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC})

${pc.dim("Prints result.output.data.summary as JSON to stdout, pipeable to jq.")}
${pc.dim("Local files are auto-uploaded before job submission.")}
`);
}

// ── Command ────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "ffprobe", description: "Probe media metadata in the cloud" },
  args: {
    source: { type: "positional", description: "Media URL, asset URL, or local file path", required: false },
    keyframes: { type: "boolean", description: "Include a keyframe index in the probe", default: false },
    raw: { type: "boolean", description: "Print the full probe data, not just the summary", default: false },
    json: { type: "boolean", description: "Output the full job result as JSON", default: false },
    quiet: { type: "boolean", description: "No progress output, exit code only", default: false },
    "no-wait": { type: "boolean", description: "Submit and exit immediately", default: false },
    timeout: { type: "string", description: `Max probe execution time in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC})` },
  },
  async run({ args }) {
    const sourceArg = typeof args.source === "string" ? args.source.trim() : "";
    if (!sourceArg) { showHelp(); process.exit(0); }

    const isTTY = Boolean(process.stderr.isTTY);
    const flags = {
      keyframes: Boolean(args.keyframes),
      raw: Boolean(args.raw),
      json: Boolean(args.json),
      quiet: Boolean(args.quiet),
      noWait: Boolean(args["no-wait"]),
      timeout: resolveTimeout(typeof args.timeout === "string" ? args.timeout : undefined),
    };

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
      // ── 1. Upload (local file only) ─────────────────────
      let source = sourceArg;
      if (isLocalSource(source)) {
        const rewritten = await steps.step("Uploading", async (update) => {
          return uploadLocalFiles([source], [{ index: 0, value: source, isLocal: true }], client, {
            onFileStart: (filename, size) => update(`${filename} · ${fmtBytes(size)}`),
            onFileProgress: (filename, loaded, size) => update(`${filename} · ${fmtBytes(loaded)} / ${fmtBytes(size)}`),
          });
        });
        const uploaded = rewritten[0];
        if (!uploaded) throw new Error(`Upload failed for ${source}`);
        source = uploaded;
      }

      // ── 2. Submit ────────────────────────────────────────
      const job = await steps.step("Submitting", async () => {
        return client.jobs.create(
          { type: "ffprobe", inputs: { source }, params: buildProbeParams(flags.keyframes, flags.timeout) },
          { signal: controller.signal },
        );
      });

      jobId = job.id;

      if (flags.noWait) {
        if (flags.json) console.log(JSON.stringify({ id: job.id, status: job.status }));
        else if (!flags.quiet) console.log(job.id);
        process.exit(0);
      }

      // ── 3. Wait for the probe to finish ──────────────────
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

      // ── Output modes ─────────────────────────────────────
      if (flags.json) { console.log(JSON.stringify(result)); process.exit(0); }

      // API contract: ffprobe's output.data always has this shape (see header
      // comment). `jobData<T>()` does the status check plus the SDK's own
      // justified cast -- this is the command's one claim about ffprobe's shape.
      const data = jobData<ProbeData>(result);
      if (!data) {
        if (!flags.quiet) process.stderr.write(pc.red("  ✗ Probe completed with no data\n"));
        process.exit(1);
      }
      const payload = selectPayload(data, flags.raw);

      // Structured answer goes to stdout so it can be piped (e.g. to jq).
      console.log(JSON.stringify(payload, null, 2));
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
