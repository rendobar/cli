#!/usr/bin/env node
// scripts/watchdog.mjs
// Detects silent release skips: commits on main since last v* tag with
// conventional feat/fix/perf types but no open release-please PR.
// Opens a GH issue if detected. Runs via .github/workflows/watchdog.yml.
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONVENTIONAL_BUMP = /^(feat|fix|perf|revert)(\([a-z0-9-]+\))?!?:/;
const REPO = process.env.GITHUB_REPOSITORY ?? "rendobar/cli";
const GRACE_MS = 2 * 60 * 60 * 1000; // 2h — don't nag within the grace window

function gh(cmd) {
  return execSync(`gh ${cmd}`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function log(msg) {
  console.log(`[watchdog] ${msg}`);
}

function getLastTag() {
  try {
    const tags = JSON.parse(gh(`api "repos/${REPO}/tags?per_page=100"`));
    const vTags = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t.name));
    return vTags[0]?.name ?? null;
  } catch (err) {
    log(`failed to fetch tags: ${err.message}`);
    return null;
  }
}

function getTagDate(tag) {
  try {
    const commit = JSON.parse(gh(`api "repos/${REPO}/commits/${encodeURIComponent(tag)}"`));
    return new Date(commit.commit.committer.date);
  } catch (err) {
    log(`failed to fetch tag date: ${err.message}`);
    return null;
  }
}

function getCommitsSince(since) {
  try {
    const isoSince = since.toISOString();
    const commits = JSON.parse(
      gh(`api "repos/${REPO}/commits?sha=main&since=${isoSince}&per_page=100"`),
    );
    return commits;
  } catch (err) {
    log(`failed to fetch commits: ${err.message}`);
    return [];
  }
}

function getOpenReleasePR() {
  try {
    const prs = JSON.parse(
      gh(
        `pr list --search "release-please in:title" --state open --json number,title,createdAt,headRefName --repo ${REPO}`,
      ),
    );
    return prs;
  } catch (err) {
    log(`failed to fetch release PRs: ${err.message}`);
    return [];
  }
}

function hasExistingWatchdogIssue(tag) {
  try {
    const issues = JSON.parse(
      gh(
        `issue list --search "watchdog: silent release skip after ${tag} in:title" --state open --json number --repo ${REPO}`,
      ),
    );
    return issues.length > 0;
  } catch {
    return false;
  }
}

function openIssue(tag, skippedCommits) {
  const commitLines = skippedCommits
    .slice(0, 10)
    .map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.commit.message.split("\n")[0]}`)
    .join("\n");
  const body = `Watchdog detected ${skippedCommits.length} conventional commit(s) on \`main\` since the last release tag \`${tag}\`, but no open release-please PR.

This usually means:
1. release-please failed to run after a merge to main
2. The commits were pushed directly to main without triggering workflows
3. A prior release PR was closed without merging

### Skipped commits

${commitLines}

### Fix

- Re-run the release-please workflow manually: \`gh workflow run release-please --repo ${REPO}\`
- Or push an empty commit to main to re-trigger it

This issue was opened automatically by \`.github/workflows/watchdog.yml\`. Close it once the release PR exists.`;

  // Use --body-file to avoid shell escape bugs on backticks / dollar signs
  // in commit messages.
  const bodyFile = join(tmpdir(), `watchdog-${Date.now()}-${process.pid}.md`);
  writeFileSync(bodyFile, body);
  try {
    gh(
      `issue create --repo ${REPO} --title "watchdog: silent release skip after ${tag}" --body-file "${bodyFile}" --label automated`,
    );
    log(`opened watchdog issue for tag ${tag}`);
  } catch (err) {
    log(`failed to open issue: ${err.message}`);
  } finally {
    try { unlinkSync(bodyFile); } catch { /* best-effort */ }
  }
}

async function main() {
  const lastTag = getLastTag();
  if (!lastTag) {
    log("no v* tags found — skipping (first release not yet shipped)");
    return;
  }
  log(`last release tag: ${lastTag}`);

  const tagDate = getTagDate(lastTag);
  if (!tagDate) {
    log("could not resolve tag date — skipping");
    return;
  }

  const commits = getCommitsSince(tagDate);
  const skipped = commits.filter((c) => {
    const subject = c.commit.message.split("\n")[0];
    return CONVENTIONAL_BUMP.test(subject);
  });

  if (skipped.length === 0) {
    log("no conventional commits since last tag — healthy");
    return;
  }

  const newestSkipped = new Date(skipped[0].commit.committer.date);
  const ageMs = Date.now() - newestSkipped.getTime();
  if (ageMs < GRACE_MS) {
    log(`newest skipped commit is ${Math.round(ageMs / 60000)}min old, under grace window — healthy`);
    return;
  }

  const releasePRs = getOpenReleasePR();
  if (releasePRs.length > 0) {
    log(`found ${releasePRs.length} open release PR(s) — healthy`);
    return;
  }

  if (hasExistingWatchdogIssue(lastTag)) {
    log(`watchdog issue for ${lastTag} already exists — skipping`);
    return;
  }

  log(`ALERT: ${skipped.length} conventional commits after ${lastTag} with no open release PR`);
  openIssue(lastTag, skipped);
}

main().catch((err) => {
  console.error(`[watchdog] fatal: ${err.message}`);
  process.exit(1);
});
