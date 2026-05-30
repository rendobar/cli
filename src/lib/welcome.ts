import { theme, stripWidth, glyph } from "./theme.js";
import { COMMANDS, GROUP_ORDER } from "../registry.js";
import { resolveAuth, readStoredIdentity, type StoredIdentity } from "./auth.js";
import { getPendingNotification } from "./update-check.js";
import { VERSION } from "../generated/version.js";

const DOCS_URL = "https://rendobar.com/docs";
const HERO_EXAMPLE = "rb ffmpeg -i in.mp4 -vf scale=1280:-1 out.mp4";

export interface WelcomeState {
  version: string;
  credential: "file" | "env" | null;
  identity: StoredIdentity | null;
  hideIdentity: boolean;
  update: string | null;
}

/** Assemble state from sync, no-network sources. Never throws. */
export function buildState(): WelcomeState {
  const version = VERSION;
  const hideIdentity = Boolean(process.env.RB_NO_IDENTITY);
  let update: string | null = null;
  try { update = getPendingNotification(version); } catch { update = null; }

  if (process.env.RENDOBAR_API_KEY) {
    return { version, credential: "env", identity: null, hideIdentity, update };
  }
  let signedIn = false;
  try { signedIn = resolveAuth() !== null; } catch { signedIn = false; }
  if (!signedIn) {
    return { version, credential: null, identity: null, hideIdentity, update };
  }
  let identity: StoredIdentity | null = null;
  try { identity = readStoredIdentity(); } catch { identity = null; }
  return { version, credential: "file", identity, hideIdentity, update };
}

function identityLine(s: WelcomeState): string {
  const mid = ` ${glyph("mid")} `;
  const whoamiHint = theme.dim("run `rb whoami` for balance");
  if (s.credential === null) {
    return `${theme.accent(glyph("arrow"))} ${theme.accent("Not signed in.")} Run ${theme.cmd("rb login")} to get started.`;
  }
  if (s.credential === "env") {
    return `${theme.accent(glyph("check"))} Signed in via API key   ${theme.dim(glyph("mid"))}   ${theme.dim("run `rb whoami`")}`;
  }
  if (!s.hideIdentity && s.identity) {
    return `${theme.heading(s.identity.orgName)}${mid}${s.identity.plan}   ${theme.dim(glyph("mid"))}   ${whoamiHint}`;
  }
  return `${theme.accent(glyph("check"))} Signed in   ${theme.dim(glyph("mid"))}   ${theme.dim("run `rb whoami`")}`;
}

function commandSection(): string {
  const lines: string[] = [];
  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const group of GROUP_ORDER) {
    const items = COMMANDS.filter((c) => c.group === group);
    if (items.length === 0) continue;
    lines.push(`  ${theme.heading(group)}`);
    for (const c of items) {
      const pad = " ".repeat(nameWidth - c.name.length);
      lines.push(`    ${theme.cmd(c.name)}${pad}   ${theme.dim(c.summary)}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function header(s: WelcomeState): string {
  const wordmark = `${theme.accent("rb")} ${glyph("mid")} ${theme.heading("Rendobar")}`;
  const version = theme.dim(`v${s.version}`);
  const tagline = theme.dim("Cloud FFmpeg & video processing from your terminal");
  const cols = (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80;
  const left = `  ${wordmark}`;
  const gap = cols - stripWidth(left) - stripWidth(version) - 2;
  const line = gap > 2 ? `${left}${" ".repeat(gap)}${version}` : `${left}  ${version}`;
  return `${line}\n  ${tagline}`;
}

export function renderWelcome(s: WelcomeState): string {
  const parts = [
    header(s),
    "",
    `  ${identityLine(s)}`,
    "",
    `  ${theme.heading("USAGE")}`,
    `    ${theme.cmd("rb")} <command> [flags]`,
    "",
    commandSection(),
    "",
    `  ${theme.heading("EXAMPLE")}`,
    `    ${theme.dim(HERO_EXAMPLE)}`,
    "",
    `  ${theme.dim(`Run \`rb <command> --help\` for details ${glyph("mid")} Docs ${DOCS_URL}`)}`,
  ];
  let out = parts.join("\n");
  if (s.update) out += `\n\n  ${theme.dim(s.update)}`;
  return out;
}

const ROOT_FLAGS: ReadonlyArray<[string, string]> = [
  ["--json", "Output machine-readable JSON"],
  ["--url-only", "Output only the result URL"],
  ["--quiet", "Suppress output (exit code only)"],
  ["--no-wait", "Submit and exit immediately"],
  ["--no-color", "Disable colored output"],
];

export function renderHelp(s: WelcomeState): string {
  const flagWidth = Math.max(...ROOT_FLAGS.map(([f]) => f.length));
  const flagLines = ROOT_FLAGS.map(
    ([f, d]) => `    ${theme.cmd(f)}${" ".repeat(flagWidth - f.length)}   ${theme.dim(d)}`,
  );
  return `${renderWelcome(s)}\n\n  ${theme.heading("FLAGS")}\n${flagLines.join("\n")}`;
}

export function renderWelcomeJson(s: WelcomeState): string {
  return JSON.stringify(
    {
      version: s.version,
      authenticated: s.credential !== null,
      commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, group: c.group })),
    },
    null,
    2,
  );
}
