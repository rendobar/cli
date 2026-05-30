import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rb-id-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("readStoredIdentity", () => {
  it("returns null when no credentials file exists", async () => {
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("returns null when file has no identity field", async () => {
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiKey: "rb_x" }));
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("returns null on corrupt JSON", async () => {
    writeFileSync(join(dir, "credentials.json"), "{not json");
    const { readStoredIdentity } = await import("../lib/auth.js");
    expect(readStoredIdentity(dir)).toBeNull();
  });
  it("reads identity written by saveApiKey", async () => {
    const { saveApiKey, readStoredIdentity } = await import("../lib/auth.js");
    await saveApiKey("rb_test", dir, { orgName: "Acme Inc", plan: "Pro" });
    expect(readStoredIdentity(dir)).toEqual({ orgName: "Acme Inc", plan: "Pro" });
  });
  it("reads identity written by saveOAuthCredentials", async () => {
    const { saveOAuthCredentials, readStoredIdentity } = await import("../lib/auth.js");
    await saveOAuthCredentials(
      { accessToken: "tok", expiresAt: Date.now() + 1000, identity: { orgName: "Beta LLC", plan: "Free" } },
      dir,
    );
    expect(readStoredIdentity(dir)).toEqual({ orgName: "Beta LLC", plan: "Free" });
  });
  it("token refresh preserves previously-stored identity", async () => {
    const { saveOAuthCredentials, readStoredIdentity } = await import("../lib/auth.js");
    // seed credentials WITH identity
    await saveOAuthCredentials(
      { accessToken: "old", refreshToken: "r1", expiresAt: 1, identity: { orgName: "Acme Inc", plan: "Pro" } },
      dir,
    );
    // simulate what refreshTokenIfNeeded does: save new tokens, identity preserved
    const prev = readStoredIdentity(dir);
    await saveOAuthCredentials(
      { accessToken: "new", refreshToken: "r2", expiresAt: 2, identity: prev ?? undefined },
      dir,
    );
    expect(readStoredIdentity(dir)).toEqual({ orgName: "Acme Inc", plan: "Pro" });
  });
});
