---
description: Conventional Commits format + bump mapping + release discipline. Single-product repo, no commit scope. Enforces R1-R5 (user-visible change rule, no empty releases, install scripts as public API, `!` for breaking, release-please owns tags).
globs:
  - "src/**"
  - "scripts/**"
  - ".github/workflows/**"
  - "install.sh"
  - "install.ps1"
  - "uninstall.sh"
  - "uninstall.ps1"
  - "package.json"
  - "tsconfig.json"
  - "lefthook.yml"
  - "commitlint.config.mjs"
  - "release-please-config.json"
  - ".release-please-manifest.json"
  - "CHANGELOG.md"
---

# Conventional Commits & Release Discipline

Every commit on `main` MUST follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/). release-please parses commit types to compute version bumps. This repo is single-product — **no commit scope**.

## Format

```
type: subject
```

Bare `feat:` / `fix:` / `chore:` is correct. `feat(cli): ...` is rejected by rule even though commitlint accepts it — inconsistent history prevents clean grep and adds no value in a single-product repo.

Valid types: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`.

---

## The 5 rules that matter

### R1. `feat:` / `fix:` mean user-visible change, not "new thing in the repo"

A commit is `feat:` **iff a user running `rb` (or running the install scripts) notices a new flag, subcommand, behavior, output, exit code, or install path**. Otherwise it's `chore:` / `ci:` / `build:` / `refactor:` / `docs:` / `test:`.

The Conventional Commits spec grants normative meaning to `feat` (MINOR) and `fix` (PATCH) only. Everything else is team convention. The spec anchors on **consumer-observable change**, not on "did the repo gain a file."

### R2. No release for commits that can't change the shipped artifact

If `git diff v$PREV..HEAD -- src/ package.json install.sh install.ps1 uninstall.sh uninstall.ps1` is empty, **no release should be cut**. The binary and distribution scripts are byte-identical; shipping a new version number burns user trust, pollutes attestation audit trails, and confuses `gh release view`.

Enforcement is social: pick the correct commit type (matrix below). Non-bumping types (`ci`, `chore`, `docs`, `build`, `refactor`, `test`, `style`) will not trigger release-please, so a PR with only those commits merges without cutting a release.

### R3. Install scripts ARE public API

`install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1` are distribution contracts users pipe into their shell. Breaking them ≈ breaking `rb`. Treat them as shipped code:

- Add capability (new platform, new env var, new prompt) → `feat:`
- Fix breakage (checksum regression, PATH bug, running-binary handling) → `fix:`
- Cosmetic (log wording, comment refactor) → `chore:`

### R4. Use `!` in the type for breaking changes; footer is backup

Prefer `feat!: rename --output to --out` over `feat:` with `BREAKING CHANGE:` footer. Reasons:
- `!` is visible in `git log --oneline`, in release-please's PR title, in the CHANGELOG heading
- The footer can get lost in long squash-merge bodies
- The spec treats them as equivalent for bump computation

Only add `BREAKING CHANGE:` footer when you also need multi-line migration notes.

**Never** put `BREAKING CHANGE:` in the subject line. release-please parses footers only; subject-line text is ignored and the bump will silently be wrong.

### R5. release-please owns tags — manual tagging is a footgun

release-please owns: `CHANGELOG.md`, `package.json` version field, `.release-please-manifest.json`, git tags, GitHub Release metadata.

**Never hand-edit any of these.** They regenerate on the next run and your edit reverts.

Recovery paths for state drift are documented in `release-please.md`. Do not invent ad-hoc workarounds.

`GITHUB_TOKEN`-pushed tags do not trigger downstream workflows (GitHub security feature). `cli-binaries.yml` only fires when the tag is pushed by a user PAT. The `RELEASE_PLEASE_TOKEN` secret supplies this. Do not delete or overwrite it without having a replacement PAT ready.

---

## Decision matrix — commit type by what changed

| Change | Type | Bumps? | In CHANGELOG? |
|---|---|---|---|
| `src/commands/*.ts` — add subcommand / flag | `feat:` | minor | yes, Features |
| `src/**` — fix user-visible behavior | `fix:` | patch | yes, Bug Fixes |
| `src/**` — internal rename / split / cleanup | `refactor:` | no | no |
| `src/**` — measurable speedup (benchmark) | `perf:` | patch | yes, Performance |
| `install.sh` / `install.ps1` — new platform, new env var | `feat:` | minor | yes |
| `install.sh` / `install.ps1` — fix broken install | `fix:` | patch | yes |
| `install.sh` — log wording / comment only | `chore:` | no | no |
| `uninstall.sh` / `uninstall.ps1` — functional change | `feat:` / `fix:` | yes | yes |
| `package.json` — runtime dep that ships in binary | `fix:` or `feat:` | yes | yes |
| `package.json` — devDep only | `chore(deps):` | no | no |
| `.github/workflows/**` — any change | `ci:` | no | no |
| `scripts/*.mjs` — release/build tooling | `build:` | no | no |
| `lefthook.yml`, `commitlint.config.mjs`, lint config | `chore:` | no | no |
| `tsconfig.json`, `bunfig.toml` | `build:` | no | no |
| `README.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/**` | `docs:` | no | no |
| `**/*.test.ts`, test-only | `test:` | no | no |
| Revert a previous commit | `revert:` | patch | yes, Reverts |

## Decision matrix — version bump (post-1.0)

| Type | Bump | CHANGELOG section |
|---|---|---|
| `feat!:` / `BREAKING CHANGE:` footer | **major** (1.x → 2.0) | Breaking, prominent |
| `feat:` | minor (1.0 → 1.1) | Features |
| `fix:` | patch (1.0.0 → 1.0.1) | Bug Fixes |
| `perf:` | patch | Performance |
| `revert:` | patch | Reverts |
| `refactor:`, `docs:`, `test:`, `build:`, `ci:`, `chore:`, `style:` | none | hidden |

Pre-1.0 differs: features become patches under `bump-minor-pre-major: true`. We are post-1.0 — the pre-1.0 flags in `release-please-config.json` are `false` and must stay `false`.

## Writing commit subjects

- Imperative mood: `feat: add X`, not `feat: added X` / `feat: adds X`
- ≤72 chars
- No trailing period
- Lowercase first letter
- Describe *what the change does*, not *how*

### Good

```
feat: add rb batch command for parallel submissions
fix: handle malformed checksums.txt in rb update
feat!: rename --output flag to --out

