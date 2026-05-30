# `rb` Welcome Screen — Design Spec

**Date:** 2026-05-31
**Repo:** `github.com/rendobar/cli`
**Status:** Approved design, ready for implementation plan.

## Problem

Typing `rb` with no arguments currently does nothing useful — citty falls through to a
bare default usage. We want bare `rb` (and `rb --help`) to show a beautiful, useful
welcome screen: brand identity, the user's current state, and what `rb` can do.

## Goals

- Bare `rb` and `rb --help` render an oriented, scannable welcome screen.
- Show *what `rb` can do* (grouped command catalog + one hero example).
- Show *who the user is* (signed-in identity) with **zero network latency** on this path.
- Beautiful but restrained, matching the Rendobar brand (Linear/Polar aesthetic, no
  AI-generated look, no marketing noise).
- Maintainable + scalable: adding a command updates one place; right-sized for 6 commands.

## Non-goals

- **No telemetry / analytics ping.** The codebase has zero analytics today; the welcome
  screen must not introduce any. Written non-goal so nobody adds one later.
- No balance on the welcome screen (volatile → a stale figure is misleading). Balance
  stays live-only in `rb whoami`.
- No first-run-specific variant (the not-signed-in CTA already covers first run).
- No OSC 8 hyperlinks, no box-drawing UI, no full Unicode→ASCII table, no
  wrangler-style `CommandRegistry` class. All judged overkill at 6 commands.

## Research basis

Grounded in: clig.dev, 12-Factor CLI Apps, the GitHub CLI (`gh`) manual + source
(`pkg/cmd/root/help.go`, `pkg/iostreams/color.go`), Stripe CLI, Cloudflare wrangler
(`CommandRegistry`), Deno/clap, cobra (`command.go`: `Commands()`, `GroupID`,
`UsageString`), the `NO_COLOR`/`FORCE_COLOR` specs, and the npm-fund backlash.

Key principles adopted:
- Banner shows **only** on bare `rb` + `--help`; never on subcommands; never decorated
  when piped/non-TTY (clig.dev TTY rule; npm-fund "no per-invocation noise" lesson).
- Commands grouped into named uppercase sections (gh `CORE`/`ACCOUNT`/`ADDITIONAL`
  model), dim descriptions, one hero example, dim footer.
- One-line wordmark + version, not multi-line ASCII art (modern dev-CLI taste — gh,
  stripe, vercel, deno have no banner; only wrangler does a 1-line version header).
- Pure render-to-string + thin print wrapper (cobra `UsageString()` / citty
  `renderUsage`), for snapshot testability.

## Architecture

### Single source of truth: `src/registry.ts` (new)

One static manifest is the canonical list of commands. It eliminates today's
**triplication** (the `subCommands` map and the validation `Set` literal in `main.ts`,
plus any welcome list).

```ts
export type Group = "CORE" | "ACCOUNT" | "SYSTEM";

export interface CommandEntry {
  name: string;
  summary: string; // short catalog blurb shown on the welcome screen
  group: Group;
  load: () => Promise<{ default: import("citty").CommandDef }>;
}

export const COMMANDS: readonly CommandEntry[] = [
  { name: "ffmpeg", summary: "Run ffmpeg in the cloud",       group: "CORE",    load: () => import("./commands/ffmpeg.js") },
  { name: "login",  summary: "Authenticate this machine",     group: "ACCOUNT", load: () => import("./commands/login.js") },
  { name: "logout", summary: "Remove stored credentials",     group: "ACCOUNT", load: () => import("./commands/logout.js") },
  { name: "whoami", summary: "Show identity, plan, balance",  group: "ACCOUNT", load: () => import("./commands/whoami.js") },
  { name: "update", summary: "Self-update to the latest version", group: "SYSTEM", load: () => import("./commands/update.js") },
  { name: "doctor", summary: "Diagnose environment + auth",   group: "SYSTEM",  load: () => import("./commands/doctor.js") },
] as const;

export const GROUP_ORDER: readonly Group[] = ["CORE", "ACCOUNT", "SYSTEM"] as const;
```

