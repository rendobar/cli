---
description: Conventional Commits format + bump mapping. This is a single-product repo, no commit scope.
globs:
  - "src/**"
  - "scripts/**"
  - ".github/workflows/**"
  - "package.json"
  - "tsconfig.json"
  - "lefthook.yml"
  - "commitlint.config.mjs"
---

# Conventional Commits — Mandatory

Every commit on `main` MUST follow [Conventional Commits](https://www.conventionalcommits.org/). release-please parses commit types to compute version bumps. Non-conventional commits are silently skipped — the watchdog (`.github/workflows/watchdog.yml`) opens an issue within 6h when this happens.

## Format

```
type: subject
```

**No scope** — this is a single-product repo. Bare `feat:` / `fix:` / `chore:` is correct. Do NOT use `feat(cli): ...` — commitlint will accept it but it's inconsistent with the rest of the repo.

## Valid types

```
feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
```

## Bump mapping

| Commit | Bump | CHANGELOG entry |
|---|---|---|
| `fix: ...` | patch (1.0.0 → 1.0.1) | Yes, under "Bug Fixes" |
| `feat: ...` | minor (1.0.0 → 1.1.0) | Yes, under "Features" |
| `feat!: ...` or `BREAKING CHANGE:` footer | major (1.0.0 → 2.0.0) | Yes, highlighted |
| `perf: ...` | patch | Yes, under "Performance" |
| `revert: ...` | patch | Yes, under "Reverts" |
| `chore:`, `docs:`, `test:`, `ci:`, `refactor:`, `build:`, `style:` | no bump | no entry |

## Writing good commits

- Subject in imperative: `feat: add X`, not `feat: added X` or `feat: adds X`
- ≤72 chars subject
- No trailing period
- Lowercase first letter
- Describe what the change does, not how

## Examples

Good:
```
feat: add rb batch command for parallel submissions
fix: handle malformed checksums.txt in rb update
feat!: rename --output flag to --out

BREAKING CHANGE: --output flag renamed to --out for consistency
```

Bad:
```
update stuff                    ← skipped by release-please
Feat: Added thing.              ← wrong case, past tense, trailing period
feat(cli): add X                ← scope not used in this repo
feat: Added a new feature.      ← past tense, capitalized, trailing period
```

## Enforcement layers

1. **lefthook `commit-msg` hook** — blocks bad commit messages at `git commit` time (via commitlint)
2. **`.github/workflows/pr-title.yml`** — required status check on PR titles (branch protection enforces)
3. **Branch protection** on main — required `pr-title` check means bad PR titles can't merge
4. **Watchdog cron** — catches silent skips within 6h if something slipped through

## NEVER

- Use `git commit --no-verify` — blocks commitlint hook. If it fails, fix the message.
- Force-push bypassing hooks.
- Use emoji in commit subjects (some tools choke on them).
- Use `BREAKING CHANGE:` in the subject line — put it in a footer after a blank line.
