# `rb init` -- Design Spec

**Date:** 2026-08-15
**Repo:** `github.com/rendobar/cli`
**Status:** Draft design. Not scheduled for implementation. `rb prompt` (shipped) is the manual half of this flow; `rb init` is the automated half.

## Problem

Today a developer integrates Rendobar by creating an API key in the dashboard, pasting the AI integration prompt into their coding agent (`rb prompt`), and letting the agent do the wiring. That flow still has two weak points:

1. The API key travels through a human. People paste keys into chats, which puts live secrets in a third party's logs. The prompt tells the agent to refuse pasted keys, but the safest key is one that never enters a conversation at all.
2. The agent re-derives project setup that a CLI already knows how to do deterministically: stack detection, env file wiring, client scaffolding.

`rb init` closes both gaps: an authenticated, one-command project bootstrap that provisions the key itself and leaves the agent-facing rules behind in the repo.

This follows the precedent set by Clerk's `clerk-init` and Neon's `neon-init` CLIs: an authenticated init command that writes credentials to local env files directly and drops agent rules into the project, so no secret ever rides a chat.

## Command

```
rb init [--dir <path>] [--yes]
```

Requires auth (`rb login` or `RENDOBAR_API_KEY`), same resolution order as `rb whoami`. Unauthenticated invocations exit 2 with the standard "Run `rb login`" hint.

## Steps

### 1. Detect the stack

Inspect the target directory, in order: `package.json` (JavaScript/TypeScript, use `@rendobar/sdk`), `requirements.txt` / `pyproject.toml` (Python, REST), `go.mod` (Go, REST). Anything else, or an empty directory: prompt the user to pick (clack prompt, matching `rb login` style). The stack decides which scaffold template is written in step 5.

### 2. Create or reuse an API key

Via the authenticated API:

- List the org's keys. If a key named `cli-init` (or a name the user picks) already exists and the local env file already holds a working key, reuse it.
- Otherwise create a new key scoped to the org, named after the project directory (e.g. `init-myapp`).
- The plaintext key is returned exactly once by the API. It goes straight into the env file in step 3 and is never printed, logged, or echoed. This is the core difference from the `rb prompt` flow: the key never passes through a human or a chat.

### 3. Write RENDOBAR_API_KEY to a gitignored env file

- Pick the env file the stack convention expects: `.env.local` (Next.js and most JS), `.env` otherwise. Respect an existing file: append or replace only the `RENDOBAR_API_KEY=` line, preserve everything else byte for byte.
- Verify the file is gitignored before writing. If it is not, add the pattern to `.gitignore` in the same run and say so. Never write a key into a file git would commit.
- If a `RENDOBAR_API_KEY` line already exists with a different value, ask before overwriting (`--yes` skips the ask and keeps the existing value).

### 4. Upsert the managed block into AGENTS.md / CLAUDE.md

Write the Rendobar agent rules (the same content `rb prompt` prints, minus the interactive key handling steps that no longer apply because the key is already in env) into the project's agent instruction file:

- Target `AGENTS.md` if present, else `CLAUDE.md` if present, else create `AGENTS.md`.
- The block is fenced by markers, following the Next.js managed-block convention: content outside the markers is preserved untouched, and the block between them is replaced wholesale on every run, so re-running `rb init` updates stale rules without clobbering the user's own instructions.

```
<!-- BEGIN:rendobar-agent-rules -->
...managed content, rewritten on every rb init run...
<!-- END:rendobar-agent-rules -->
```

- No markers found: append the block at the end of the file. Markers found: replace the span between them. A BEGIN without an END is an error, not a guess; print the fix and exit.

### 5. Scaffold a minimal client plus a done-check

Stack-appropriate, additive only (never overwrite an existing file):

- JS/TS: install `@rendobar/sdk`, write `rendobar.ts` (or `.js`) exporting a configured client, and `rendobar-check.ts`: submits an ffprobe job on `https://cdn.rendobar.com/assets/examples/sample.mp4`, waits, prints the result. This mirrors the "definition of done" step in the integration prompt.
- Python/Go: same shape via REST calls against `https://api.rendobar.com` (no version prefix), generated from the same job flow.

The done-check doubles as the smoke test: a 401 means the env file is not being loaded by the runtime, and the check says so.

### 6. Print next steps

Short, actionable, stderr (matching the CLI's output conventions):

- The one command that runs the done-check.
- Where the key was written and that it is gitignored.
- That agent rules were installed and where.
- Pointer to `rb prompt` for driving a coding agent through deeper integration work.

## Non-goals

- No framework-specific integrations (no Next.js route handlers, no queue consumers). The scaffold is a client plus a check, nothing more.
- No interactive job builder. `rb ffmpeg` and friends already cover that.
- No telemetry beyond the standard per-command event.

## Open questions

- Key scoping: should init-created keys carry a restricted scope once the API supports scoped keys?
- Monorepos: which package gets the env file and scaffold when several exist?
