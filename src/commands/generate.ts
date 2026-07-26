/**
 * `rb generate` -- Generate an image from a text prompt, in the cloud.
 *
 * Job-command shape mirrors `rb ffmpeg`: submit, wait via `waitForJob`
 * (WebSocket machine-context + HTTP-poll fallback), then resolve the output.
 * Unlike `rb ffmpeg`, the result is never auto-downloaded -- the generated
 * image's URL is always printed (pipeable via stdout); `--output` additionally
 * saves it to disk. There's no ffmpeg-style argv passthrough here: every flag
 * is a well-defined, named option, so parsing is a plain argv scan rather than
 * `parseFfmpegArgs`'s input/output detection.
 */
import { defineCommand } from "citty";
import * as path from "node:path";
import pc from "picocolors";
import { isApiError } from "@rendobar/sdk";
import { createCliClient } from "../lib/client.js";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, getDashboardBaseUrl } from "../lib/auth.js";
import { buildGenParams, parseIntFlag, parseFloatFlag } from "../lib/image-params.js";
import { StepRenderer, waitForJob, downloadUrlToFile, type MachineContext } from "../lib/progress.js";

// ── Flags ──────────────────────────────────────────────────────

export interface GenerateFlags {
  prompt: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  enhance: boolean;
  negative: string | null;
  guidance: number | null;
  steps: number | null;
  output: string | null;
  json: boolean;
  quiet: boolean;
  noWait: boolean;
  urlOnly: boolean;
}

/** Everything after the `generate` subcommand name in argv. */
export function extractGenerateArgs(argv: string[]): string[] {
  const idx = argv.indexOf("generate");
  if (idx === -1) return [];
  return argv.slice(idx + 1);
}

export function parseGenerateFlags(args: string[]): GenerateFlags {
  const flags: GenerateFlags = {
    prompt: null, model: null, width: null, height: null, seed: null,
    enhance: false, negative: null, guidance: null, steps: null, output: null,
    json: false, quiet: false, noWait: false, urlOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--prompt" && i + 1 < args.length) flags.prompt = args[++i]!;
    else if (arg === "--model" && i + 1 < args.length) flags.model = args[++i]!;
    else if (arg === "--width" && i + 1 < args.length) flags.width = parseIntFlag(args[++i]);
    else if (arg === "--height" && i + 1 < args.length) flags.height = parseIntFlag(args[++i]);
    else if (arg === "--seed" && i + 1 < args.length) flags.seed = parseIntFlag(args[++i]);
    else if (arg === "--enhance") flags.enhance = true;
    else if (arg === "--negative" && i + 1 < args.length) flags.negative = args[++i]!;
    else if (arg === "--guidance" && i + 1 < args.length) flags.guidance = parseFloatFlag(args[++i]);
    else if (arg === "--steps" && i + 1 < args.length) flags.steps = parseIntFlag(args[++i]);
    else if (arg === "--output" && i + 1 < args.length) flags.output = args[++i]!;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--no-wait") flags.noWait = true;
    else if (arg === "--url-only") flags.urlOnly = true;
  }
  return flags;
}

// ── Help ───────────────────────────────────────────────────────

function showHelp(): void {
  process.stderr.write(`
${pc.bold("Usage:")} rb generate --prompt <text> [flags]

${pc.bold("Examples:")}
  rb generate --prompt "a red fox in a snowy forest"
  rb generate --prompt "cyberpunk city at night" --model premium --width 1024 --height 1024
  rb generate --prompt "logo mockup, flat vector style" --seed 42 --output logo.webp

${pc.bold("Flags:")}
  --prompt <text>      Text prompt to generate from (required)
  --model <id|tier>    Model id or tier alias (default: economy; economy, standard, premium)
  --width <n>          Output width in pixels
  --height <n>         Output height in pixels
  --seed <n>           Seed for reproducible output
  --enhance            Let the model expand/enhance your prompt
  --negative <text>    Negative prompt -- what to avoid
  --guidance <n>       Guidance / CFG scale
  --steps <n>          Diffusion steps
  --output <path>      Also download the generated image to this local path
  --json               Output full JSON result to stdout
  --quiet              No output, exit code only
  --no-wait            Submit and exit immediately (prints job ID)
  --url-only           Print the result URL only, download nothing

${pc.dim("Always prints the generated image's URL; add --output to also save it locally.")}
${pc.dim("Full model list: see `GET /models?job=image.generate` -- not hardcoded here, it drifts.")}
`);
}

