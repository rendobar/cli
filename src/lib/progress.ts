/**
 * Step-by-step progress display and job monitoring.
 *
 * StepRenderer: each step shows spinner → checkmark. Spinner shows
 * elapsed time and optional suffix (machine info, progress %).
 *
 * waitForJob: WebSocket → polls for terminal status, captures machine
 * context from job.context events and passes to onContext callback.
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import pc from "picocolors";
import type { RendobarClient } from "@rendobar/sdk";

// ── Types ──────────────────────────────────────────────────────

export interface ProgressResult {
  status: string;
  /** Unified job output, present only when status === "complete". */
  output?: JobOutput;
  /** Structured failure, present only when status === "failed". */
  error?: JobError;
  /** Total: Created → Completed */
  duration: number;
  /** Created → Dispatched (API processing + queue dispatch) */
  dispatchMs: number;
  /** Dispatched → Started (waiting for executor machine) */
  queueMs: number;
  /** Started → Completed (actual execution) */
  execMs: number;
  machine?: MachineContext;
}

export interface MachineContext {
  machine: string;
  cpu: number;
  memory: number;
  region?: string;
}

/**
 * Unified job output (mirrors the API `Output` shape — one shape for every job
 * type). The published `@rendobar/sdk` may still export the old discriminated
 * union, so the CLI narrows the runtime job object defensively against this new
 * shape. Only the fields the CLI renders are modelled.
 *
 *  - data  : computed answer (job-specific JSON), or null for file-only jobs.
 *  - file  : the headline file — single output OR stream manifest — or null for
 *            data-only jobs and unordered sets.
 *  - files : every produced file ([] for data-only jobs).
 */
export interface JobOutput {
  data: unknown;
  file: JobFile | null;
  files: JobFile[];
  expiresAt: number | null;
}

/** A single produced file (mirrors the API `File` shape). */
export interface JobFile {
  url: string;
  path: string;
  type: "video" | "image" | "audio" | "captions" | "playlist" | "data" | "other";
  size: number;
  meta?: {
    format?: string;
    width?: number;
    height?: number;
    durationMs?: number;
  };
}

/** Structured failure (mirrors the API `error` object). */
export interface JobError {
  code: string;
  message: string;
  /** Real provider stderr tail (e.g. ffmpeg), or null. */
  detail: string | null;
  retryable: boolean;
}

/**
 * The single playable/download URL for an output: the headline `file` url
 * (single file or stream manifest) when present, otherwise the first of `files`
 * for an unordered set. Returns undefined for data-only outputs (no file) so
 * `--url-only` prints nothing.
 */
export function outputUrl(output: JobOutput): string | undefined {
  if (output.file) return output.file.url;
  return output.files[0]?.url;
}

// ── ANSI ───────────────────────────────────────────────────────

