/**
 * CLI entry point. Defines the root `rendobar` / `rb` command with
 * subcommands: ffmpeg, login, whoami.
 *
 * If invoked with no subcommand but with FFmpeg-like flags, hints at
 * the correct usage: `rb ffmpeg ...`
 */
import { defineCommand, runMain } from "citty";
import { VERSION } from "./generated/version.js";

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
    // --timeout is parsed manually in ffmpeg.ts (citty can't handle --flag value before subcommand)
  },
  subCommands: {
    ffmpeg: () => import("./commands/ffmpeg.js").then((m) => m.default),
    login: () => import("./commands/login.js").then((m) => m.default),
    logout: () => import("./commands/logout.js").then((m) => m.default),
    whoami: () => import("./commands/whoami.js").then((m) => m.default),
    update: () => import("./commands/update.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
  },
  run() {
    const raw = process.argv.slice(2);
    const subCommands = new Set(["ffmpeg", "login", "logout", "whoami", "update", "doctor"]);
    if (raw.some((a) => subCommands.has(a))) return;

    const ffmpegFlags = ["-i", "-vf", "-c:v", "-c:a", "-f", "-filter_complex"];
    if (raw.some((a) => ffmpegFlags.includes(a))) {
      console.error(`Did you mean: rb ffmpeg ${raw.join(" ")}?`);
      process.exit(2);
    }
  },
});

runMain(main);
