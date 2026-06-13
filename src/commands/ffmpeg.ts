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
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, getDashboardBaseUrl } from "../lib/auth.js";
import { parseFfmpegArgs } from "../lib/parse-ffmpeg-args.js";
import { shellEscape } from "../lib/shell-escape.js";
import { uploadLocalFiles } from "../lib/upload.js";
import {
  StepRenderer,
  waitForJob,
  downloadUrlToFile,
  downloadFilesToDir,
  outputUrl,
  fmtBytes,
  type MachineContext,
} from "../lib/progress.js";

function fmtMs(ms: number): string {
  if (ms < 100) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Default local folder name for a multi-file/stream output. Prefer the basename
 * (without extension) of the output token the user named, else a remote path.
 */
function defaultDirName(outputFile: string | null, fallbackPath: string | undefined): string {
  const source = outputFile ?? fallbackPath ?? "output";
  const base = path.basename(source);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.length > 0 ? stem : "output";
}

/**
 * Find the locally-written manifest path among the downloaded files, matching by
 * the remote manifest's basename (`.m3u8` / `.mpd`).
 */
function localManifestPath(written: string[], manifestRemotePath: string): string | undefined {
  const name = path.basename(manifestRemotePath);
  if (name.length === 0) return undefined;
  return written.find((p) => path.basename(p) === name);
}

// ── Flags ──────────────────────────────────────────────────────

type Compute = "auto" | "cpu" | "gpu";
const COMPUTE_MODES: readonly Compute[] = ["auto", "cpu", "gpu"];

function isCompute(value: string): value is Compute {
  return (COMPUTE_MODES as readonly string[]).includes(value);
}

interface GlobalFlags {
  json: boolean;
  urlOnly: boolean;
  quiet: boolean;
  noWait: boolean;
  noDownload: boolean;
  output: string | null;
  outputDir: string | null;
  timeout: number;
  compute: Compute | null;
}

function extractGlobalFlags(): GlobalFlags {
  const argv = process.argv;
  const flags: GlobalFlags = {
    json: false,
    urlOnly: false,
    quiet: false,
    noWait: false,
    noDownload: false,
    output: null,
    outputDir: null,
    timeout: 120,
    compute: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--url-only") flags.urlOnly = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--no-wait") flags.noWait = true;
    else if (arg === "--no-download") flags.noDownload = true;
    else if (arg === "--output" && i + 1 < argv.length) {
      flags.output = argv[i + 1]!; // Guarded by i + 1 < argv.length
      i++;
    } else if (arg === "--output-dir" && i + 1 < argv.length) {
      flags.outputDir = argv[i + 1]!; // Guarded by i + 1 < argv.length
      i++;
    } else if (arg === "--timeout" && i + 1 < argv.length) {
      // Guarded by i + 1 < argv.length above
      const val = parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(val) && val > 0) flags.timeout = Math.min(val, 900);
      i++;
    } else if (arg === "--compute" && i + 1 < argv.length) {
      const val = argv[i + 1]!; // Guarded by i + 1 < argv.length
      if (!isCompute(val)) {
        process.stderr.write(pc.red(`  ✗ Invalid --compute value "${val}". Expected one of: auto, cpu, gpu.\n`));
        process.exit(2);
      }
      flags.compute = val;
      i++;
    }
  }
  return flags;
}

