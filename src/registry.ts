import type { CommandDef, SubCommandsDef } from "citty";

export type Group = "CORE" | "ACCOUNT" | "SYSTEM";

export interface CommandEntry {
  name: string;
  summary: string;
  group: Group;
  // CommandDef<any> matches SubCommandsDef's Resolvable<CommandDef<any>> contract
  load: () => Promise<{ default: CommandDef<any> }>;
}

export const COMMANDS: readonly CommandEntry[] = [
  { name: "ffmpeg",  summary: "Run ffmpeg in the cloud",           group: "CORE",    load: () => import("./commands/ffmpeg.js") },
  { name: "ffprobe", summary: "Run a raw ffprobe command",          group: "CORE",    load: () => import("./commands/ffprobe.js") },
  { name: "login",   summary: "Authenticate this machine",         group: "ACCOUNT", load: () => import("./commands/login.js") },
  { name: "logout",  summary: "Remove stored credentials",         group: "ACCOUNT", load: () => import("./commands/logout.js") },
  { name: "whoami",  summary: "Show identity, plan, and balance",  group: "ACCOUNT", load: () => import("./commands/whoami.js") },
  { name: "update",  summary: "Self-update to the latest version", group: "SYSTEM",  load: () => import("./commands/update.js") },
  { name: "doctor",  summary: "Diagnose environment + auth",       group: "SYSTEM",  load: () => import("./commands/doctor.js") },
  { name: "telemetry", summary: "Control anonymous usage telemetry", group: "SYSTEM", load: () => import("./commands/telemetry.js") },
];

export const GROUP_ORDER: readonly Group[] = ["CORE", "ACCOUNT", "SYSTEM"];

export function commandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

export function toSubCommands(): SubCommandsDef {
  return Object.fromEntries(COMMANDS.map((c) => [c.name, () => c.load().then((m) => m.default)]));
}
