#!/usr/bin/env node
// scripts/link-local-sdk.mjs
// Links a sibling checkout of @rendobar/sdk into rendobar-cli for local
// cross-repo development. Runs `pnpm link --global` from the SDK dir, then
// `pnpm link --global @rendobar/sdk` from cli.
//
// Usage:
//   pnpm dev:sdk-local                    # uses ../rendobar/packages/sdk
//   RENDOBAR_MONOREPO=/path pnpm dev:sdk-local  # custom path
//
// Unlink with `pnpm dev:sdk-npm`.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MONOREPO = process.env.RENDOBAR_MONOREPO ?? resolve("..", "rendobar");
const SDK_DIR = resolve(MONOREPO, "packages", "sdk");

function run(cmd, cwd) {
  console.log(`[link-sdk] ${cwd ? `(${cwd}) ` : ""}$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function main() {
  if (!existsSync(SDK_DIR)) {
    console.error(`[link-sdk] SDK not found at ${SDK_DIR}`);
    console.error(`[link-sdk] Clone the monorepo as a sibling, or set RENDOBAR_MONOREPO=/absolute/path`);
    process.exit(1);
  }

  console.log(`[link-sdk] using SDK at ${SDK_DIR}`);

  // Build SDK first — pnpm link picks up the dist/ folder
  run("pnpm --filter @rendobar/sdk build", MONOREPO);

  // Register globally from SDK dir
  run("pnpm link --global", SDK_DIR);

  // Link from cli dir
  run("pnpm link --global @rendobar/sdk");

  console.log("");
  console.log("[link-sdk] ✓ @rendobar/sdk is now linked from", SDK_DIR);
  console.log("[link-sdk] Run `pnpm dev:sdk-npm` before committing.");
  console.log("[link-sdk] The pre-commit hook will block commits while the SDK is linked.");
}

main();
