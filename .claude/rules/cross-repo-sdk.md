---
description: SDK lives in the rendobar/rendobar monorepo. Dev loop + ship order for cross-repo changes.
globs:
  - "src/**"
  - "package.json"
  - "pnpm-lock.yaml"
  - "scripts/link-local-sdk.mjs"
  - "scripts/unlink-local-sdk.mjs"
  - "scripts/check-no-linked-sdk.mjs"
---

# Cross-Repo: SDK ↔ CLI

The CLI depends on `@rendobar/sdk` from npm. **The SDK source is NOT in this repo.** It lives in the private [rendobar/rendobar](https://github.com/rendobar/rendobar) monorepo under `packages/sdk/`.

## Where to make changes

| You want to... | Edit where |
|---|---|
| Add a CLI command | This repo, `src/commands/` |
| Fix a CLI bug | This repo |
| Add an SDK method | Monorepo, `packages/sdk/src/resources/` |
| Change SDK response types | Monorepo, `packages/shared/src/api/responses.ts` |
| Bump SDK version used by CLI | This repo, `pnpm up @rendobar/sdk` |

## Dev loop — CLI only

```bash
pnpm install
pnpm test          # bun test, 48 tests
pnpm typecheck     # tsc --noEmit
pnpm dev -- --version
pnpm build         # compile rb / rb.exe standalone
```

## Dev loop — SDK + CLI simultaneously

When a CLI change needs unreleased SDK code:

```bash
# Prereq: clone monorepo as sibling directory (or set RENDOBAR_MONOREPO=/abs/path)
#   Sibling default: ../rendobar/packages/sdk

pnpm dev:sdk-local   # builds monorepo SDK, pnpm-links it here
pnpm test            # tests now run against your local SDK
# ...iterate...
pnpm dev:sdk-npm     # restores @rendobar/sdk from package.json (npm version)
```

**A pre-commit hook blocks commits while the SDK is pnpm-linked.** See `scripts/check-no-linked-sdk.mjs`. The hook distinguishes normal pnpm store symlinks (safe — contain `/.pnpm/`) from dev-link targets (blocked).

## Ship order

When your change spans SDK + CLI:

1. **Monorepo first**: commit `feat(sdk): add X API` → merge → release-please PR → merge → `sdk-vX.Y.Z` publishes to npm with provenance
2. **Wait** 1–3 min for npm registry to propagate
3. **This repo**: `pnpm up @rendobar/sdk@X.Y.Z` → commit `feat: use new SDK X API` → merge → release-please → ships

**If you forget step 3**, the drift-check cron (`.github/workflows/drift-check.yml`, runs daily) catches it and opens an issue automatically.

## Never

- Commit with `@rendobar/sdk` pnpm-linked. Pre-commit hook rejects. Run `pnpm dev:sdk-npm` first.
- Ship CLI before SDK when there's a version dependency. `pnpm install --frozen-lockfile` in CI will fail because the new SDK version doesn't exist on npm yet.
- Use `workspace:*` protocol for `@rendobar/sdk` in package.json. This isn't a workspace. Use `^1.0.0` style versions from npm.
- Hand-edit `node_modules/@rendobar/sdk/` to test changes — edit the monorepo source and link.
