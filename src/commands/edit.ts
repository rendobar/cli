/**
 * `rb edit` -- Edit one or more images from a text instruction, in the cloud.
 *
 * Same job-command shape as `rb generate` (submit → `waitForJob` → resolve
 * output, URL always printed, `--output` additionally downloads). The one
 * extra step is image resolution: each `--image` value becomes `inputs.images`
 * verbatim if it's already a URL, or gets uploaded first via the CLI's
 * existing `uploadLocalFiles` flow (the same one `rb ffmpeg`/`rb ffprobe` use
 * for local `-i` inputs) if it's a local path -- `isLocalPath` is the same
 * single source of truth for that check.
 */
import { defineCommand } from "citty";
import * as path from "node:path";
import pc from "picocolors";
import { isApiError } from "@rendobar/sdk";
import { createCliClient } from "../lib/client.js";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, getDashboardBaseUrl } from "../lib/auth.js";
import { buildGenParams, parseIntFlag } from "../lib/image-params.js";
import { isLocalPath, type ParsedInput } from "../lib/parse-ffmpeg-args.js";
import { uploadLocalFiles } from "../lib/upload.js";
import { StepRenderer, waitForJob, downloadUrlToFile, fmtBytes, type MachineContext } from "../lib/progress.js";

// Schema-level cap (`inputs.images(1, MAX_REF_IMAGES)` in the API's shared job
// registry) -- true for every model. Some models cap lower (e.g. 3); that's
// left for the API to reject with a clear error rather than duplicated here.
const MAX_IMAGES = 4;

// ── Flags ──────────────────────────────────────────────────────

export interface EditFlags {
  prompt: string | null;
  images: string[];
  model: string | null;
  seed: number | null;
  output: string | null;
  json: boolean;
  quiet: boolean;
  noWait: boolean;
  urlOnly: boolean;
}

/** Everything after the `edit` subcommand name in argv. */
export function extractEditArgs(argv: string[]): string[] {
  const idx = argv.indexOf("edit");
  if (idx === -1) return [];
  return argv.slice(idx + 1);
}

export function parseEditFlags(args: string[]): EditFlags {
  const flags: EditFlags = {
    prompt: null, images: [], model: null, seed: null, output: null,
    json: false, quiet: false, noWait: false, urlOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--prompt" && i + 1 < args.length) flags.prompt = args[++i]!;
    else if (arg === "--image" && i + 1 < args.length) flags.images.push(args[++i]!);
    else if (arg === "--model" && i + 1 < args.length) flags.model = args[++i]!;
    else if (arg === "--seed" && i + 1 < args.length) flags.seed = parseIntFlag(args[++i]);
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
${pc.bold("Usage:")} rb edit --prompt <text> --image <url|path> [--image <url|path> ...] [flags]

${pc.bold("Examples:")}
  rb edit --prompt "make the sky purple" --image https://cdn.rendobar.com/uploads/a.png
  rb edit --prompt "combine these into one scene" --image ./a.png --image ./b.png
  rb edit --prompt "remove the logo" --image ./photo.jpg --output edited.webp

${pc.bold("Flags:")}
  --prompt <text>      Edit instruction (required)
  --image <url|path>   Image to edit -- repeatable, 1-${MAX_IMAGES} (required); local paths are uploaded first
  --model <id|tier>    Model id or tier alias (default: economy; economy, standard, premium)
  --seed <n>           Seed for reproducible output
  --output <path>      Also download the edited image to this local path
  --json               Output full JSON result to stdout
  --quiet              No output, exit code only
  --no-wait            Submit and exit immediately (prints job ID)
  --url-only           Print the result URL only, download nothing

${pc.dim("Always prints the edited image's URL; add --output to also save it locally.")}
${pc.dim("Full model list: see `GET /models?job=image.edit` -- not hardcoded here, it drifts.")}
`);
}

// ── Command ────────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "edit", description: "Edit one or more images from a text instruction" },
  async run() {
    const args = extractEditArgs(process.argv);
    const flags = parseEditFlags(args);

    if (args.length === 0) { showHelp(); process.exit(0); }
    if (!flags.prompt) {
      process.stderr.write(pc.red("  ✗ --prompt is required.\n"));
      process.exit(2);
    }
    const prompt = flags.prompt; // narrowed non-null by the check above
    if (flags.images.length === 0) {
      process.stderr.write(pc.red("  ✗ At least one --image is required.\n"));
      process.exit(2);
    }
    if (flags.images.length > MAX_IMAGES) {
      process.stderr.write(pc.red(`  ✗ Too many --image flags (${flags.images.length}). Max ${MAX_IMAGES}.\n`));
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
      // ── 1. Upload (local images only) ────────────────────
      const parsedImages: ParsedInput[] = flags.images.map((value, index) => ({ index, value, isLocal: isLocalPath(value) }));
      const localCount = parsedImages.filter((p) => p.isLocal).length;

      let images = flags.images;
      if (localCount > 0) {
        images = await steps.step("Uploading", async (update) => {
          const filePrefix = (index: number, count: number) => (count > 1 ? `${index + 1}/${count} ` : "");
          return uploadLocalFiles(flags.images, parsedImages, client, {
            onFileStart: (filename, size, index, count) => update(`${filePrefix(index, count)}${filename} · ${fmtBytes(size)}`),
            onFileProgress: (filename, loaded, size, index, count) => update(`${filePrefix(index, count)}${filename} · ${fmtBytes(loaded)} / ${fmtBytes(size)}`),
          });
        });
      }

      // ── 2. Submit ────────────────────────────────────────
      const params = buildGenParams({ prompt, model: flags.model, seed: flags.seed });

      const job = await steps.step("Submitting", async () => {
        return client.jobs.create(
          { type: "image.edit", params, inputs: { images } },
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
        if (!machine) steps.done("Edited", result.dispatchMs + result.queueMs + result.execMs);
        else steps.done("Edited", result.execMs, machineStr);
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

      // ── 4. Resolve output ─────────────────────────────────
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
