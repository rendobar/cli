/**
 * `rb ffprobe` -- Run a raw ffprobe command against a media URL, in the cloud.
 *
 * Raw-command redesign: argv (ffprobe flags plus the media target) is joined
 * verbatim into `params.command`, exactly like `rb ffmpeg` does for its own
 * command string. There is no separate `inputs.source` -- the target lives
 * inside `command`. The job itself stays URL-only (the API requires an
 * `http(s)://` URL in `command`); a local file path typed on the CLI is
 * auto-uploaded first and the command is rewritten with the resulting URL,
 * exactly like `rb ffmpeg` does with its `-i` inputs -- see "Upload" below.
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
import { isLocalPath, type ParsedInput } from "../lib/parse-ffmpeg-args.js";
import { uploadLocalFiles } from "../lib/upload.js";
import { StepRenderer, fmtBytes } from "../lib/progress.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;

// ── Documented contract of the `ffprobe` job's `output.data` ──────
//
// (rendobar/rendobar, raw-command redesign). The SDK types `data` as
// `unknown` because `jobs.create`/`jobs.wait` are generic over job type --
// these interfaces encode the ffprobe-specific shape so the rest of the
// command works with real fields instead of `unknown`. `summary` is present
// for the normal/JSON-parsed case; `stdout` carries raw ffprobe text when the
// user requested a non-JSON output format instead. Every field beyond that is
// best-effort probe output.

interface StreamCounts {
  video?: number;
  audio?: number;
  subtitle?: number;
  data?: number;
  attachment?: number;
}

interface SummaryCommon {
  container?: string;
  formatLongName?: string;
  durationSec?: number | null;
  sizeBytes?: number;
  bitrateBps?: number;
  startTimeSec?: number;
  streamCounts?: StreamCounts;
  tags?: Record<string, string>;
}

interface VideoBlock {
  codec?: string;
  profile?: string;
  width?: number;
  height?: number;
  displayAspectRatio?: string;
  pixelFormat?: string;
  bitDepth?: number;
  fps?: number;
  isVariableFrameRate?: boolean;
  rotation?: number;
  isHdr?: boolean;
  bitrateBps?: number;
  language?: string;
}

interface AudioBlock {
  codec?: string;
  profile?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  bitrateBps?: number;
  language?: string;
}

interface ImageBlock {
  codec?: string;
  width?: number;
  height?: number;
  pixelFormat?: string;
  bitDepth?: number;
}

export type ProbeSummary =
  | (SummaryCommon & { kind: "video"; video: VideoBlock; audio?: AudioBlock | null })
  | (SummaryCommon & { kind: "audio"; audio: AudioBlock })
  | (SummaryCommon & { kind: "image"; image: ImageBlock })
  | (SummaryCommon & { kind: "other" });

export interface ProbeData {
  // `summary` is present for the normal/JSON-parsed probe case. It's absent
  // when the user asked ffprobe for a non-JSON output format (csv/xml, or
  // `-of default`) -- there's nothing to summarize, so `stdout` carries the
  // raw ffprobe text instead. Exactly one of the two is set.
  summary?: ProbeSummary;
  stdout?: string;
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

/**
 * Finds the media target among the raw ffprobe args -- the URL or local file
 * path the user is probing. Unlike `rb ffmpeg`, ffprobe args don't require an
 * explicit `-i` flag (`rb ffprobe video.mp4` is the documented minimal form),
 * so the target is the last token that isn't itself a flag. This still finds
 * an explicit `-i <path>` too, since its value is that same trailing token.
 * Reuses `isLocalPath` -- the exact local-vs-remote check `rb ffmpeg` uses via
 * `parseFfmpegArgs` -- rather than inventing a second rule for what "local"
 * means.
 */
export function findProbeInput(args: string[]): ParsedInput | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i]!;
    if (arg.startsWith("-")) continue;
    return { index: i, value: arg, isLocal: isLocalPath(arg) };
  }
  return null;
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