- `main.ts` derives citty's `subCommands` from this:
  `Object.fromEntries(COMMANDS.map((c) => [c.name, () => c.load().then((m) => m.default)]))`,
  and the unknown-command guard `Set` from `COMMANDS.map((c) => c.name)`.
- The welcome renderer reads `name`/`summary`/`group` **strings only** — it never calls
  `load()`, so rendering help loads **zero** command modules (and zero SDK graph). This
  sidesteps citty's `renderUsage`, which `await`s every lazy `subCommands` thunk just to
  read descriptions — a measurable cold-start hit on the most common invocation.
- Group catalog is central (`GROUP_ORDER`); group membership is inline (`group` field).
  This is cobra's `AddGroup` + `GroupID` split, collapsed into one readable place — the
  more maintainable choice at this scale.

**Maintenance rule (add to `CLAUDE.md`/`AGENTS.md`):** adding a subcommand means adding
one entry to `COMMANDS`. That single edit drives citty registration, the unknown-command
guard, and the welcome catalog together. (README/docs updated separately.)

### Theme: `src/lib/theme.ts` (new, ~30 lines)

The justified subset of gh's `ColorScheme` (we explicitly do **not** build gh's full
`IOStreams`). Centralizes the per-file `pc.*` + `isTTY` assumptions already scattered
across `whoami.ts`, `login.ts`, `logout.ts`, `doctor.ts`, `main.ts` — so multiple real
consumers exist, not just the welcome screen.

