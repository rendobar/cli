/**
 * CLI entry point. Defines the root `rendobar` / `rb` command.
 *
 * Bare `rb` and `rb --help` render the welcome screen. Subcommands are derived
 * from the central registry. Unknown commands and stray ffmpeg flags are hinted.
 */
import { defineCommand, runMain, renderUsage, type CommandDef } from "citty";
import { VERSION } from "./generated/version.js";
import { toSubCommands, commandNames, COMMANDS } from "./registry.js";
import { buildState, renderWelcome, renderHelp, renderWelcomeJson } from "./lib/welcome.js";

// Never crash with an EPIPE stack trace when piped into a closed reader (`rb | head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});

const FFMPEG_FLAGS = ["-i", "-vf", "-c:v", "-c:a", "-f", "-filter_complex"];

// A minimal parent stub passed to renderUsage so subcommand usage lines are
// prefixed with the root command name. Only meta is used by renderUsage — no
// args/run callbacks needed, so the generic stays compatible with any CommandDef<T>.
const ROOT_META_STUB: CommandDef = {
  meta: { name: "rendobar", version: VERSION, description: "Cloud FFmpeg -- run ffmpeg in the cloud" },
};

// `rb help [cmd]` — alias subcommand so citty doesn't treat it as unknown.
const helpCommand = defineCommand({
  meta: { name: "help", description: "Show help" },
  args: {
    command: { type: "positional", description: "Command to show help for", required: false },
  },
  async run({ args }) {
    const target = typeof args.command === "string" ? args.command : undefined;
    const entry = target ? COMMANDS.find((c) => c.name === target) : undefined;
    if (entry) {
      const sub: CommandDef = await entry.load().then((m) => m.default);
      process.stdout.write((await renderUsage(sub, ROOT_META_STUB)) + "\n");
    } else {
      process.stdout.write(renderHelp(buildState()) + "\n");
    }
  },
});

const main = defineCommand({
  meta: {
    name: "rendobar",
    version: VERSION,
    description: "Cloud FFmpeg -- run ffmpeg in the cloud",
  },
  args: {
    json: { type: "boolean", description: "Output full JSON result", default: false },
    "url-only": { type: "boolean", description: "Output only the result URL", default: false },
    quiet: { type: "boolean", description: "No output, exit code only", default: false },
    "no-wait": { type: "boolean", description: "Submit and exit immediately", default: false },
  },
  subCommands: {
    ...toSubCommands(),
    help: helpCommand,
  },
  async run() {
    const raw = process.argv.slice(2);

    // A known subcommand is present — citty dispatched it; do nothing here.
    // (`knownNames` is the module-level set built once below.)
    if (raw.some((a) => knownNames.has(a))) return;

    const hasFlag = (f: string) => raw.includes(f);

    // Bare invocation (only global flags, or nothing).
    // Note: stray ffmpeg-flag classification (e.g. `rb -i in.mp4 out.mp4`)
    // is handled in the module-load pre-validation block above; run() is
    // only reached for cases that passed pre-validation.
    const onlyFlags = raw.every((a) => a.startsWith("-"));
    if (onlyFlags) {
      if (hasFlag("--quiet") || hasFlag("--url-only")) return; // silent, exit 0
      if (hasFlag("--json")) {
        process.stdout.write(renderWelcomeJson(buildState()) + "\n");
        return;
      }
      process.stdout.write(renderWelcome(buildState()) + "\n");
      return;
    }

    // Anything else is an unknown command.
    process.stderr.write(`unknown command '${raw[0]}' -- run \`rb\` to see commands\n`);
    process.exit(2);
  },
});

// Pre-validate: intercept unknown commands before citty throws with exit 1.
// citty dispatches to run() only when args parse cleanly, but it throws
// CLIError("Unknown command") before run() for unrecognised positional args.
// We catch those here so we can exit 2 instead of 1.
const rawArgs = process.argv.slice(2);
const knownNames = new Set([...commandNames(), "help"]);

// Check for --help / --version / -h — citty owns these, don't intercept.
const isCittyOwned =
  rawArgs.includes("--help") ||
  rawArgs.includes("-h") ||
  (rawArgs.length === 1 && rawArgs[0] === "--version");

if (!isCittyOwned) {
  const firstPositional = rawArgs.find((a) => !a.startsWith("-"));
  if (firstPositional !== undefined && !knownNames.has(firstPositional)) {
    // Unknown first positional — but first check if any arg looks like an
    // ffmpeg flag (e.g. `rb -i in.mp4 out.mp4` or `rb -vf scale=1:1`).
    // The check must run even when the first positional isn't itself a flag,
    // because the flag may appear after file arguments.
    if (rawArgs.some((a) => FFMPEG_FLAGS.includes(a))) {
      process.stderr.write(`Did you mean: rb ffmpeg ${rawArgs.join(" ")}?\n`);
      process.exit(2);
    }
    process.stderr.write(`unknown command '${firstPositional}' -- run \`rb\` to see commands\n`);
    process.exit(2);
  }
}

runMain(main, {
  async showUsage(cmd, parent) {
    // Root help (`rb --help` / `rb -h`) → our welcome+flags screen.
    if (!parent) {
      process.stdout.write(renderHelp(buildState()) + "\n");
      return;
    }
    // Subcommand help (`rb ffmpeg --help`) → citty's default usage.
    process.stdout.write((await renderUsage(cmd, parent)) + "\n");
  },
});
