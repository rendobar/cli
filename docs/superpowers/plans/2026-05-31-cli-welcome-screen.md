# `rb` Welcome Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bare `rb` (and `rb --help`) print a beautiful, useful, state-aware welcome screen — brand wordmark, the user's signed-in identity, and a grouped command catalog — with zero network or side-effects on that path.

**Architecture:** A single static command registry (`registry.ts`) is the source of truth; `main.ts` derives citty's `subCommands` and the unknown-command guard from it. A tiny `theme.ts` centralizes color/TTY gating (fixing the picocolors force-color-on-win32-when-piped bug) and glyph fallback. `welcome.ts` holds pure `render*()` functions that return strings (snapshot-testable). Identity (`orgName`/`plan`, never balance) is persisted into the existing `credentials.json` as a side-effect of `login`/`whoami`, and read back synchronously.

**Tech Stack:** TypeScript, Bun + Node, citty, picocolors, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-31-cli-welcome-screen-design.md`

**Deviation from spec (intentional):** `rb help [cmd]` is handled inside `main.ts`'s root `run()` (the no-subcommand fall-through), not a separate `help.ts` command file — fewer moving parts, identical behavior. Net new files: `registry.ts`, `theme.ts`, `welcome.ts` (3, not 4).

**One-time setup before running any test:** the generated version file must exist.
Run once: `pnpm generate-version`
(Or always invoke the full suite via `pnpm test`, which regenerates it first.)

---

### Task 1: `theme.ts` — color/TTY gate, tokens, width, glyph fallback

**Files:**
- Create: `src/lib/theme.ts`
- Test: `src/__tests__/theme.test.ts`

Functions read env/argv **at call time** (not module load) so tests can vary them — the same pattern `update-check.ts` uses.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/theme.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE", "TERM", "CI", "NO_UNICODE", "WT_SESSION", "TERM_PROGRAM"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ANSI = /\x1b\[[0-9;]*m/;

describe("theme.colorEnabled precedence", () => {
  it("--no-color overrides everything", () => {
    process.env.FORCE_COLOR = "1";
    const argv = ["--no-color"];
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled(argv)).toBe(false);
  });
  it("NO_COLOR (even empty) disables", () => {
    process.env.NO_COLOR = "";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(false);
  });
  it("FORCE_COLOR enables even when not a TTY", () => {
    process.env.FORCE_COLOR = "1";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(true);
  });
  it("TERM=dumb disables", () => {
    process.env.TERM = "dumb";
    process.env.FORCE_COLOR = ""; // not forcing
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(false);
  });
});

describe("theme tokens", () => {
  it("heading emits ANSI when enabled", () => {
    process.env.FORCE_COLOR = "1";
    const { theme } = require("../lib/theme.js");
    expect(ANSI.test(theme.heading("X"))).toBe(true);
  });
  it("heading is plain when disabled", () => {
    process.env.NO_COLOR = "1";
    const { theme } = require("../lib/theme.js");
    expect(theme.heading("X")).toBe("X");
  });
});

describe("theme.stripWidth", () => {
  it("ignores ANSI escapes", () => {
    const { theme, stripWidth } = require("../lib/theme.js");
    process.env.FORCE_COLOR = "1";
    expect(stripWidth(theme.heading("hello"))).toBe(5);
  });
});

describe("theme.glyph fallback", () => {
  it("returns unicode by default on non-windows", () => {
    const { glyph } = require("../lib/theme.js");
    // On the CI/dev host (assume non-win or WT). Force unicode off to assert ASCII path:
    process.env.NO_UNICODE = "1";
    expect(glyph("check")).toBe("[ok]");
    expect(glyph("arrow")).toBe("->");
    expect(glyph("mid")).toBe("-");
    expect(glyph("warn")).toBe("!");
    expect(glyph("cross")).toBe("x");
  });
  it("returns unicode glyphs when unicode allowed", () => {
    delete process.env.NO_UNICODE;
    process.env.WT_SESSION = "1"; // force-allow even on win
    const { glyph } = require("../lib/theme.js");
    expect(glyph("check")).toBe("✓");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/theme.test.ts`
