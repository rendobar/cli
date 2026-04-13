#!/usr/bin/env node
// scripts/check-no-linked-sdk.mjs
// Pre-commit guard: rejects commits while @rendobar/sdk is pnpm-linked to a
// local dev checkout (via `pnpm link --global`).
//
// pnpm ALWAYS symlinks node_modules/@rendobar/sdk to node_modules/.pnpm/...
// for normal installs, so "is a symlink" alone isn't enough. We check if the
// symlink target contains "/.pnpm/" or "\\.pnpm\\" — if yes, it's a normal
// pnpm store install; if no, it's a local dev link and we block the commit.
import { lstatSync, readlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SDK_PATH = resolve("node_modules", "@rendobar", "sdk");

if (!existsSync(SDK_PATH)) {
  process.exit(0);
}

try {
  const stat = lstatSync(SDK_PATH);
  if (!stat.isSymbolicLink()) {
    // Real directory — probably a manual copy or non-pnpm install
    process.exit(0);
  }

  const target = readlinkSync(SDK_PATH);
  const normalized = target.replace(/\\/g, "/");

  // Normal pnpm store install: target lives under node_modules/.pnpm/
  if (normalized.includes("/.pnpm/")) {
    process.exit(0);
  }

  // Anything else = dev link to a sibling checkout
  console.error("");
  console.error("  ✗ @rendobar/sdk is pnpm-linked to a local checkout.");
  console.error(`    Link target: ${target}`);
  console.error("");
  console.error("    Commit blocked. Local-linked SDK means your CLI works");
  console.error("    only against unreleased SDK code and will break in CI.");
  console.error("");
  console.error("    Fix: run `pnpm dev:sdk-npm` to restore the npm version, then commit.");
  console.error("");
  process.exit(1);
} catch (err) {
  console.error(`[check-no-linked-sdk] error: ${err.message}`);
  process.exit(0);
}
