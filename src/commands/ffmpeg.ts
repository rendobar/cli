/**
 * `rb ffmpeg` -- Run FFmpeg in the cloud.
 *
 * Timing: local steps (Upload, Submit, Saving) use wall-clock.
 * Cloud steps (Queued, Executing) use server timing from the job
 * object — same data the dashboard and SDK consumers display.
 */
import { defineCommand } from "citty";
import * as path from "node:path";
import pc from "picocolors";
import { createClient, isApiError } from "@rendobar/sdk";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl } from "../lib/auth.js";
import { parseFfmpegArgs } from "../lib/parse-ffmpeg-args.js";
import { uploadLocalFiles } from "../lib/upload.js";
import { StepRenderer, waitForJob, downloadOutput, type MachineContext } from "../lib/progress.js";

function fmtMs(ms: number): string {
  if (ms < 100) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// ── Flags ──────────────────────────────────────────────────────

interface GlobalFlags {
  json: boolean;
  urlOnly: boolean;
  quiet: boolean;
  noWait: boolean;
  timeout: number;
}

function extractGlobalFlags(): GlobalFlags {
  const argv = process.argv;
  const flags: GlobalFlags = { json: false, urlOnly: false, quiet: false, noWait: false, timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--url-only") flags.urlOnly = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--no-wait") flags.noWait = true;
    else if (arg === "--timeout" && i + 1 < argv.length) {
      // Guarded by i + 1 < argv.length above
      const val = parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(val) && val > 0) flags.timeout = Math.min(val, 900);
      i++;
    }
  }
  return flags;
}

function extractFfmpegArgs(): string[] {
  const argv = process.argv;
  const ffmpegIdx = argv.indexOf("ffmpeg");
  if (ffmpegIdx === -1) return [];
  const globalFlags = new Set(["--json", "--url-only", "--quiet", "--no-wait"]);
  const globalFlagsWithValue = new Set(["--timeout"]);
  const result: string[] = [];
  for (let i = ffmpegIdx + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (globalFlags.has(arg)) continue;
    if (globalFlagsWithValue.has(arg)) { i++; continue; }
    result.push(arg);
  }
  return result;
}

// ── Help ───────────────────────────────────────────────────────

function showHelp(): void {
  process.stderr.write(`
${pc.bold("Usage:")} rb ffmpeg [flags] <ffmpeg args>

${pc.bold("Examples:")}
  rb ffmpeg -i input.mp4 -vf scale=1280:720 output.mp4
  rb ffmpeg -i ./local.mp4 -c:v libx264 -crf 23 output.mp4
  rb ffmpeg -i https://example.com/video.mp4 -ss 10 -t 30 clip.mp4

${pc.bold("Flags:")}
  --json       Output full JSON result to stdout
  --url-only   Output only the result URL to stdout
  --quiet      No output, exit code only
  --no-wait    Submit and exit immediately (prints job ID)
  --timeout N  Max execution time in seconds (default: 120, max: 900)

${pc.dim("Local files are auto-uploaded before job submission.")}
${pc.dim("All FFmpeg flags are passed through to the cloud executor.")}
`);
}