Expected: FAIL — `Cannot find module '../lib/theme.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/theme.ts
import pc from "picocolors";

// Always-on color instance; WE decide when to apply it (picocolors' own
// detection force-enables color on win32 even when piped, which we must override).
const C = pc.createColors(true);

/**
 * Total precedence (highest first):
 *   --no-color  >  NO_COLOR (present, any value)  >  FORCE_COLOR  >  CLICOLOR_FORCE=1
 *   >  (not a TTY || TERM=dumb || CI)  >  default on
 */
export function colorEnabled(argv: string[] = process.argv.slice(2)): boolean {
  if (argv.includes("--no-color")) return false;
  if ("NO_COLOR" in process.env) return false;
  if (process.env.FORCE_COLOR) return true;
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
  error: paint((s) => C.red(s)),
  warn: paint((s) => C.yellow(s)),
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
  cross: ["✗", "x"],
  arrow: ["→", "->"],
  mid: ["·", "-"],
  warn: ["⚠", "!"],
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function glyph(name: GlyphName): string {
  return unicodeAllowed() ? GLYPHS[name][0] : GLYPHS[name][1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/theme.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme.ts src/__tests__/theme.test.ts
git commit -m "feat(theme): add color/TTY gate, tokens, and glyph fallback helpers"
```

---

### Task 2: `registry.ts` — single source of truth + main.ts derivation

**Files:**
- Create: `src/registry.ts`
- Test: `src/__tests__/registry.test.ts`
- Modify: `src/main.ts` (derive `subCommands` and the guard `Set` from the registry)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/registry.test.ts
import { describe, it, expect } from "bun:test";
import { COMMANDS, GROUP_ORDER, commandNames, toSubCommands } from "../registry.js";

