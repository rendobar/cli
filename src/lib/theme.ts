import pc from "picocolors";

// Always-on color instance; WE decide when to apply it (picocolors' own detection
// force-enables color on win32 even when piped, which we must override).
const C = pc.createColors(true);

/**
 * Total precedence (highest first):
 *   --no-color > NO_COLOR (present, any value) > FORCE_COLOR > CLICOLOR_FORCE=1
 *   > (not a TTY || TERM=dumb || CI) > default on
 */
export function colorEnabled(argv: string[] = process.argv.slice(2)): boolean {
  if (argv.includes("--no-color")) return false;
  if ("NO_COLOR" in process.env) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0" && process.env.FORCE_COLOR !== "") return true;
  if (process.env.CLICOLOR_FORCE === "1") return true;
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.CI) return false;
  return true;
}

const paint = (f: (s: string) => string) => (s: string) => (colorEnabled() ? f(s) : s);

export const theme = {
  heading: paint((s) => C.bold(s)),
  cmd: paint((s) => C.cyan(s)),
  accent: paint((s) => C.bold(C.blue(s))),
  dim: paint((s) => C.dim(s)),
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function unicodeAllowed(): boolean {
  if (process.env.NO_UNICODE) return false;
  if (process.platform !== "win32") return true;
  // Legacy conhost mangles box/emoji glyphs; modern terminals are fine.
  return Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === "vscode";
}

const GLYPHS = {
  check: ["✓", "[ok]"],
  arrow: ["→", "->"],
  mid: ["·", "-"],
} as const;

type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName): string {
  return unicodeAllowed() ? GLYPHS[name][0] : GLYPHS[name][1];
}