Responsibilities:
- **`enabled`** — own color gate, total precedence order:
  `--no-color` > `NO_COLOR` (present, any value, incl. empty) > `FORCE_COLOR` >
  `CLICOLOR_FORCE=1` > (`!process.stdout.isTTY` ‖ `TERM=dumb` ‖ `CI`) → off > default on.
  We compute this ourselves rather than trusting `pc.isColorSupported`, because
  picocolors force-enables color on `win32` even when piped (breaks `rb | cat` on the
  maintainer's own platform) and does not honor `--no-color`/`CLICOLOR*`.
  When disabled, expose `pc.createColors(false)` (identity functions).
- **Color token fns** — `heading`, `cmd`, `accent`, `dim`, `error`, `warn`.
- **`stripWidth(s)`** — ANSI-stripped display width, for column alignment.
- **`glyph(name)`** — Unicode glyph with ASCII fallback when on legacy Windows conhost
  (no `WT_SESSION` and not VS Code terminal on win32) or `NO_UNICODE` is set:
  `check ✓→[ok]`, `cross ✗→x`, `arrow →→->`, `mid ·→-`, `warn ⚠→!`.

### Welcome renderer: `src/lib/welcome.ts` (new)

Pure functions returning strings + a thin printer. **No SDK import** anywhere in this
module's import graph.

- `renderWelcome(state): string` — the bare-`rb` screen.
- `renderHelp(state): string` — `renderWelcome` plus the root-flag reference
  (`--json`, `--url-only`, `--quiet`, `--no-wait`, `--no-color`) and the usage line.
- `renderWelcomeJson(state): string` — `{ version, authenticated, commands: [...] }` for
  `rb --json`.
- `printWelcome()` — resolves `state`, picks the renderer, writes to **stdout** with an
  EPIPE-safe write (swallow `EPIPE`, exit 0).

`state` is assembled from sync, no-network sources:
- `resolveAuth()` → is a credential present? (env key or file)
- `readStoredIdentity()` → optional `{ orgName, plan }` (see auth changes)
- `getPendingNotification(VERSION)` → optional dim update line (sync, cache-only)

### Identity persistence: `src/lib/auth.ts` (edit)

To show `org · plan` with zero network, persist it where it is already in hand and
already lifecycle-managed — inside `credentials.json` (the gh `hosts.yml` model, but more
conservative: no balance).

- Extend `saveOAuthCredentials` and `saveApiKey` to accept an optional
  `identity?: { orgName: string; plan: string }` and write it into the same atomic
  tmp+rename write (no second write path, no torn-write window).
- Add `readStoredIdentity(configDir?): { orgName: string; plan: string } | null` —
  defensive: returns `null` when the field is absent (existing on-disk files lack it →
  additive-optional, **zero migration**) or on any read/parse error.
- **Wrap `getConfigDir()`** usage on the welcome path so a missing `APPDATA`/`HOME`
  (it currently throws) degrades to "not signed in" rather than crashing the screen.
- `clearCredentials()` already unlinks the file → identity is wiped on `logout` for free.
- **Never store balance.** `whoami` keeps fetching it live.
- `RB_NO_IDENTITY=1` suppresses the org/plan line (privacy: bare `rb` is the most
  screenshotted/screen-shared command). When set, show generic "signed in".

### Callers: `login.ts`, `whoami.ts` (edit)

Both already call `client.orgs.current()` and hold `state.org.name` / `state.plan.name`.
Pass those into the save functions so the identity cache is populated as a side-effect of
the existing successful auth/fetch. `logout.ts` needs no change.

### `rb help [cmd]`: `src/commands/help.ts` (new, ~10 lines)

citty has no `help` subcommand; without this, `rb help` hits the unknown-command path and
looks broken. `rb help` → root welcome/help; `rb help <cmd>` → that command's citty usage.

### Wiring: `src/main.ts` (edit)

- `subCommands` derived from `COMMANDS` (registry).
- Extend the **existing** root `run()` block (do not add a parallel path):
  - `raw.length === 0` → `printWelcome()` (stdout, exit 0).
  - `--json` present (no subcommand) → emit `renderWelcomeJson` (stdout, exit 0).
  - `--quiet` or `--url-only` (no subcommand) → silent, exit 0.
  - keep the existing ffmpeg-flag hint.
  - otherwise unknown args → `unknown command '<x>' — run \`rb\` to see commands` to
    **stderr**, exit 2 (matches existing convention).
- `runMain(main, { showUsage })` override: when there is no parent (root `--help`/`-h`)
  → print `renderHelp`; otherwise delegate to citty's `renderUsage` for
  `rb <cmd> --help`. `--version` stays owned by citty, untouched.
- Install an `EPIPE` handler on `process.stdout`.

## Screen layout

### Logged out
```
  rb · Rendobar                                    v1.0.1
  Cloud FFmpeg & video processing from your terminal

  → Not signed in. Run `rb login` to get started.

  USAGE
    rb <command> [flags]

  CORE
    ffmpeg     Run ffmpeg in the cloud

  ACCOUNT
    login      Authenticate this machine
    logout     Remove stored credentials
    whoami     Show identity, plan, balance

  SYSTEM
    update     Self-update to the latest version
    doctor     Diagnose environment + auth

  EXAMPLE
    rb ffmpeg -i in.mp4 -vf scale=1280:-1 out.mp4

  Run `rb <command> --help` for details · Docs https://rendobar.com/docs
```
`rb` in brand-accent bold; section headers bold; descriptions + footer dim; CTA arrow
accented. The CTA carries a text prefix (`→ Not signed in`) so it reads correctly with
color stripped (accessibility: never encode state in color alone).

### Identity-line state matrix
| State | Identity line |
|---|---|
| Logged out (no credential) | `→ Not signed in. Run \`rb login\` to get started.` |
| File creds, identity stored | `Acme Inc · Pro   ·   run \`rb whoami\` for balance` |
| File creds, no identity yet | `✓ Signed in   ·   run \`rb whoami\`` |
| Env `RENDOBAR_API_KEY` (no file) | `✓ Signed in via API key   ·   run \`rb whoami\`` |
| `RB_NO_IDENTITY=1` while signed in | `✓ Signed in` |
| Update pending (any state) | + dim `getPendingNotification` line at the bottom |

### `rb --help`
`renderWelcome` output, followed by a root-flag reference and usage line. Bare `rb` stays
short/oriented; `--help` is the authoritative full reference.

## Behavior matrix
| Invocation | Output | Stream | Exit |
|---|---|---|---|
| `rb` | welcome | stdout | 0 |
| `rb --help` / `-h` | welcome + flags | stdout | 0 |
| `rb --version` | version (citty) | stdout | 0 |
| `rb --json` | `{version,authenticated,commands}` | stdout | 0 |
| `rb --quiet` / `--url-only` | (silent) | — | 0 |
| `rb help` / `rb help <cmd>` | welcome / cmd usage | stdout | 0 |
| `rb <unknown>` | `unknown command …` | stderr | 2 |
| `rb -i x.mp4 …` (ffmpeg flags) | existing hint | stderr | 2 |
| any of the above, piped/non-TTY | plain (no ANSI) | as above | as above |

## Edge cases
- Non-TTY / piped → no color, no decoration (gate in `theme.enabled`).
- `process.stdout.columns` `undefined` **or** `0` (mid-resize) → fallback width 80.
- Legacy Windows conhost / `NO_UNICODE` → ASCII glyph fallback.
- `EPIPE` on `rb | head` → swallowed, exit 0 (welcome is the first long stdout writer
  where this matters).
- Welcome path performs **no network call and no side-effect**: it only *reads*
  `getPendingNotification` (sync cache); it does **not** fire `checkForUpdate()`.
- `getConfigDir()` throwing (unset `APPDATA`/`HOME`) → treated as "not signed in".

## Testing

Pure renderers make this straightforward (no stdout capture / process spawning):
- `renderWelcome(state)` per state: signed-out, file-creds+identity, file-creds-no-identity,
  env-key, `RB_NO_IDENTITY`, with/without pending-update — snapshot colored **and** plain.
- `renderHelp` includes the root-flag block; `renderWelcomeJson` shape.
- `theme.enabled` precedence: `isTTY=false`, `NO_COLOR` (incl. empty), `--no-color`,
  `FORCE_COLOR`, `CLICOLOR_FORCE`, `TERM=dumb`, `CI=true` → assert no ANSI; win32+piped
  → assert no ANSI (the picocolors bug guard).
- `theme.glyph` fallback: simulate legacy conhost → ASCII substitutes for `✓ ✗ → · ⚠`.
- `readStoredIdentity`: roundtrip, absent field → `null`, corrupt JSON → `null`.
- `registry`: `subCommands` derivation contains all 6; guard `Set` matches.
- `main.ts` wiring: bare (exit 0), `--help` (showUsage fires), `--version` (citty
  untouched), `rb help` / `rb help ffmpeg`, unknown (exit 2, stderr), `--json` bare,
  `--quiet` bare (silent, exit 0).
- EPIPE: write into a closed stream → no throw, exit 0.
- **Manual-verify once (note in PR):** real conhost glyph rendering; screen-reader output.

## File summary
| File | Change |
|---|---|
| `src/registry.ts` | NEW — `COMMANDS` + `GROUP_ORDER` single source of truth |
| `src/lib/theme.ts` | NEW (~30L) — color gate, tokens, `stripWidth`, `glyph` |
| `src/lib/welcome.ts` | NEW — `renderWelcome`/`renderHelp`/`renderWelcomeJson`/`printWelcome` |
| `src/commands/help.ts` | NEW (~10L) — `rb help [cmd]` alias |
| `src/lib/auth.ts` | EDIT — store/read optional identity; wrap `getConfigDir` on welcome path |
| `src/commands/login.ts` | EDIT — persist org/plan (already fetched) |
| `src/commands/whoami.ts` | EDIT — persist org/plan (already fetched) |
| `src/main.ts` | EDIT — derive subCommands; bare/json/quiet/unknown handling; `showUsage`; EPIPE |

**Net: 4 new files + 4 edits. No new dependencies. No network or side-effects on the
welcome path.**
