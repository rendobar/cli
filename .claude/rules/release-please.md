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
| git tags (`v*`) | `release-please.yml` Tag step (PAT push) — see "How tagging works" below |
| GitHub Releases (title, body) | `cli-binaries.yml` (on the tag) |

**If you edit any of these by hand, release-please's state diverges and the next release PR will be wrong or fail.**

## Workflow

```
commit `feat: X` on main
  ↓ release-please.yml fires
release-please opens PR: "chore: release main" with version X+1
  ↓ auto-merge enabled with the PAT (squash, once test+lint green)
release PR squash-merges → push to main re-fires release-please.yml
  ↓ "Tag released version" step: pushes vX+1 (PAT) + labels PR `autorelease: tagged`
cli-binaries.yml fires on the vX+1 tag
  ↓
5 builds → attestations → GH release → 3-OS smoke test
```

You merge **only the feature PR**. The release PR auto-merges and tags itself.

## How tagging works (and why release-please does NOT create the release)

`release-please.yml` sets `skip-github-release: true`. release-please therefore
manages only the version PR, `CHANGELOG.md`, and the manifest — it does **not**
create the GitHub Release or push the tag itself.

Reason: release-please's github-release step cannot match this single-root-package
repo's merged release PR. In v16.12.0, `getBranchComponent()` resolves to the
package name (`rendobar-cli`) while the merged PR branch (`release-please--branches--main`)
carries no component, so the components mismatch, the release is skipped, and the
PR is left `autorelease: pending` forever — which then aborts every later run
(`"untagged, merged release PRs outstanding"`). This is upstream bug
googleapis/release-please#2214 (open for root paths); `component: ""` does not fix
it (`"" || getDefaultComponent()` falls back to the package name).

Instead, the **"Tag released version"** step in `release-please.yml` runs after a
release PR merges: it reads the version from `package.json`, pushes `vX.Y.Z` with
the PAT (so `cli-binaries.yml` fires), and flips the merged PR to
`autorelease: tagged` to clear the bookkeeping. The PAT (`RELEASE_PLEASE_TOKEN`) is
also what enables auto-merge, so the release-PR merge re-triggers the workflow —
a `GITHUB_TOKEN` merge would fire nothing.

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
