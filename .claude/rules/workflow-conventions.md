---
description: GH Actions conventions — SHA-pinned actions, Bun version, cross-platform sha256, attestations, tag behavior.
globs:
  - ".github/workflows/**"
---

# GitHub Actions Conventions

## Action pinning — ALWAYS SHA

Every `uses:` must be pinned to a full 40-char SHA, with a version comment. Tags can be moved; SHAs can't.

```yaml
# GOOD
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

# BAD — tag can be force-pushed
- uses: actions/checkout@v4
```

**Canonical pinned SHAs for this repo** (update in lockstep if you bump any):

| Action | SHA | Version |
|---|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | v4.2.2 |
| `actions/setup-node` | `39370e3970a6d050c480ffad4ff0ed4d3fdee5af` | v4.1.0 |
| `actions/upload-artifact` | `b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882` | v4.4.3 |
| `actions/download-artifact` | `fa0a91b85d4f404e444e00e005971372dc801d16` | v4.1.8 |
| `actions/cache` | `0057852bfaa89a56745cba8c7296529d2fc39830` | v4 |
| `actions/attest-build-provenance` | `7668571508540a607bdfd90a87a560489fe372eb` | v2.1.0 |
| `oven-sh/setup-bun` | `4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5` | v2.0.1 |
| `pnpm/action-setup` | `a7487c7e89a18df4991f7f222e4898a00d66ddda` | v4.1.0 |
| `softprops/action-gh-release` | `e7a8f85e1c67a31e6ed99a94b41bd0b71bbee6b8` | v2.0.9 |
| `googleapis/release-please-action` | `7987652d64b4581673a76e33ad5e98e3dd56832f` | v4.1.3 |

Renovate auto-updates these when new versions release.

## Bun version

Pinned to `1.3.12` everywhere. **Do not bump without testing all 5 platforms.**

- `1.2.x` is broken on `setup-bun` (HTTP 400 on download endpoint)
- `latest` is unpredictable in CI — never use

## Cross-platform SHA256

Use `shasum -a 256 -c`, **never** `sha256sum -c`. The latter doesn't exist on macOS runners.

```bash
# GOOD — works on macos + linux + windows (git bash)
shasum -a 256 -c checksums.txt

# BAD — breaks on macos
sha256sum -c checksums.txt
```

## Attestations

Attestations require:
- `permissions.attestations: write`
- `permissions.id-token: write`  
- `actions/attest-build-provenance` step with `subject-path:`
- Public repository (this is one)

**Do not remove `attestations: write` from `cli-binaries.yml`.** Users verify binaries with `gh attestation verify`.

## Tag-triggered workflows

GitHub does NOT fire workflows on tags pushed by `GITHUB_TOKEN`. This is a security feature to prevent recursive runs.

- release-please pushes tags via its own auth token, which DOES fire workflows
- If a tag is pushed manually via `GITHUB_TOKEN` (e.g., a misconfigured script), `cli-binaries.yml` will NOT fire
- To recover: delete the tag, push it again from a local machine with a user PAT (`git push origin v1.2.3`)

## Required permissions per workflow

| Workflow | Permissions |
|---|---|
| `test.yml` | `contents: read` |
| `pr-title.yml` | `contents: read, pull-requests: read` |
| `release-please.yml` | `contents: write, pull-requests: write` |
| `cli-binaries.yml` | `contents: write, id-token: write, attestations: write` |
| `watchdog.yml` | `issues: write, contents: read, pull-requests: read` |
| `drift-check.yml` | `issues: write, contents: read` |

Set permissions at job level, not workflow level, when different jobs need different scopes.

## Smoke test retry

The smoke test in `cli-binaries.yml` retries 5 times with exponential backoff — GitHub's release CDN can be slow to propagate the new assets. Do not remove the retry.
