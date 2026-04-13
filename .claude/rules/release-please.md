---
description: release-please owns versions, tags, and CHANGELOG.md. Do NOT hand-edit these files.
globs:
  - "package.json"
  - "CHANGELOG.md"
  - ".release-please-manifest.json"
  - "release-please-config.json"
  - ".github/workflows/release-please.yml"
  - ".github/workflows/cli-binaries.yml"
  - "scripts/generate-version.mjs"
---

# Release-Please Owns Versioning

This repo uses [release-please](https://github.com/googleapis/release-please) to automate every version bump, CHANGELOG entry, and git tag. **You do not touch any of these manually.**

## Files release-please owns

| File | Who writes it |
|---|---|
| `CHANGELOG.md` | release-please (generated from conventional commits) |
| `package.json` → `version` field | release-please |
| `.release-please-manifest.json` | release-please |
| git tags (`v*`) | release-please |
| GitHub Releases (title, body) | release-please + `cli-binaries.yml` |

**If you edit any of these by hand, release-please's state diverges and the next release PR will be wrong or fail.**

## Workflow

```
commit `feat: X` on main
  ↓ release-please.yml fires
release-please opens PR: "chore: release main" with version X+1
  ↓ merge (branch protection requires test + lint green)
tag vX+1 pushed
  ↓ cli-binaries.yml fires on tag
5 builds → attestations → GH release → 3-OS smoke test
```

**You merge two PRs per release: the feature PR, then the release-please PR.**

## Forcing a version (rare)

To override the computed version, add a footer to a `chore:` commit:

```
chore: prepare for 2.0.0 release

Release-As: 2.0.0
```

Use this sparingly — only for first releases, rebrands, or recovering from state drift.

## DO NOT

- Hand-edit `CHANGELOG.md`. It's regenerated.
- Bump `package.json` version manually. release-please does it in the release PR.
- `git tag v1.2.3 && git push origin v1.2.3`. release-please owns tags. Manual tags corrupt its state.
- Close release-please PRs without merging — this adds the commits to the next release with no way back.
- Edit `src/generated/version.ts`. It's gitignored and regenerated from `package.json` by `scripts/generate-version.mjs`.

## If something goes wrong

1. **release-please PR is stale**: close + delete branch. Next run re-creates it.
2. **Tag pushed but no binaries**: `cli-binaries.yml` didn't fire. Likely because release-please used `GITHUB_TOKEN` (which doesn't trigger workflows). Fix: delete the release + tag, push tag from local (`git push origin v1.2.3`) — your user PAT fires the workflow.
3. **Wrong version computed**: add `Release-As:` footer or fix the commit that broke the bump logic.

## Recovering from a broken release

```bash
# 1. Delete the bad release + tag
gh release delete v1.2.3 --cleanup-tag --yes --repo rendobar/cli

# 2. Re-tag from clean HEAD
git tag v1.2.3 HEAD
git push origin v1.2.3   # triggers cli-binaries.yml via user PAT
```
