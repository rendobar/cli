# AGENTS.md — rendobar-cli

Guide for agents and humans working on the Rendobar CLI. Companion doc for the monorepo's `AGENTS.md` at [rendobar/rendobar](https://github.com/rendobar/rendobar).

## TL;DR

- **Source, tests, workflows**: all in this repo
- **SDK source**: lives in the [rendobar/rendobar](https://github.com/rendobar/rendobar) monorepo under `packages/sdk/`. Consumed here as `@rendobar/sdk@^1.0.0` from npm.
- **Release**: conventional commits → release-please → tag → `cli-binaries.yml` builds 5 platform binaries with attestations → GitHub Release
- **No manual tags, no manual version bumps**

## Dev loop

```bash
git clone https://github.com/rendobar/cli.git
cd cli && pnpm install
pnpm test          # 48 tests via bun test
pnpm typecheck     # tsc --noEmit
pnpm dev -- --version     # run from source
pnpm build         # compile standalone rb / rb.exe
./rb --version
```

## Working on SDK + CLI simultaneously

When you need unreleased SDK changes in CLI:

```bash
# Prereq: clone the monorepo as a sibling (or set RENDOBAR_MONOREPO env var)
#   ../rendobar/packages/sdk
pnpm dev:sdk-local    # builds monorepo SDK + pnpm-links it into this repo
pnpm test             # tests now run against your local SDK
# ...iterate...
pnpm dev:sdk-npm      # restores @rendobar/sdk from package.json (npm version)
```

**A pre-commit hook blocks commits while the SDK is linked.** It's automatic — if you forget to unlink, `git commit` fails with an instruction to run `pnpm dev:sdk-npm`.

The sibling path is `../rendobar/packages/sdk` by default. Override via:

```bash
RENDOBAR_MONOREPO=/custom/path/to/monorepo pnpm dev:sdk-local
```

## Conventional commits

Full rules + decision matrix + anti-patterns: **[.claude/rules/conventional-commits.md](.claude/rules/conventional-commits.md)** — read this before any commit.

Core rules:

- **R1** — `feat:` / `fix:` mean *user-visible* change. Adding infra / tests / CI / docs is **not** a feat or fix.
- **R2** — If the shipped artifact (binary + install scripts) is byte-identical to the previous release, no release. Pick a non-bumping type (`ci`, `chore`, `docs`, `build`, `refactor`, `test`).
- **R3** — `install.sh`, `install.ps1`, `uninstall.*` are public API. Functional changes to them bump.
- **R4** — `!` in the type for breaking changes (`feat!:`), not `BREAKING CHANGE:` in the subject.
- **R5** — release-please owns tags, `package.json` version, `CHANGELOG.md`, and `.release-please-manifest.json`. Never hand-edit.

Single-product repo — **no commit scope**. `feat:` not `feat(cli):`.

Quick bump table (post-1.0):

| Type | Bump |
|---|---|
| `feat!:` / `BREAKING CHANGE:` footer | major (`1.x` → `2.0`) |
| `feat:` | minor (`1.0` → `1.1`) |
| `fix:`, `perf:`, `revert:` | patch (`1.0.0` → `1.0.1`) |
| `chore:`, `docs:`, `test:`, `ci:`, `refactor:`, `build:`, `style:` | none |

**Force a specific version:** add `Release-As: X.Y.Z` footer to a `chore:` commit. Use sparingly — first releases, rebrands, recovering from state drift only.

Examples:

```
feat: add rb batch command for parallel submissions
fix: handle malformed checksums.txt in rb update
feat!: rename --output flag to --out

BREAKING CHANGE: --output is now --out
```

## Release flow (fully automated)

```
commit `feat: X` on main
   ↓ release-please.yml fires
release-please opens PR: "chore: release main" with bumped version
   ↓ auto-merge (when branch protection required checks pass)
tag v1.X.0 pushed by release-please
   ↓ cli-binaries.yml fires on the v* tag
5 platform builds + attestations + release + smoke tests
   ↓
release live at github.com/rendobar/cli/releases
   ↓ users on older versions
rb update → self-replaces with checksum verification + rollback
```

**You never touch tags.** Pushing a tag manually is a footgun — release-please owns them.

## Guardrails already in place

| Guardrail | Where | What it catches |
|---|---|---|
| Branch protection on `main` | GitHub settings (public repo, free) | Direct pushes, required `test` + `lint` checks before merge, linear history |
| `commitlint` on every PR title | `.github/workflows/pr-title.yml` | Non-conventional PR titles |
| `lefthook commit-msg` hook | `lefthook.yml` | Non-conventional local commits |
| `lefthook pre-commit` guard | `lefthook.yml` | Committing while SDK is pnpm-linked |
| `pnpm typecheck` + `bun test` | `.github/workflows/test.yml` | Broken code in PRs |
| Watchdog cron (every 6h) | `.github/workflows/watchdog.yml` | Silent release skips |
| SDK drift check cron (daily) | `.github/workflows/drift-check.yml` | Stale `@rendobar/sdk` dep vs npm latest |
| Build provenance attestations | `.github/workflows/cli-binaries.yml` | Verify binary was built by this workflow on this commit |
| Cross-platform smoke test | `.github/workflows/cli-binaries.yml` | Binary runs on macOS/Linux/Windows |

## Verifying a released binary

```bash
# Download any release asset
curl -fsSL -o rb.tar.gz https://github.com/rendobar/cli/releases/download/v1.0.0/rb-linux-x64.tar.gz

# Verify build provenance
gh attestation verify rb.tar.gz --repo rendobar/cli
```

Attestations prove the binary was built by this exact workflow on this exact commit, signed by GitHub's OIDC issuer.

## For agents

When asked to add a feature or fix a bug:

1. Check `pnpm test && pnpm typecheck` is green before you touch anything
2. Branch off `main`: `git checkout -b feat/short-name`
3. Make changes + write tests
4. `pnpm test && pnpm typecheck` locally
5. Commit with a conventional message: `feat: ...` or `fix: ...`
6. `git push -u origin <branch>` and `gh pr create --title "feat: ..."`
7. Wait for CI green, merge
8. Walk away — release-please handles the rest

**DO NOT**:
- Push directly to main (branch protection will reject, but don't try)
- Push tags manually (release-please owns tags)
- Commit while `@rendobar/sdk` is pnpm-linked (pre-commit hook rejects)
- Edit `CHANGELOG.md` or bump `version` in `package.json` (release-please owns both)
- Use `git commit --no-verify` (blocks hooks; investigate the hook failure instead)
- Add a commit scope like `feat(cli): ...` (single-product repo, bare `feat:` is correct)

## Gotchas

- **Bun version**: pinned to `1.3.12` in all workflows. Don't bump without testing all 5 platforms.
- **macOS sha256**: use `shasum -a 256 -c`, never `sha256sum -c` (non-existent on macOS).
- **Tag-triggered workflows**: GitHub won't fire workflows on tags pushed by `GITHUB_TOKEN`. release-please handles this internally. If `cli-binaries.yml` doesn't fire after a release-please merge, delete the release+tag, push tag from local (user PAT triggers workflows).
- **Attestations permission**: requires `attestations: write` in workflow permissions, separate from `id-token: write`.