function extractFfmpegArgs(): string[] {
  const argv = process.argv;
  const ffmpegIdx = argv.indexOf("ffmpeg");
  if (ffmpegIdx === -1) return [];
  const globalFlags = new Set(["--json", "--url-only", "--quiet", "--no-wait", "--no-download"]);
  const globalFlagsWithValue = new Set(["--timeout", "--output", "--output-dir", "--compute"]);
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
  --output <path>     Write the output to this local path
  --output-dir <dir>  Write a multi-file/stream output into this local folder
  --no-download       Submit and report, but don't download
  --url-only          Print the result URL(s), download nothing
  --json              Output full JSON result to stdout
  --quiet             No output, exit code only
  --no-wait           Submit and exit immediately (prints job ID)
  --timeout N         Max execution time in seconds (default: 120, max: 900)
  --compute <mode>    Run on cpu or gpu hardware (auto, cpu, gpu; gpu needs Pro)

${pc.dim("Outputs download to your folder by default — like running ffmpeg locally.")}
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
        rewrittenArgs = await steps.step("Uploading", async (update) => {
          const filePrefix = (index: number, count: number) =>
            count > 1 ? `${index + 1}/${count} ` : "";
          return uploadLocalFiles(ffmpegArgs, parsed.inputs, client, {
            onFileStart: (filename, size, index, count) =>
              update(`${filePrefix(index, count)}${filename} · ${fmtBytes(size)}`),
            onFileProgress: (filename, loaded, size, index, count) =>
              update(`${filePrefix(index, count)}${filename} · ${fmtBytes(loaded)} / ${fmtBytes(size)}`),
          });
        });
      }

      // ── 2. Submit ────────────────────────────────────────
      // POSIX-shell-escape each argv element before joining. The host shell
      // (PowerShell, bash, cmd.exe) has already stripped one quoting layer
      // before the CLI sees argv; without escaping, single quotes embedded
      // in filter expressions get tokenized away on the API side, causing
      // FFmpeg to mis-parse commas as filter graph separators ("Filter not
      // found"). The API's command-string parser implements the matching
      // POSIX rules so this round-trips losslessly.
      const command = "ffmpeg " + rewrittenArgs.map(shellEscape).join(" ");

      const job = await steps.step("Submitting", async () => {
        return client.jobs.create(
          {
            type: "ffmpeg",
            params: { command, timeout: flags.timeout, ...(flags.compute ? { compute: flags.compute } : {}) },
          },
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
        else if (!flags.quiet) {
          const err = result.error;
          const headline = err ? `${err.code}: ${err.message}` : "Job failed";
          steps.info(pc.red(`✗ ${headline}`));
          // Surface the ffmpeg stderr tail so failures are debuggable in-place.
          if (err?.detail) {
            for (const line of err.detail.trimEnd().split("\n")) {
              steps.info(pc.dim(line));
            }
          }
        }
        process.exit(1);
      }
      if (result.status === "cancelled") process.exit(130);

      // ── Output modes ─────────────────────────────────────
      if (flags.json) { console.log(JSON.stringify(result)); process.exit(0); }
      if (flags.urlOnly) {
        // headline file url (single file or stream manifest); first file for a set.
        const url = result.output ? outputUrl(result.output) : undefined;
        if (url) console.log(url);
        process.exit(0);
      }

      // ── 4. Download outputs locally (like a local tool) ──
      // Unified output shape: `file` is the headline (single file or stream
      // manifest), `files` lists every produced file, `data` is the computed
      // answer for data-only jobs. Default behavior downloads the produced
      // file(s) into the user's folder so `out.mp4` simply appears — exactly
      // like running ffmpeg locally. Every fetch uses the signed url already in
      // the response; no host is ever reconstructed.
      const out = result.output;
      const file = out?.file ?? null;
      const isStream = file?.type === "playlist";
      const dashboardLine = `    ${pc.dim(`${getDashboardBaseUrl()}/jobs/${job.id}`)}\n`;
      const hasData = Boolean(out && out.data !== null && out.data !== undefined);

      // --no-download: submit + report only, never write to disk.
      if (flags.noDownload) {
        if (!flags.quiet && isTTY) {
          if (file) {
            const dims = file.meta?.width && file.meta?.height ? ` ${pc.dim(`${file.meta.width}×${file.meta.height}`)}` : "";
            process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(file.url)}${dims}\n`);
          } else if (out && out.files.length > 0) {
            const label = out.files.length === 1 ? "file" : "files";
            process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(`${out.files.length} ${label}`)}\n`);
          } else if (hasData && out) {
            process.stderr.write(`\n${JSON.stringify(out.data, null, 2)}\n`);
          }
          process.stderr.write(dashboardLine);
        }
        process.exit(0);
      }

      if (!out) {
        // No output object (unexpected) — just point at the dashboard.
        if (!flags.quiet && isTTY) process.stderr.write(`\n${dashboardLine}`);
        process.exit(0);
      }

      if (file && !isStream && out.files.length <= 1) {
        // ── single file ── download to the user-named output path.
        const targetName = flags.output ?? parsed.outputFile ?? path.basename(file.path || "output");
        const outputPath = path.resolve(targetName);
        await steps.step("Saving", async () => downloadUrlToFile(file.url, outputPath, controller.signal));

        if (!flags.quiet && isTTY) {
          const dims = file.meta?.width && file.meta?.height ? ` ${pc.dim(`${file.meta.width}×${file.meta.height}`)}` : "";
          process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(path.relative(process.cwd(), outputPath) || targetName)}${dims}\n`);
          process.stderr.write(dashboardLine);
        }
      } else if (isStream && file) {
        // ── stream ── download the manifest + every segment into a folder so
        // it plays locally; print the local manifest path.
        const dir = path.resolve(flags.outputDir ?? flags.output ?? defaultDirName(parsed.outputFile, file.path));
        const written = await steps.step("Saving", async () => downloadFilesToDir(out.files, dir, controller.signal));

        if (!flags.quiet && isTTY) {
          const manifest = localManifestPath(written, file.path) ?? dir;
          const label = written.length === 1 ? "file" : "files";
          process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(path.relative(process.cwd(), manifest) || manifest)}\n`);
          process.stderr.write(`    ${pc.dim(`${written.length} ${label}`)}\n`);
          process.stderr.write(dashboardLine);
        }
      } else if (out.files.length > 0) {
        // ── set ── download all files into a folder, preserving each path.
        const dir = path.resolve(flags.outputDir ?? flags.output ?? defaultDirName(parsed.outputFile, out.files[0]?.path));
        const written = await steps.step("Saving", async () => downloadFilesToDir(out.files, dir, controller.signal));

        if (!flags.quiet && isTTY) {
          const label = written.length === 1 ? "file" : "files";
          process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(path.relative(process.cwd(), dir) || dir)}${path.sep}\n`);
          process.stderr.write(`    ${pc.dim(`${written.length} ${label}`)}\n`);
          process.stderr.write(dashboardLine);
        }
      } else if (hasData) {
        // ── data job ── print structured data as pretty JSON; optionally write.
        const pretty = JSON.stringify(out.data, null, 2);
        if (flags.output) {
          const outputPath = path.resolve(flags.output);
          await steps.step("Saving", async () => { await Bun.write(outputPath, pretty); });
          if (!flags.quiet && isTTY) {
            process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(path.relative(process.cwd(), outputPath) || flags.output)}\n`);
            process.stderr.write(dashboardLine);
          }
        } else {
          // Structured answer goes to stdout so it can be piped (e.g. to jq).
          console.log(pretty);
          if (!flags.quiet && isTTY) process.stderr.write(dashboardLine);
        }
      } else if (!flags.quiet && isTTY) {
        process.stderr.write(`\n${dashboardLine}`);
      }

      process.exit(0);

    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") process.exit(130);
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