BREAKING CHANGE: --output has been renamed to --out for consistency
across the CLI. Migration: find-replace in scripts.
```

### Bad

```
update stuff                    ← skipped by release-please (not conventional)
Feat: Added thing.              ← wrong case, past tense, trailing period
feat(cli): add X                ← scope forbidden in this single-product repo
feat: Added a new feature.      ← past tense, capitalized, trailing period
BREAKING CHANGE: rename flag    ← footer text in subject; release-please ignores
```

---

## Anti-patterns — forbidden

| Anti-pattern | Why tempting | Why wrong |
|---|---|---|
| Typing internal refactors as `fix:` "to document the work" | Feels productive, shows up in CHANGELOG | Cuts a patch release with no user-visible change. Use `refactor:` or `chore:`. |
| `feat(cli): ...` scope | Copy-paste from monorepo habits | Single-product repo; inconsistent history, breaks grep, release-please doesn't use scope for bumps here. |
| `BREAKING CHANGE:` in the subject line | Visibility | Spec violation — footer-only. release-please will not detect it, bump will be wrong. Use `!` in the type. |
| `git tag vX.Y.Z && git push` | "Faster than waiting for release-please" | Diverges `.release-please-manifest.json`; next release-please PR computes wrong version. Also fails `cli-binaries.yml` if pushed with `GITHUB_TOKEN`. |
| Editing `CHANGELOG.md` by hand | "Fix a typo" | Next release regenerates the file; your edit reverts. If wording matters, fix the commit message via PR description rewrite before squash-merge. |
| Editing `package.json` `version` by hand | "Force a specific release" | release-please overwrites it. Use `Release-As: X.Y.Z` footer in a `chore:` commit. |
| `Release-As:` to mask an empty bump | "Just get a version out" | Enshrines a lie in history. If there's no user-visible change, there's no release. |
| Using `--no-verify` on commit | Bypass commitlint hook failure | Investigate the hook failure. Never bypass. |
| Deleting a shipped tag/release | "Fix a bad release" | Users may be installing it via `install.sh`. Use a forward fix (revert + new release) instead. Exception: pre-adoption cleanup on a brand-new repo, documented. |
| Consuming `/releases/latest` in user scripts without a pin option | Simplicity | `install.sh` already supports `RENDOBAR_VERSION=` env var for this reason. Keep it. |

---

## Commit-authoring checklist

Before every commit, answer each:

1. If a user runs `rb update` after this lands, will they notice **anything** different?
   - **No** → cannot be `feat:` or `fix:`.
2. Does the change touch `src/**` or a distribution script (`install.*` / `uninstall.*` / runtime `package.json` deps)?
   - **No** → almost certainly `ci:` / `chore:` / `docs:` / `build:` / `test:`.
3. Am I changing the shape of a flag, env var, subcommand, exit code, or output format?
   - **Yes, and it removes/renames anything** → `feat!:` (breaking).
   - **Yes, and it only adds** → `feat:`.
4. Is this a repair of existing behavior a user already depended on?
   - **Yes** → `fix:`.
5. Subject line: imperative mood, ≤72 chars, no trailing period?
6. If breaking: `!` in the type (not subject, not just footer)?

If any answer is "no" or "I don't know", stop and re-read this file.

---

## Enforcement layers (all active)

1. **lefthook `commit-msg`** — blocks bad messages locally at `git commit` time
2. **`.github/workflows/pr-title.yml`** — required status check on PR titles
3. **Branch protection on `main`** — required `pr-title` check means bad titles can't merge
4. **Watchdog cron** — catches silent skips within 6h
5. **This rule file** — source of truth for agents and humans

---

## NEVER

- `git commit --no-verify` — blocks commitlint. Fix the message, don't bypass.
- Force-push bypassing hooks.
- Emojis in commit subjects (some tools choke on them).
- `BREAKING CHANGE:` in the subject line — put it in a footer after a blank line.
- Hand-edit CHANGELOG, package.json version, or `.release-please-manifest.json`.

---

## Related docs

- `release-please.md` — the release flow release-please owns, recovery paths
- `workflow-conventions.md` — Actions SHA pinning, shell rules, bun version pin
- `cross-repo-sdk.md` — SDK + CLI ship order when changes span repos
