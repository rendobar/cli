#!/usr/bin/env node
// scripts/unlink-local-sdk.mjs
// Reverses scripts/link-local-sdk.mjs — unlinks the global pnpm link and
// reinstalls the published @rendobar/sdk version from package.json.
import { execSync } from "node:child_process";

function run(cmd) {
  console.log(`[unlink-sdk] $ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    // unlink can fail if nothing is linked — that's fine
    console.log(`[unlink-sdk] (non-fatal) ${err.message.split("\n")[0]}`);
  }
}

function main() {
  run("pnpm unlink --global @rendobar/sdk");
  run("pnpm install");
  console.log("");
  console.log("[unlink-sdk] ✓ @rendobar/sdk restored to npm version from package.json");
}

main();