describe("registry", () => {
  it("lists the six commands", () => {
    expect(commandNames().sort()).toEqual(["doctor", "ffmpeg", "login", "logout", "update", "whoami"]);
  });
  it("every command's group is in GROUP_ORDER", () => {
    for (const c of COMMANDS) expect(GROUP_ORDER).toContain(c.group);
  });
  it("command names are unique", () => {
    const names = commandNames();
    expect(new Set(names).size).toBe(names.length);
  });
  it("toSubCommands yields one lazy loader per command", () => {
    const subs = toSubCommands();
    expect(Object.keys(subs).sort()).toEqual(commandNames().sort());
    for (const v of Object.values(subs)) expect(typeof v).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/registry.test.ts`
Expected: FAIL — `Cannot find module '../registry.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/registry.ts
import type { CommandDef } from "citty";

export type Group = "CORE" | "ACCOUNT" | "SYSTEM";

export interface CommandEntry {
  name: string;
  summary: string; // short catalog blurb for the welcome screen
  group: Group;
  load: () => Promise<{ default: CommandDef }>;
}

export const COMMANDS: readonly CommandEntry[] = [
  { name: "ffmpeg", summary: "Run ffmpeg in the cloud",            group: "CORE",    load: () => import("./commands/ffmpeg.js") },
  { name: "login",  summary: "Authenticate this machine",          group: "ACCOUNT", load: () => import("./commands/login.js") },
  { name: "logout", summary: "Remove stored credentials",          group: "ACCOUNT", load: () => import("./commands/logout.js") },
  { name: "whoami", summary: "Show identity, plan, and balance",   group: "ACCOUNT", load: () => import("./commands/whoami.js") },
  { name: "update", summary: "Self-update to the latest version",  group: "SYSTEM",  load: () => import("./commands/update.js") },
  { name: "doctor", summary: "Diagnose environment + auth",        group: "SYSTEM",  load: () => import("./commands/doctor.js") },
] as const;

export const GROUP_ORDER: readonly Group[] = ["CORE", "ACCOUNT", "SYSTEM"] as const;

export function commandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

export function toSubCommands(): Record<string, () => Promise<CommandDef>> {
  return Object.fromEntries(COMMANDS.map((c) => [c.name, () => c.load().then((m) => m.default)]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the registry into `main.ts` (replace the hardcoded subCommands + Set)**

In `src/main.ts`, add the import near the top:

```ts
import { toSubCommands, commandNames } from "./registry.js";
```

Replace the `subCommands: { ... }` object literal with:

```ts
  subCommands: toSubCommands(),
```

In `run()`, replace the hardcoded `const subCommands = new Set([...])` line with:

```ts
    const subCommands = new Set(commandNames());
```

(Leave the rest of `run()` unchanged for now — it is rebuilt in Task 5.)

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm typecheck && bun test`
Expected: PASS, no type errors. Manually: `bun run src/main.ts whoami` still routes to the whoami command (prints "Not authenticated" if logged out).

- [ ] **Step 7: Commit**

```bash
git add src/registry.ts src/__tests__/registry.test.ts src/main.ts
git commit -m "feat(registry): single source of truth for commands; derive subCommands"
```

---

### Task 3: `auth.ts` — persist + read stored identity

**Files:**
- Modify: `src/lib/auth.ts` (extend `OAuthSaveData`, `saveOAuthCredentials`, `saveApiKey`; add `readStoredIdentity`)
- Test: `src/__tests__/identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/identity.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rb-id-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readStoredIdentity", () => {
  it("returns null when no credentials file exists", async () => {
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("returns null when file has no identity field", async () => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiKey: "rb_x" }));
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("returns null on corrupt JSON", async () => {
    writeFileSync(join(dir, "credentials.json"), "{not json");
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("reads identity written by saveApiKey", async () => {
    const { saveApiKey, readStoredIdentity } = await import("../lib/auth.js");
    await saveApiKey("rb_test", dir, { orgName: "Acme Inc", plan: "Pro" });
    expect(readStoredIdentity(dir)).toEqual({ orgName: "Acme Inc", plan: "Pro" });
  });
  it("reads identity written by saveOAuthCredentials", async () => {
    const { saveOAuthCredentials, readStoredIdentity } = await import("../lib/auth.js");
    await saveOAuthCredentials(
      { accessToken: "tok", expiresAt: Date.now() + 1000, identity: { orgName: "Beta LLC", plan: "Free" } },
      dir,
    );
    expect(readStoredIdentity(dir)).toEqual({ orgName: "Beta LLC", plan: "Free" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/identity.test.ts`
Expected: FAIL — `readStoredIdentity` is not exported / `saveApiKey` does not accept a 3rd argument.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/auth.ts`:

(a) Add an exported identity type and extend `OAuthSaveData`. Find the `interface OAuthSaveData` block and add the optional field:

```ts
export interface StoredIdentity {
  orgName: string;
  plan: string;
}

interface OAuthSaveData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  identity?: StoredIdentity;
}
```

(b) In `saveOAuthCredentials`, include identity in the written JSON. Change the `JSON.stringify({...})` object to:

```ts
  const json = JSON.stringify(
    {
      type: "oauth",
      accessToken: data.accessToken,
      ...(data.refreshToken ? { refreshToken: data.refreshToken } : {}),
      expiresAt: data.expiresAt,
      ...(data.identity ? { identity: data.identity } : {}),
    },
    null,
    2,
  );
```

(c) Change the `saveApiKey` signature and body to accept identity:

```ts
export async function saveApiKey(apiKey: string, configDir?: string, identity?: StoredIdentity): Promise<void> {
  const dir = configDir ?? getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = `${dir}/${CREDENTIALS_FILE}`;
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify({ apiKey, ...(identity ? { identity } : {}) }, null, 2));
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
}
```

(d) Add `readStoredIdentity` near `resolveAuth` (defensive — never throws):

```ts
export function readStoredIdentity(configDir?: string): StoredIdentity | null {
  try {
    const dir = configDir ?? getConfigDir();
    const content = fs.readFileSync(`${dir}/${CREDENTIALS_FILE}`, "utf8");
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object") return null;
    const id = (raw as Record<string, unknown>).identity;
    if (!id || typeof id !== "object") return null;
    const { orgName, plan } = id as Record<string, unknown>;
    if (typeof orgName === "string" && typeof plan === "string") return { orgName, plan };
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify existing auth tests still pass**

Run: `bun test src/__tests__/auth.test.ts && pnpm typecheck`
Expected: PASS (changes are additive-optional).

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/__tests__/identity.test.ts
git commit -m "feat(auth): persist and read optional stored identity in credentials.json"
```

---

### Task 4: `welcome.ts` — pure render functions

**Files:**
- Create: `src/lib/welcome.ts`
- Test: `src/__tests__/welcome.test.ts`

This task builds only the **pure** renderers + the `WelcomeState` type and a `buildState()` reader. Printing/wiring is Task 5.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/welcome.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { WelcomeState } from "../lib/welcome.js";

// Render plain (no ANSI) for stable assertions.
beforeEach(() => { process.env.NO_COLOR = "1"; process.env.NO_UNICODE = "1"; });
afterEach(() => { delete process.env.NO_COLOR; delete process.env.NO_UNICODE; });

const base: WelcomeState = {
  version: "1.0.1",
  credential: null,
  identity: null,
  hideIdentity: false,
  update: null,
};

describe("renderWelcome", () => {
  it("logged out: shows the sign-in CTA", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome(base);
    expect(out).toContain("Not signed in");
    expect(out).toContain("rb login");
  });
  it("always shows wordmark, version, command groups and the example", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome(base);
    expect(out).toContain("Rendobar");
    expect(out).toContain("1.0.1");
    expect(out).toContain("CORE");
    expect(out).toContain("ACCOUNT");
    expect(out).toContain("SYSTEM");
    expect(out).toContain("ffmpeg");
    expect(out).toContain("rb ffmpeg -i");
    expect(out).toContain("rendobar.com/docs");
  });
  it("file creds with identity: shows org and plan", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: { orgName: "Acme Inc", plan: "Pro" } });
    expect(out).toContain("Acme Inc");
    expect(out).toContain("Pro");
    expect(out).toContain("rb whoami");
    expect(out).not.toContain("Not signed in");
  });
  it("file creds without identity: generic signed-in", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: null });
    expect(out).toContain("Signed in");
    expect(out).toContain("rb whoami");
  });
  it("env credential: signed in via API key", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "env" });
    expect(out).toContain("API key");
  });
  it("RB_NO_IDENTITY: hides org name even when identity present", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: { orgName: "Secret Org", plan: "Pro" }, hideIdentity: true });
    expect(out).not.toContain("Secret Org");
    expect(out).toContain("Signed in");
  });
  it("appends the pending-update line when present", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, update: "Update available: 1.0.1 -> 1.1.0  Run `rb update` to upgrade" });
    expect(out).toContain("Update available");
  });
});