// ── Command ────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "generate", description: "Generate an image from a text prompt" },
  async run() {
    const args = extractGenerateArgs(process.argv);
    const flags = parseGenerateFlags(args);

    if (args.length === 0) { showHelp(); process.exit(0); }
    if (!flags.prompt) {
      process.stderr.write(pc.red("  ✗ --prompt is required.\n"));
      process.exit(2);
    }
    const prompt = flags.prompt; // narrowed non-null by the check above

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
    const isTTY = Boolean(process.stderr.isTTY);
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
      // ── 1. Submit ────────────────────────────────────────
      const params = buildGenParams({
        prompt,
        model: flags.model,
        width: flags.width,
        height: flags.height,
        seed: flags.seed,
        enhance: flags.enhance,
        negative: flags.negative,
        guidance: flags.guidance,
        steps: flags.steps,
      });

      const job = await steps.step("Submitting", async () => {
        return client.jobs.create({ type: "image.generate", params }, { signal: controller.signal });
      });

      jobId = job.id;

      if (flags.noWait) {
        if (flags.json) console.log(JSON.stringify({ id: job.id, status: job.status }));
        else if (!flags.quiet) console.log(job.id);
        process.exit(0);
      }

      // ── 2. Wait for cloud execution ──────────────────────
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
          const queuedElapsed = Date.now() - queuedStart;
          steps.stopSpinnerRaw();
          if (!flags.quiet) steps.done("Queued", queuedElapsed);
          const label = `${ctx.machine} · ${ctx.cpu} vCPU · ${ctx.memory} GB${ctx.region ? ` · ${ctx.region}` : ""}`;
          steps.startSpinnerRaw("Executing");
          steps.updateSpinnerSuffix(label);
        },
      });

      steps.stopSpinnerRaw();

      if (!flags.quiet) {
        const machineStr = machine
          ? ` ${pc.dim("·")} ${pc.dim(`${machine.machine} · ${machine.cpu} vCPU · ${machine.memory} GB`)}`
          : "";
        if (!machine) steps.done("Generated", result.dispatchMs + result.queueMs + result.execMs);
        else steps.done("Generated", result.execMs, machineStr);
      }

      // ── Handle failure ───────────────────────────────────
      if (result.status === "failed") {
        if (flags.json) console.log(JSON.stringify(result));
        else if (!flags.quiet) {
          const err = result.error;
          const headline = err ? `${err.code}: ${err.message}` : "Job failed";
          steps.info(pc.red(`✗ ${headline}`));
          if (err?.detail) {
            for (const line of err.detail.trimEnd().split("\n")) steps.info(pc.dim(line));
          }
        }
        process.exit(1);
      }
      if (result.status === "cancelled") process.exit(130);

      if (flags.json) { console.log(JSON.stringify(result)); process.exit(0); }

      // ── 3. Resolve output ─────────────────────────────────
      const out = result.output;
      const file = out?.file ?? null;
      const url = file?.url;
      const dashboardLine = `    ${pc.dim(`${getDashboardBaseUrl()}/jobs/${job.id}`)}\n`;

      if (flags.urlOnly) {
        if (url) console.log(url);
        process.exit(0);
      }

      if (!url) {
        // No file in output (unexpected) -- point at the dashboard.
        if (!flags.quiet && isTTY) process.stderr.write(`\n${dashboardLine}`);
        process.exit(0);
      }

      // Always print the URL -- pipeable, and the default way to get the result.
      if (!flags.quiet) console.log(url);

      if (flags.output) {
        const outputPath = path.resolve(flags.output);
        await steps.step("Saving", async () => downloadUrlToFile(url, outputPath, controller.signal));

        if (!flags.quiet && isTTY) {
          const dims = file.meta?.width && file.meta?.height ? ` ${pc.dim(`${file.meta.width}×${file.meta.height}`)}` : "";
          process.stderr.write(`\n  ${pc.green("→")} ${pc.bold(path.relative(process.cwd(), outputPath) || flags.output)}${dims}\n`);
        }
      }

      if (!flags.quiet && isTTY) process.stderr.write(dashboardLine);
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