// ── Command ────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "ffmpeg", description: "Run FFmpeg in the cloud" },
  async run() {
    const flags = extractGlobalFlags();
    const isTTY = Boolean(process.stderr.isTTY);
    const ffmpegArgs = extractFfmpegArgs();
    const parsed = parseFfmpegArgs(ffmpegArgs);

    if (parsed.isEmpty) { showHelp(); process.exit(0); }
    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) process.stderr.write(pc.red(`  ✗ ${err}\n`));
      process.exit(2);
    }

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
    const client = createClient(clientConfig);
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
      // ── 1. Upload (local files only) ─────────────────────
      let rewrittenArgs = ffmpegArgs;
      const localInputs = parsed.inputs.filter((i) => i.isLocal);

      if (localInputs.length > 0) {
        rewrittenArgs = await steps.step("Uploading", async () => {
          return uploadLocalFiles(ffmpegArgs, parsed.inputs, client);
        });
      }

      // ── 2. Submit ────────────────────────────────────────
      const command = "ffmpeg " + rewrittenArgs.join(" ");

      const job = await steps.step("Submitting", async () => {
        return client.jobs.create(
          { type: "raw.ffmpeg", params: { command, timeout: flags.timeout } },
          { signal: controller.signal },
        );
      });

      jobId = job.id;

      if (flags.noWait) {
        if (flags.json) console.log(JSON.stringify({ id: job.id, status: job.status }));
        else if (!flags.quiet) console.log(job.id);
        process.exit(0);
      }

      // ── 3. Wait for cloud execution ──────────────────────
      // Phase 1: "Queued" spinner until job.context arrives (executor started)
      // Phase 2: "Executing" spinner with machine specs until completion
      // Final: replace spinner with server-timed "Executed" line
      let machine: MachineContext | undefined;
      const queuedStart = Date.now();

      steps.startSpinnerRaw("Queued");

      const token = cred.type === "apikey" ? cred.apiKey : cred.accessToken;
      const result = await waitForJob({
        jobId: job.id,
        token,
        baseUrl,
        client,
        signal: controller.signal,
        onContext(ctx) {
          machine = ctx;
          // job.context = executor started = queue phase over
          // Print "Queued ✓" with elapsed time, start "Executing" spinner
          const queuedElapsed = Date.now() - queuedStart;
          steps.stopSpinnerRaw();
          if (!flags.quiet) {
            steps.done("Queued", queuedElapsed);
          }
          const label = `${ctx.machine} · ${ctx.cpu} vCPU · ${ctx.memory} GB${ctx.region ? ` · ${ctx.region}` : ""}`;
          steps.startSpinnerRaw("Executing");
          steps.updateSpinnerSuffix(label);
        },
      });

      steps.stopSpinnerRaw();

      // Show "Executed" with server timing (authoritative, matches dashboard)
      if (!flags.quiet) {
        const machineStr = machine
          ? ` ${pc.dim("·")} ${pc.dim(`${machine.machine} · ${machine.cpu} vCPU · ${machine.memory} GB`)}`
          : "";

        if (!machine) {
          // No job.context arrived — show combined timing
          steps.done("Executed", result.dispatchMs + result.queueMs + result.execMs);
        } else {
          steps.done("Executed", result.execMs, machineStr);
        }
      }

      // ── Handle failure ───────────────────────────────────
      if (result.status === "failed") {
        if (flags.json) console.log(JSON.stringify(result));
        else if (!flags.quiet) steps.info(pc.red(`✗ ${result.error ?? "Job failed"}`));
        process.exit(1);
      }
      if (result.status === "cancelled") process.exit(130);

      // ── Output modes ─────────────────────────────────────
      if (flags.json) { console.log(JSON.stringify(result)); process.exit(0); }
      if (flags.urlOnly) { if (result.outputUrl) console.log(result.outputUrl); process.exit(0); }

      // ── 4. Download output ───────────────────────────────
      if (parsed.outputFile && result.outputUrl) {
        const outputPath = path.resolve(parsed.outputFile);
        await steps.step("Saving", async () => {
          return downloadOutput(client, job.id, outputPath);
        });

        if (!flags.quiet && isTTY) {
          process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(parsed.outputFile)}\n`);
          process.stderr.write(`    ${pc.dim(`https://app.rendobar.com/jobs/${job.id}`)}\n`);
        }
      } else if (!flags.quiet && isTTY) {
        process.stderr.write(`\n    ${pc.dim(`https://app.rendobar.com/jobs/${job.id}`)}\n`);
      }

      process.exit(0);

    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") process.exit(130);
      if (isApiError(err)) {
        if (err.code === "INSUFFICIENT_CREDITS") {
          process.stderr.write(pc.red(`  ✗ Insufficient credits. ${err.message}\n`));
          process.stderr.write(`    Top up: ${pc.cyan("https://app.rendobar.com/billing")}\n`);
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