describe("renderHelp", () => {
  it("includes everything in the welcome plus the root-flag reference", async () => {
    const { renderHelp } = await import("../lib/welcome.js");
    const out = renderHelp(base);
    expect(out).toContain("CORE");
    expect(out).toContain("--json");
    expect(out).toContain("--quiet");
    expect(out).toContain("--no-color");
  });
});

describe("renderWelcomeJson", () => {
  it("emits version, authenticated flag, and command list", async () => {
    const { renderWelcomeJson } = await import("../lib/welcome.js");
    const obj = JSON.parse(renderWelcomeJson({ ...base, credential: "file" }));
    expect(obj.version).toBe("1.0.1");
    expect(obj.authenticated).toBe(true);
    expect(Array.isArray(obj.commands)).toBe(true);
    expect(obj.commands.find((c: { name: string }) => c.name === "ffmpeg")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/welcome.test.ts`
Expected: FAIL — `Cannot find module '../lib/welcome.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/welcome.ts
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

  // Env API key takes precedence in resolveAuth and has no file-backed identity.
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
  const whoamiHint = theme.dim(`run \`rb whoami\` for balance`);
  if (s.credential === null) {
    return `${theme.accent(glyph("arrow"))} ${theme.accent("Not signed in.")} Run ${theme.cmd("rb login")} to get started.`;
  }
  if (s.credential === "env") {
    return `${theme.accent(glyph("check"))} Signed in via API key   ${theme.dim(glyph("mid"))}   ${theme.dim("run `rb whoami`")}`;
  }
  // file credential
  if (!s.hideIdentity && s.identity) {
    return `${theme.heading(s.identity.orgName)}${mid}${s.identity.plan}   ${theme.dim(glyph("mid"))}   ${whoamiHint}`;
  }
  return `${theme.accent(glyph("check"))} Signed in   ${theme.dim(glyph("mid"))}   ${theme.dim("run `rb whoami`")}`;
}

function commandSection(): string {
  const lines: string[] = [];
  // Align command names across all groups for a clean column.
  const nameWidth = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const group of GROUP_ORDER) {
    const items = COMMANDS.filter((c) => c.group === group);
    if (items.length === 0) continue;
    lines.push(theme.heading(group));
    for (const c of items) {
      const pad = " ".repeat(nameWidth - c.name.length);
      lines.push(`  ${theme.cmd(c.name)}${pad}   ${theme.dim(c.summary)}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function header(s: WelcomeState): string {
  const wordmark = `${theme.accent("rb")} ${glyph("mid")} ${theme.heading("Rendobar")}`;
  const version = theme.dim(`v${s.version}`);
  const tagline = theme.dim("Cloud FFmpeg & video processing from your terminal");
  // Right-align version only when the terminal is wide enough; otherwise inline.
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
    theme.heading("USAGE"),
    `  ${theme.cmd("rb")} <command> [flags]`,
    "",
    commandSection(),
    "",
    theme.heading("EXAMPLE"),
    `  ${theme.dim(HERO_EXAMPLE)}`,
    "",
    theme.dim(`Run \`rb <command> --help\` for details ${glyph("mid")} Docs ${DOCS_URL}`),
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
    ([f, d]) => `  ${theme.cmd(f)}${" ".repeat(flagWidth - f.length)}   ${theme.dim(d)}`,
  );
  return `${renderWelcome(s)}\n\n${theme.heading("FLAGS")}\n${flagLines.join("\n")}`;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/welcome.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/welcome.ts src/__tests__/welcome.test.ts
git commit -m "feat(welcome): pure render functions for the welcome/help/json screens"
```

---

### Task 5: Wire into `main.ts` — bare/help/json/quiet/unknown + showUsage + EPIPE

**Files:**
- Modify: `src/main.ts`
- Test: `src/__tests__/main-welcome.test.ts` (spawn-based smoke tests)

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/main-welcome.test.ts
import { describe, it, expect } from "bun:test";

// Run the CLI in a child process with a clean env (logged out, no color/unicode).
async function runRb(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1", NO_UNICODE: "1", RB_NO_UPDATE_CHECK: "1", RENDOBAR_API_KEY: "", HOME: process.env.HOME ?? "", APPDATA: process.env.APPDATA ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("rb welcome wiring", () => {
  it("bare `rb` prints the welcome to stdout, exit 0", async () => {
    const { code, stdout } = await runRb([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rendobar");
    expect(stdout).toContain("CORE");
  }, 20000);

  it("`rb --help` prints welcome + FLAGS, exit 0", async () => {
    const { code, stdout } = await runRb(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("FLAGS");
    expect(stdout).toContain("--json");
  }, 20000);

  it("`rb --json` emits JSON with a commands array, exit 0", async () => {
    const { code, stdout } = await runRb(["--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout);
    expect(Array.isArray(obj.commands)).toBe(true);
  }, 20000);

  it("`rb --quiet` prints nothing, exit 0", async () => {
    const { code, stdout } = await runRb(["--quiet"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, 20000);

  it("unknown command errors to stderr, exit 2", async () => {
    const { code, stderr } = await runRb(["bogus"]);
    expect(code).toBe(2);
    expect(stderr.toLowerCase()).toContain("unknown command");
  }, 20000);

  it("`rb help` prints the welcome, exit 0", async () => {
    const { code, stdout } = await runRb(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rendobar");
  }, 20000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/main-welcome.test.ts`
Expected: FAIL — bare `rb` prints nothing / unknown command does not exit 2.

- [ ] **Step 3: Rewrite `src/main.ts`**

Replace the entire file with:

```ts
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
  subCommands: toSubCommands(),
  async run() {
    const raw = process.argv.slice(2);
    const names = new Set(commandNames());

    // A known subcommand is present — citty will dispatch it; do nothing here.
    if (raw.some((a) => names.has(a))) return;

    // `rb help [cmd]` alias.
    if (raw[0] === "help") {
      const target = raw[1];
      const entry = target ? COMMANDS.find((c) => c.name === target) : undefined;
      if (entry) {
        const sub: CommandDef = await entry.load().then((m) => m.default);
        process.stdout.write((await renderUsage(sub, main)) + "\n");
      } else {
        process.stdout.write(renderHelp(buildState()) + "\n");
      }
      return;
    }

    const hasFlag = (f: string) => raw.includes(f);

    // Stray ffmpeg flags without the subcommand.
    if (raw.some((a) => FFMPEG_FLAGS.includes(a))) {
      process.stderr.write(`Did you mean: rb ffmpeg ${raw.join(" ")}?\n`);
      process.exit(2);
    }

    // Bare invocation (only global flags, or nothing).
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/main-welcome.test.ts`
Expected: PASS (all six cases).

> If `showUsage`'s parameter order differs in the installed citty version, inspect
> `node_modules/citty/dist/index.mjs` for the `showUsage` call site in `runMain` and
> match it; the root case is the one where the second arg (parent) is undefined.

- [ ] **Step 5: Full regression + types**

Run: `pnpm typecheck && bun test`
Expected: PASS. Manually confirm a subcommand still works: `bun run src/main.ts whoami` and `bun run src/main.ts ffmpeg --help`.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/__tests__/main-welcome.test.ts
git commit -m "feat(cli): render welcome on bare rb/--help; help alias; unknown-command + EPIPE handling"
```

---

### Task 6: Persist identity from `login` and `whoami`

**Files:**
- Modify: `src/commands/login.ts` (both the `--key` path and the OAuth path)
- Modify: `src/commands/whoami.ts`

No new test file — covered by `identity.test.ts` (write path) and exercised end-to-end manually. These are small call-site edits.

- [ ] **Step 1: Update `login.ts` — `--key` path**

Find the `--key` block where it calls `await saveApiKey(apiKey);` (just after `const state = await client.orgs.current();`). Replace that call with:

```ts
        await saveApiKey(apiKey, undefined, { orgName: state.org.name, plan: state.plan.name });
```

- [ ] **Step 2: Update `login.ts` — OAuth path**

In the OAuth path, after the token exchange the code calls
`await saveOAuthCredentials({ accessToken, refreshToken, expiresAt: ... });` **before**
fetching org info. Move the identity into the save by fetching org info first, then
saving once. Replace the existing `saveOAuthCredentials(...)` call and the subsequent
verify block with:

```ts
    // Verify by fetching org info, then persist credentials + identity together.
    let identity: { orgName: string; plan: string } | undefined;
    try {
      const client = createClient({ accessToken, baseUrl });
      const orgState = await client.orgs.current();
      identity = { orgName: orgState.org.name, plan: orgState.plan.name };
      process.stderr.write(`  ${pc.green("✓")} Signed in | ${pc.bold(orgState.org.name)} | ${orgState.plan.name} plan\n`);
    } catch {
      process.stderr.write(`  ${pc.green("✓")} Signed in, but couldn't verify org. Run ${pc.bold("rb whoami")} to check.\n`);
    }

    await saveOAuthCredentials(
      { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, identity },
      undefined,
    );

    process.stderr.write(`  ${pc.dim(`Saved to ${getConfigDir()}/credentials.json`)}\n`);
```

Remove the now-duplicated earlier `await saveOAuthCredentials({ accessToken, refreshToken, expiresAt: ... });` call and the old verify block so credentials are saved exactly once (with identity).

- [ ] **Step 3: Update `whoami.ts` — refresh stored identity on each lookup**

In `whoami.ts`, after `const state = await client.orgs.current();` and the existing
`process.stderr.write(...)` lines, persist the freshest identity. Add the import at the
top:

```ts
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, saveApiKey, saveOAuthCredentials, readStoredIdentity } from "../lib/auth.js";
```

Then, after printing org/plan/balance, add:

```ts
      // Refresh the welcome-screen identity cache (best-effort; never block whoami).
      try {
        const identity = { orgName: state.org.name, plan: state.plan.name };
        if (cred.type === "apikey") {
          await saveApiKey(cred.apiKey, undefined, identity);
        } else {
          await saveOAuthCredentials(
            { accessToken: cred.accessToken, refreshToken: cred.refreshToken, expiresAt: cred.expiresAt, identity },
            undefined,
          );
        }
      } catch { /* identity cache is best-effort */ }
```

> Note: for an env-var API key (`RENDOBAR_API_KEY`), `saveApiKey` writes a
> `credentials.json`. That's acceptable — `whoami` is an explicit user action, and the
> welcome screen prefers the env credential's generic line regardless. If you prefer not
> to write a file for env keys, guard with `if (!process.env.RENDOBAR_API_KEY)` — note
> the choice in the PR. (`readStoredIdentity` import is used by the welcome path, not
> here; keep it only if linting flags the unused import — otherwise remove it from this edit.)

- [ ] **Step 4: Run tests + types**

Run: `pnpm typecheck && bun test`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end (if you have credentials)**

```bash
bun run src/main.ts login --key rb_yourtestkey   # writes identity
bun run src/main.ts                               # welcome shows "Org · Plan"
bun run src/main.ts logout                        # clears credentials.json
bun run src/main.ts                               # welcome shows "Not signed in"
```

- [ ] **Step 6: Commit**

```bash
git add src/commands/login.ts src/commands/whoami.ts
git commit -m "feat(auth): cache org/plan identity on login and whoami for the welcome screen"
```

---

### Task 7: Docs note + final verification

**Files:**
- Modify: `CLAUDE.md` and/or `AGENTS.md` (maintenance note)
- Modify: `README.md` (mention the welcome screen, optional)

- [ ] **Step 1: Add the maintenance note**

In `AGENTS.md` (and `CLAUDE.md` if it has a "for agents" section), add under a commands/architecture section:

```markdown
## Adding a subcommand

Add one entry to `COMMANDS` in `src/registry.ts`. That single edit drives:
citty subcommand registration, the unknown-command guard, and the `rb` welcome-screen
catalog. Then update `README.md` and the docs site separately.
```

- [ ] **Step 2: Full suite + typecheck + build**

```bash
pnpm test
pnpm typecheck
pnpm build
```
Expected: all green; `rb` binary builds.

- [ ] **Step 3: Manual verification matrix (record results in the PR description)**

Run each and confirm:

```bash
./rb                      # welcome, exit 0
./rb --help               # welcome + FLAGS, exit 0
./rb --version            # version only (citty), exit 0
./rb --json               # JSON, exit 0
./rb --quiet              # nothing, exit 0
./rb help                 # welcome, exit 0
./rb help ffmpeg          # ffmpeg usage, exit 0
./rb bogus                # "unknown command", stderr, exit 2
./rb | cat                # NO ANSI codes (piped → plain)
./rb | head -1            # no EPIPE crash, exit 0
NO_COLOR=1 ./rb           # plain text
```

On **Windows legacy conhost** (cmd.exe, not Windows Terminal): confirm glyphs degrade to
ASCII (`[ok]`, `->`, `-`, `!`) and nothing renders as tofu. Note the result in the PR
(this and screen-reader output are the only manual-only checks).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CLAUDE.md README.md
git commit -m "docs: note the command registry as single source of truth for subcommands"
```

---

## Self-Review (completed during authoring)

**Spec coverage:** registry SoT (Task 2), theme/color-precedence/glyphs (Task 1), identity persistence no-balance (Task 3, 6), pure renderers + state matrix + JSON + help (Task 4), bare/help/json/quiet/unknown/showUsage/EPIPE (Task 5), `rb help` alias (Task 5, folded — documented deviation), docs/maintenance note + manual conhost/screen-reader checks (Task 7). No network/side-effects on welcome path (Task 4 `buildState` only reads). `RB_NO_IDENTITY` (Task 4). No-telemetry is a non-goal (nothing added). All spec sections map to a task.

**Placeholder scan:** none — every code step carries full code; every run step carries an exact command + expected result.

**Type consistency:** `StoredIdentity {orgName, plan}` defined in Task 3 and used identically in Tasks 4 & 6. `WelcomeState` defined in Task 4 and consumed in Task 5. `toSubCommands`/`commandNames`/`COMMANDS` defined in Task 2 and used in Tasks 4 & 5. `theme`/`stripWidth`/`glyph` defined in Task 1 and used in Task 4.