const ESC = "\x1b[";
const CLR = `${ESC}2K`;
const COL0 = `${ESC}0G`;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function fmtMs(ms: number): string {
  if (ms < 100) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Step renderer ──────────────────────────────────────────────

export class StepRenderer {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private spinnerStart = 0;
  private spinnerLabel = "";
  private spinnerSuffix = "";
  private isTTY: boolean;
  private quiet: boolean;

  constructor(options: { isTTY: boolean; quiet?: boolean }) {
    this.isTTY = options.isTTY;
    this.quiet = options.quiet ?? false;
  }

  /** Run a task with a spinner. Returns the task result. */
  async step<T>(label: string, task: (update: (suffix: string) => void) => Promise<T>): Promise<T> {
    const start = Date.now();

    if (this.isTTY && !this.quiet) {
      this.startSpinner(label);
    }

    const updateSuffix = (suffix: string) => {
      this.spinnerSuffix = suffix;
    };

    try {
      const result = await task(updateSuffix);
      const elapsed = Date.now() - start;
      this.done(label, elapsed);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      this.fail(label, elapsed, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  done(label: string, elapsedMs: number, suffix?: string): void {
    this.stopSpinner();
    if (this.quiet) return;
    const padded = label.padEnd(14);
    const sfx = suffix ?? "";
    if (this.isTTY) {
      process.stderr.write(`  ${pc.green("✓")} ${padded} ${pc.dim(fmtMs(elapsedMs))}${sfx}\n`);
    } else {
      process.stderr.write(`${label}: done (${fmtMs(elapsedMs)})\n`);
    }
  }

  fail(label: string, elapsedMs: number, error?: string): void {
    this.stopSpinner();
    if (this.quiet) return;
    const padded = label.padEnd(14);
    if (this.isTTY) {
      process.stderr.write(`  ${pc.red("✗")} ${padded} ${pc.dim(fmtMs(elapsedMs))}${error ? pc.red(` ${error}`) : ""}\n`);
    } else {
      process.stderr.write(`${label}: failed (${fmtMs(elapsedMs)})${error ? ` ${error}` : ""}\n`);
    }
  }

  info(text: string): void {
    if (this.quiet) return;
    process.stderr.write(this.isTTY ? `  ${text}\n` : `${text}\n`);
  }

  /** Start spinner without wrapping a task (for manual control). */
  startSpinnerRaw(label: string): void {
    this.startSpinner(label);
  }

  /** Update the spinner suffix (machine specs, etc). */
  updateSpinnerSuffix(suffix: string): void {
    this.spinnerSuffix = suffix;
  }

  /** Stop spinner without printing a result line. */
  stopSpinnerRaw(): void {
    this.stopSpinner();
  }

  private startSpinner(label: string): void {
    if (!this.isTTY || this.quiet) return;
    this.stopSpinner();
    this.spinnerStart = Date.now();
    this.spinnerLabel = label;
    this.spinnerSuffix = "";
    const render = () => {
      this.frame = (this.frame + 1) % FRAMES.length;
      const elapsed = ((Date.now() - this.spinnerStart) / 1000).toFixed(0);
      const suffix = this.spinnerSuffix ? ` ${pc.dim("·")} ${pc.dim(this.spinnerSuffix)}` : "";
      process.stderr.write(`${COL0}${CLR}  ${pc.cyan(FRAMES[this.frame]!)} ${this.spinnerLabel} ${pc.dim(`${elapsed}s`)}${suffix}\r`);
    };
    render();
    this.timer = setInterval(render, 80);
  }

  private stopSpinner(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.isTTY) process.stderr.write(`${COL0}${CLR}`);
  }
}

// ── Wait for job ───────────────────────────────────────────────

export interface WaitOptions {
  jobId: string;
  token: string;
  baseUrl: string;
  client: RendobarClient;
  signal?: AbortSignal;
  onContext?: (ctx: MachineContext) => void;
}

export async function waitForJob(options: WaitOptions): Promise<ProgressResult> {
  const { jobId, token, baseUrl, client, signal, onContext } = options;

  try {
    const wsResult = await waitViaWebSocket(jobId, token, baseUrl, signal, onContext);
    const job = await client.jobs.get(jobId, { signal });
    return buildResult(wsResult.status, wsResult.machine, job);
  } catch {
    // WebSocket failed — fall back to HTTP polling
    const job = await client.jobs.wait(jobId, { timeout: 900_000, interval: 2_000, signal });
    return buildResult(job.status, undefined, job);
  }
}

interface WsResult {
  status: string;
  machine?: MachineContext;
}

export function buildResult(status: string, machine: MachineContext | undefined, job: Record<string, unknown>): ProgressResult {
  const createdAt = typeof job.createdAt === "number" ? job.createdAt : 0;
  const dispatchedAt = typeof job.dispatchedAt === "number" ? job.dispatchedAt : 0;
  const startedAt = typeof job.startedAt === "number" ? job.startedAt : 0;
  const completedAt = typeof job.completedAt === "number" ? job.completedAt : 0;

  // Dispatch time: Created → Dispatched (API processing + queue dispatch)
  const dispatchMs = dispatchedAt && createdAt ? dispatchedAt - createdAt : 0;
  // Queue time: Dispatched → Started (waiting for executor machine)
  const queueMs = startedAt && dispatchedAt ? startedAt - dispatchedAt : 0;
  // Execution time: Started → Completed (FFmpeg running)
  const execMs = completedAt && startedAt ? completedAt - startedAt : 0;
  // Total: Created → Completed
  const totalMs = completedAt && createdAt ? completedAt - createdAt : 0;

  return {
    status,
    output: parseOutput(job.output),
    error: parseError(job.error),
    duration: totalMs,
    dispatchMs,
    queueMs,
    execMs,
    machine,
  };
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

const FILE_TYPES = new Set(["video", "image", "audio", "captions", "playlist", "data", "other"]);

/**
 * Narrow an unknown value into a `JobFile`. Returns undefined when the shape is
 * unexpected (missing url, etc).
 */
function parseFile(raw: unknown): JobFile | undefined {
  const f = asRecord(raw);
  if (!f) return undefined;
  if (typeof f.url !== "string") return undefined;
  const type = typeof f.type === "string" && FILE_TYPES.has(f.type)
    ? (f.type as JobFile["type"])
    : "other";
  const meta = asRecord(f.meta);
  return {
    url: f.url,
    path: typeof f.path === "string" ? f.path : "",
    type,
    size: optNumber(f.size) ?? 0,
    meta: meta
      ? {
          format: optString(meta.format),
          width: optNumber(meta.width),
          height: optNumber(meta.height),
          durationMs: optNumber(meta.durationMs),
        }
      : undefined,
  };
}

/**
 * Narrow an unknown `output` field (from the runtime job object) into the
 * unified `JobOutput` the CLI renders. Returns undefined when there is no output
 * (job not complete) or the shape is unexpected. Read off
 * `Record<string, unknown>` because the published SDK type may still carry the
 * old discriminated union.
 */
function parseOutput(raw: unknown): JobOutput | undefined {
  const o = asRecord(raw);
  if (!o) return undefined;

  // The unified shape always carries a `files` array. Require it to avoid
  // mis-reading an old-shaped or malformed object as an empty output.
  if (!Array.isArray(o.files)) return undefined;

  const files = o.files
    .map(parseFile)
    .filter((f): f is JobFile => f !== undefined);

  return {
    data: "data" in o ? o.data : null,
    file: o.file === null || o.file === undefined ? null : (parseFile(o.file) ?? null),
    files,
    expiresAt: optNumber(o.expiresAt) ?? null,
  };
}

/**
 * Narrow an unknown `error` field into the structured `JobError` the CLI
 * renders. Returns undefined when the shape is unexpected (e.g. no error).
 */
function parseError(raw: unknown): JobError | undefined {
  const o = asRecord(raw);
  if (!o) return undefined;
  if (typeof o.code !== "string" || typeof o.message !== "string") return undefined;
  return {
    code: o.code,
    message: o.message,
    detail: typeof o.detail === "string" ? o.detail : null,
    retryable: o.retryable === true,
  };
}

function waitViaWebSocket(
  jobId: string,
  token: string,
  baseUrl: string,
  signal?: AbortSignal,
  onContext?: (ctx: MachineContext) => void,
): Promise<WsResult> {
  return new Promise<WsResult>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }

    let settled = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    let capturedMachine: MachineContext | undefined;

    const onAbort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const safety = setTimeout(() => {
      if (!settled) { cleanup(); reject(new Error("Timeout")); }
    }, 15 * 60 * 1000);

    function cleanup() {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      signal?.removeEventListener("abort", onAbort);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    }

    function connect() {
      if (settled) return;
      const wsUrl = baseUrl.replace("https://", "wss://").replace("http://", "ws://");
      ws = new WebSocket(`${wsUrl}/events/ws/job/${jobId}`, {
        // @ts-expect-error -- Bun WebSocket accepts headers
        headers: { Authorization: `Bearer ${token}` },
      });

      ws.addEventListener("open", () => {
        reconnectAttempts = 0;
        // ws is guaranteed non-null — this callback fires on the socket we just created
        ws!.send(JSON.stringify({ type: "init", lastEventId: 0 }));
      });

      ws.addEventListener("message", (evt) => {
        if (settled || typeof evt.data !== "string") return;

        let raw: unknown;
        try { raw = JSON.parse(evt.data); } catch { return; }
        if (!raw || typeof raw !== "object") return;
        const msg = raw as Record<string, unknown>;

        if (msg.type === "job.context") {
          if (typeof msg.machine === "string" && typeof msg.cpu === "number" && typeof msg.memory === "number") {
            capturedMachine = {
              machine: msg.machine,
              cpu: msg.cpu,
              memory: msg.memory,
              region: typeof msg.region === "string" ? msg.region : undefined,
            };
            onContext?.(capturedMachine);
          }
        }

        if (msg.type === "job.status" && typeof msg.status === "string") {
          const status = msg.status;
          if (status === "complete" || status === "failed" || status === "cancelled") {
            cleanup();
            resolve({ status, machine: capturedMachine });
          }
        }
      });

      ws.addEventListener("close", () => {
        if (settled) return;
        if (reconnectAttempts < 10) {
          reconnectTimer = setTimeout(connect, 500 * Math.pow(1.5, reconnectAttempts++));
        } else {
          cleanup();
          reject(new Error("WebSocket unavailable"));
        }
      });

      // Error is always followed by close — reconnection handled there
      ws.addEventListener("error", () => {});
    }

    connect();
  });
}

// ── Download ───────────────────────────────────────────────────

/**
 * Stream a fetch `Response` body to a local path. Large bodies stream in 1 MiB
 * chunks (bounded memory); small ones write in one shot.
 */
async function streamToFile(response: Response, outputPath: string): Promise<void> {
  const totalBytes = Number(response.headers.get("content-length") || 0);

  if (totalBytes > 1_000_000 && response.body) {
    const writer = Bun.file(outputPath).writer({ highWaterMark: 1024 * 1024 });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }
    } finally {
      writer.end();
    }
  } else {
    await Bun.write(outputPath, response);
  }
}