/** Strips trailing zeros (and a bare trailing dot) so `24.00` -> `24`, `23.50` -> `23.5`. */
function fmtNum(n: number, decimals = 2): string {
  const fixed = n.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** `12` -> `"12s"`, `5.01` -> `"5.01s"` (sub-minute, fractional), `75` -> `"1:15"`, `3661` -> `"1:01:01"`. */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${fmtNum(sec)}s`;
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** `449000` -> `"449 kbps"`, `2_500_000` -> `"2.5 Mbps"`. */
function fmtBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${fmtNum(bps / 1_000_000, 1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/** `48000` -> `"48 kHz"`, `44100` -> `"44.1 kHz"`. */
function fmtHz(hz: number): string {
  return `${fmtNum(hz / 1000, 1)} kHz`;
}

const DOT = pc.dim("·");

/** `Video · mov,mp4,m4a,3gp,3g2,mj2 · 5.01s · 344 KB` -- kind, container, duration, size. */
function formatHeaderLine(summary: ProbeSummary): string {
  const kindLabel = summary.kind.charAt(0).toUpperCase() + summary.kind.slice(1);
  const parts = [pc.bold(kindLabel)];
  const container = summary.container ?? summary.formatLongName;
  if (container) parts.push(container);
  if (summary.durationSec != null) parts.push(fmtDuration(summary.durationSec));
  if (summary.sizeBytes != null) parts.push(fmtBytes(summary.sizeBytes));
  return parts.join(` ${DOT} `);
}

const ROW_LABEL_WIDTH = 7;

function formatRow(label: string, fields: string[]): string {
  return `  ${pc.dim(label.padEnd(ROW_LABEL_WIDTH))}${fields.join("   ")}`;
}

function formatVideoRow(video: VideoBlock): string {
  const fields: string[] = [];
  if (video.codec) fields.push(video.profile ? `${video.codec} ${video.profile}` : video.codec);
  if (video.width && video.height) {
    const dar = video.displayAspectRatio ? ` (${video.displayAspectRatio})` : "";
    fields.push(`${video.width}x${video.height}${dar}`);
  }
  if (video.fps) fields.push(`${fmtNum(video.fps)} fps${video.isVariableFrameRate ? " (VFR)" : ""}`);
  const depthFormat = [video.bitDepth ? `${video.bitDepth}-bit` : null, video.pixelFormat].filter(Boolean).join(" ");
  if (depthFormat) fields.push(depthFormat);
  if (video.bitrateBps) fields.push(fmtBitrate(video.bitrateBps));
  if (video.isHdr) fields.push(pc.yellow("HDR"));
  if (video.rotation) fields.push(`rotated ${video.rotation}°`);
  if (video.language) fields.push(`[${video.language}]`);
  return formatRow("Video", fields);
}

function formatAudioRow(audio: AudioBlock): string {
  const fields: string[] = [];
  if (audio.codec) fields.push(audio.profile ? `${audio.codec} ${audio.profile}` : audio.codec);
  if (audio.channelLayout) fields.push(audio.channelLayout);
  else if (audio.channels) fields.push(`${audio.channels}ch`);
  if (audio.sampleRate) fields.push(fmtHz(audio.sampleRate));
  if (audio.bitrateBps) fields.push(fmtBitrate(audio.bitrateBps));
  if (audio.language) fields.push(`[${audio.language}]`);
  return formatRow("Audio", fields);
}

function formatImageRow(image: ImageBlock): string {
  const fields: string[] = [];
  if (image.width && image.height) fields.push(`${image.width}x${image.height}`);
  const depthFormat = [image.bitDepth ? `${image.bitDepth}-bit` : null, image.pixelFormat].filter(Boolean).join(" ");
  if (depthFormat) fields.push(depthFormat);
  return formatRow("Image", fields);
}

function formatStreamCountsRow(counts: StreamCounts | undefined): string | null {
  if (!counts) return null;
  const fields = (["video", "audio", "subtitle", "data", "attachment"] as const)
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${key}`);
  if (fields.length === 0) return null;
  return formatRow("Streams", fields);
}

/**
 * Readable multi-line summary block: a header line (kind, container,
 * duration, size) plus a detail row per stream kind found on the media.
 * Only present fields are rendered -- ffprobe's own data is best-effort, and
 * a field this media doesn't carry (e.g. no `displayAspectRatio`) is simply
 * skipped rather than printed as `undefined`.
 */
export function formatSummaryBlock(summary: ProbeSummary): string {
  const lines = [formatHeaderLine(summary)];
  const rows: string[] = [];

  if (summary.kind === "video") {
    rows.push(formatVideoRow(summary.video));
    if (summary.audio) rows.push(formatAudioRow(summary.audio));
  } else if (summary.kind === "audio") {
    rows.push(formatAudioRow(summary.audio));
  } else if (summary.kind === "image") {
    rows.push(formatImageRow(summary.image));
  } else {
    const streamsRow = formatStreamCountsRow(summary.streamCounts);
    if (streamsRow) rows.push(streamsRow);
  }

  if (rows.length > 0) lines.push("", ...rows);
  return lines.join("\n");
}

/**
 * Decides what to print for the non-JSON success path. `summary` renders as
 * the readable block; a `summary`-less response means the user asked ffprobe
 * for a non-JSON output format (csv/xml/-of default), so its raw `stdout` is
 * printed verbatim instead -- exactly what they asked for, nothing summarized.
 * Returns null when the response carries neither (unexpected API response).
 */
export function resolveOutputText(data: ProbeData): string | null {
  if (data.summary) return formatSummaryBlock(data.summary);
  if (data.stdout !== undefined) return data.stdout;
  return null;
}

// ── Help ───────────────────────────────────────────────────────

function showHelp(): void {
  process.stderr.write(`
${pc.bold("Usage:")} rb ffprobe [ffprobe-flags] <url-or-file>

${pc.bold("Examples:")}
  rb ffprobe https://example.com/video.mp4
  rb ffprobe ./local-video.mp4
  rb ffprobe -show_format -show_streams https://example.com/video.mp4
  rb ffprobe --json https://cdn.rendobar.com/uploads/abc.mp4

${pc.bold("Flags:")}
  --json         Print the full probe data as JSON, not just the summary
  --quiet        No progress output, exit code only
  --no-wait      Submit and exit immediately (prints job ID)
  --timeout N    Max probe execution time in seconds (default: ${DEFAULT_TIMEOUT_SEC}, max: ${MAX_TIMEOUT_SEC})

${pc.dim("Run a raw ffprobe command against a media URL or local file.")}
${pc.dim("Local files are auto-uploaded before job submission.")}
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
      // ── 1. Upload (local target only) ────────────────────
      let rewrittenArgs = probeArgs;
      const target = findProbeInput(probeArgs);

      if (target?.isLocal) {
        rewrittenArgs = await steps.step("Uploading", async (update) => {
          return uploadLocalFiles(probeArgs, [target], client, {
            onFileStart: (filename, size) => update(`${filename} · ${fmtBytes(size)}`),
            onFileProgress: (filename, loaded, size) => update(`${filename} · ${fmtBytes(loaded)} / ${fmtBytes(size)}`),
          });
        });
      }

      const command = buildCommand(rewrittenArgs);

      // ── 2. Submit ────────────────────────────────────────
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
      if (flags.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const text = resolveOutputText(data);
        if (text !== null) console.log(text);
        else if (!flags.quiet) process.stderr.write(pc.red("  ✗ Probe completed with no summary or output\n"));
      }

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
