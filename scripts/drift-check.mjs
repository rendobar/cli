#!/usr/bin/env node
// scripts/drift-check.mjs
// Checks if the CLI's @rendobar/sdk dep is behind the latest version on npm.
// Opens a GH issue if drifted by more than a patch version.
// Runs via .github/workflows/drift-check.yml.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY ?? "rendobar/cli";
const PACKAGE = "@rendobar/sdk";

function gh(cmd) {
  return execSync(`gh ${cmd}`, { encoding: "utf-8" }).trim();
}

function log(msg) {
  console.log(`[drift-check] ${msg}`);
}

function getCurrentDep() {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  const dep = pkg.dependencies?.[PACKAGE] ?? pkg.devDependencies?.[PACKAGE];
  if (!dep) throw new Error(`${PACKAGE} not found in package.json`);
  return dep.replace(/^[\^~]/, "");
}

async function getNpmLatest() {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const body = await res.json();
  return body.version;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function hasExistingDriftIssue(latest) {
  try {
    const issues = JSON.parse(
      gh(
        `issue list --search "drift-check: ${PACKAGE} behind ${latest} in:title" --state open --json number --repo ${REPO}`,
      ),
    );
    return issues.length > 0;
  } catch {
    return false;
  }
}

function openIssue(current, latest) {
  const body = `Drift check detected that \`${PACKAGE}\` dependency is behind the latest published version.

| Location | Version |
|---|---|
| \`package.json\` | \`${current}\` |
| npm latest | \`${latest}\` |

### Fix

Run:

\`\`\`bash
pnpm up ${PACKAGE}@${latest}
git checkout -b chore/bump-sdk-${latest}
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): bump ${PACKAGE} to ${latest}"
git push -u origin chore/bump-sdk-${latest}
gh pr create
\`\`\`

This issue was opened automatically by \`.github/workflows/drift-check.yml\`. It will be closed automatically when the dependency is updated.`;

  gh(
    `issue create --repo ${REPO} --title "drift-check: ${PACKAGE} behind ${latest}" --body "${body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" --label dependencies --label automated`,
  );
  log(`opened drift issue for ${PACKAGE}: ${current} → ${latest}`);
}

async function main() {
  const current = getCurrentDep();
  log(`current ${PACKAGE} dep: ${current}`);

  const latest = await getNpmLatest();
  log(`npm latest ${PACKAGE}: ${latest}`);

  const currentParsed = parseSemver(current);
  const latestParsed = parseSemver(latest);
  if (!currentParsed || !latestParsed) {
    log("unable to parse semver — skipping");
    return;
  }

  const diff = compareSemver(latestParsed, currentParsed);
  if (diff <= 0) {
    log("dep is up-to-date");
    return;
  }

  if (hasExistingDriftIssue(latest)) {
    log(`drift issue for ${latest} already open`);
    return;
  }

  openIssue(current, latest);
}

main().catch((err) => {
  console.error(`[drift-check] fatal: ${err.message}`);
  process.exit(1);
});
