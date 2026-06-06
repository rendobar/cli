/**
 * Step-by-step progress display and job monitoring.
 *
 * StepRenderer: each step shows spinner → checkmark. Spinner shows
 * elapsed time and optional suffix (machine info, progress %).
 *
 * waitForJob: WebSocket → polls for terminal status, captures machine
 * context from job.context events and passes to onContext callback.
 */
import pc from "picocolors";
import type { RendobarClient } from "@rendobar/sdk";

// ── Types ──────────────────────────────────────────────────────

export interface ProgressResult {
  status: string;
  outputUrl?: string;
  /** Served multi-file output (HLS/DASH, image sequence, resolution ladder). */
  output?: ServedOutput;
  error?: string;
  /** Last ~2 KB of ffmpeg stderr when the job failed at execution. */
  errorDetail?: string;
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
 * Served multi-file output. A single ffmpeg job can now emit a token-served
 * prefix (HLS/DASH playlist, image sequence, resolution ladder) instead of one
 * file. The published SDK type may not include this field yet (separate SDK
 * release), so we read it defensively from the runtime job object. Only the
 * fields the CLI renders are modelled here.
 */
export interface ServedOutput {
  /** stream = HLS/DASH playlist; set = unordered multi-file collection. */
  type: "stream" | "set";
  /** Primary URL: the entry playlist for a stream; absent for a set. */
  url?: string;
  /** Token-in-path serving base URL for the prefix (trailing slash). */
  baseUrl: string;
  /** Total number of files under the served prefix. */
  fileCount: number;
}

/**
 * The single URL to surface for a served output: the stream's entry playlist
 * when present, otherwise the prefix base URL (sets have no entry url).
 */
export function servedEntryUrl(output: ServedOutput): string {
  return output.url ?? output.baseUrl;
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
    outputUrl: typeof job.outputUrl === "string" ? job.outputUrl : undefined,
    output: parseServedOutput(job.output),
    error: typeof job.errorMessage === "string" ? job.errorMessage : undefined,
    errorDetail: typeof job.errorDetail === "string" ? job.errorDetail : undefined,
    duration: totalMs,
    dispatchMs,
    queueMs,
    execMs,
    machine,
  };
}

/**
 * Narrow an unknown `output` field (from the runtime job object) into the
 * served-output summary the CLI renders. Returns undefined for single-output
 * jobs (no `output` object) or any unexpected shape. The published SDK type may
 * not carry this field yet, so this is read off `Record<string, unknown>`.
 */
function parseServedOutput(raw: unknown): ServedOutput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (o.type !== "stream" && o.type !== "set") return undefined;
  if (typeof o.baseUrl !== "string" || typeof o.fileCount !== "number") return undefined;
  return {
    type: o.type,
    url: typeof o.url === "string" ? o.url : undefined,
    baseUrl: o.baseUrl,
    fileCount: o.fileCount,
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

export async function downloadOutput(
  client: RendobarClient,
  jobId: string,
  outputPath: string,
): Promise<void> {
  const response = await client.jobs.download(jobId);
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