/**
 * Download the job's headline output via the SDK `/download` endpoint to a local
 * path. Kept for the single-file case where no per-file url is needed.
 */
export async function downloadOutput(
  client: RendobarClient,
  jobId: string,
  outputPath: string,
): Promise<void> {
  const response = await client.jobs.download(jobId);
  await streamToFile(response, outputPath);
}

/**
 * Download a single ready-to-fetch (signed) URL from the job response to a local
 * path. Uses the url verbatim — never reconstructs a host.
 */
export async function downloadUrlToFile(
  url: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await streamToFile(response, outputPath);
}

/**
 * Download every file of a set/stream output into a local directory, preserving
 * each file's relative `path` (so an HLS manifest + its segments land alongside
 * each other and play locally). Returns the local paths written.
 *
 * Each file is fetched from its own signed `url` in the response — no host is
 * ever hardcoded.
 */
export async function downloadFilesToDir(
  files: JobFile[],
  dir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    // Fall back to the url's basename if the file carries no relative path.
    const rel = file.path && file.path.trim().length > 0
      ? file.path
      : basenameFromUrl(file.url);
    // Strip any leading slashes / drive-absolute prefix so join stays under dir.
    const safeRel = rel.replace(/^([a-zA-Z]:)?[\\/]+/, "");
    const target = path.join(dir, safeRel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await downloadUrlToFile(file.url, target, signal);
    written.push(target);
  }
  return written;
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : "output";
  } catch {
    return "output";
  }
}
