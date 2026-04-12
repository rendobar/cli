import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rb-test-"));
  process.env.RB_CACHE_DIR = tempDir;
  // Clear other relevant env vars
  delete process.env.RB_NO_UPDATE_CHECK;
  delete process.env.CI;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.RB_CACHE_DIR;
  delete process.env.RB_NO_UPDATE_CHECK;
  delete process.env.CI;
});

describe("update-check", () => {
  it("writes cache file on first check", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify([{ tag_name: "v1.1.0", prerelease: false }]), { status: 200 })
    );
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    const cachePath = join(tempDir, "update-check.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.latest).toBe("1.1.0");
    expect(typeof cache.checkedAt).toBe("number");
  });

  it("skips network when cache is fresh (within TTL)", async () => {
    // Write a fresh cache file manually
    const cachePath = join(tempDir, "update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "1.1.0", checkedAt: Date.now(), ttl: 24 * 60 * 60 * 1000 })
    );
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("returns pending update notification when cached latest > current", async () => {
    const cachePath = join(tempDir, "update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "1.1.0", checkedAt: Date.now(), ttl: 24 * 60 * 60 * 1000 })
    );
    const { getPendingNotification } = await import("../lib/update-check.js");
    const msg = getPendingNotification("1.0.0");
    expect(msg).not.toBeNull();
    expect(msg).toContain("1.1.0");
    expect(msg).toContain("rb update");
  });

  it("returns null when current version is up-to-date", async () => {
    const cachePath = join(tempDir, "update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ latest: "1.0.0", checkedAt: Date.now(), ttl: 24 * 60 * 60 * 1000 })
    );
    const { getPendingNotification } = await import("../lib/update-check.js");
    const msg = getPendingNotification("1.0.0");
    expect(msg).toBeNull();
  });

  it("returns null when no cache exists", async () => {
    const { getPendingNotification } = await import("../lib/update-check.js");
    const msg = getPendingNotification("1.0.0");
    expect(msg).toBeNull();
  });

  it("silently skips on network failure", async () => {
    const fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { checkForUpdate } = await import("../lib/update-check.js");
    await expect(checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    const cachePath = join(tempDir, "update-check.json");
    expect(existsSync(cachePath)).toBe(false);
  });

  it("respects RB_NO_UPDATE_CHECK=1", async () => {
    process.env.RB_NO_UPDATE_CHECK = "1";
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("respects CI=true", async () => {
    process.env.CI = "true";
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("handles malformed cache file gracefully", async () => {
    const cachePath = join(tempDir, "update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "not valid json");
    const { getPendingNotification } = await import("../lib/update-check.js");
    const msg = getPendingNotification("1.0.0");
    expect(msg).toBeNull();
  });

  it("does not throw on non-2xx response", async () => {
    const fetchMock = mock(async () => new Response("rate limited", { status: 403 }));
    const { checkForUpdate } = await import("../lib/update-check.js");
    await expect(checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it("skips non-CLI tags and finds CLI tag", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify([
        { tag_name: "beta-1.0.0", prerelease: false },
        { tag_name: "v1.2.0", prerelease: false },
      ]), { status: 200 })
    );
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    const cachePath = join(tempDir, "update-check.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.latest).toBe("1.2.0");
  });

  it("skips prerelease CLI tags", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify([
        { tag_name: "v2.0.0-rc.1", prerelease: true },
        { tag_name: "v1.1.0", prerelease: false },
      ]), { status: 200 })
    );
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    const cachePath = join(tempDir, "update-check.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.latest).toBe("1.1.0");
  });

  it("does not write cache when no CLI release found", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify([
        { tag_name: "sdk-v1.0.0", prerelease: false },
      ]), { status: 200 })
    );
    const { checkForUpdate } = await import("../lib/update-check.js");
    await checkForUpdate("1.0.0", fetchMock as unknown as typeof fetch);
    const cachePath = join(tempDir, "update-check.json");
    expect(existsSync(cachePath)).toBe(false);
  });
});
