import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WelcomeState } from "../lib/welcome.js";

beforeEach(() => { process.env.NO_COLOR = "1"; process.env.NO_UNICODE = "1"; });
afterEach(() => { delete process.env.NO_COLOR; delete process.env.NO_UNICODE; });

const base: WelcomeState = {
  version: "1.0.1",
  credential: null,
  identity: null,
  hideIdentity: false,
  update: null,
};

describe("renderWelcome", () => {
  it("logged out: shows the sign-in CTA", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome(base);
    expect(out).toContain("Not signed in");
    expect(out).toContain("rb login");
  });
  it("always shows wordmark, version, command groups and the example", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome(base);
    expect(out).toContain("Rendobar");
    expect(out).toContain("1.0.1");
    expect(out).toContain("CORE");
    expect(out).toContain("ACCOUNT");
    expect(out).toContain("SYSTEM");
    expect(out).toContain("ffmpeg");
    expect(out).toContain("rb ffmpeg -i");
    expect(out).toContain("rendobar.com/docs");
  });
  it("file creds with identity: shows org and plan", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: { orgName: "Acme Inc", plan: "Pro" } });
    expect(out).toContain("Acme Inc");
    expect(out).toContain("Pro");
    expect(out).toContain("rb whoami");
    expect(out).not.toContain("Not signed in");
  });
  it("file creds without identity: generic signed-in", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: null });
    expect(out).toContain("Signed in");
    expect(out).toContain("rb whoami");
  });
  it("env credential: signed in via API key", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "env" });
    expect(out).toContain("API key");
  });
  it("RB_NO_IDENTITY: hides org name even when identity present", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, credential: "file", identity: { orgName: "Secret Org", plan: "Pro" }, hideIdentity: true });
    expect(out).not.toContain("Secret Org");
    expect(out).toContain("Signed in");
  });
  it("appends the pending-update line when present", async () => {
    const { renderWelcome } = await import("../lib/welcome.js");
    const out = renderWelcome({ ...base, update: "Update available: 1.0.1 -> 1.1.0  Run `rb update` to upgrade" });
    expect(out).toContain("Update available");
  });
});

describe("renderHelp", () => {
  it("includes everything in the welcome plus the root-flag reference", async () => {
    const { renderHelp } = await import("../lib/welcome.js");
    const out = renderHelp(base);
    expect(out).toContain("CORE");
    expect(out).toContain("--json");
    expect(out).toContain("--quiet");
    expect(out).toContain("--no-color");
    expect(out).toContain("--url-only");
    expect(out).toContain("--no-wait");
  });
});

describe("renderWelcomeJson", () => {
  it("emits version, authenticated flag, and command list", async () => {
    const { renderWelcomeJson } = await import("../lib/welcome.js");
    const obj = JSON.parse(renderWelcomeJson({ ...base, credential: "file" }));
    expect(obj.version).toBe("1.0.1");
    expect(obj.authenticated).toBe(true);
    expect(Array.isArray(obj.commands)).toBe(true);
    expect(obj.commands.find((c: { name: string }) => c.name === "ffmpeg")).toBeTruthy();
  });
});

describe("buildState", () => {
  // All env vars that affect credential resolution and update checks.
  // APPDATA = Windows config dir root; HOME + XDG_CONFIG_HOME = unix equivalents.
  const ENV = ["RENDOBAR_API_KEY", "RB_NO_IDENTITY", "APPDATA", "HOME", "XDG_CONFIG_HOME", "RB_NO_UPDATE_CHECK"];
  let saved: Record<string, string | undefined>;
  let emptyDir: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    // Suppress update-check file I/O so state.update is always null.
    process.env.RB_NO_UPDATE_CHECK = "1";
    // Point all credential lookups at an empty temp dir so no credentials.json exists.
    emptyDir = mkdtempSync(join(tmpdir(), "rb-state-"));
    process.env.APPDATA = emptyDir;         // win32: getConfigDir() uses APPDATA/rendobar
    process.env.HOME = emptyDir;            // unix: getConfigDir() uses HOME/.config/rendobar
    process.env.XDG_CONFIG_HOME = emptyDir; // unix override: getConfigDir() uses XDG_CONFIG_HOME/rendobar
  });

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("logged out when no credential present", async () => {
    const { buildState } = await import("../lib/welcome.js");
    const s = buildState();
    expect(s.credential).toBeNull();
    expect(s.identity).toBeNull();
  });

  it("env API key -> credential 'env'", async () => {
    process.env.RENDOBAR_API_KEY = "rb_live_x";
    const { buildState } = await import("../lib/welcome.js");
    expect(buildState().credential).toBe("env");
  });

  it("RB_NO_IDENTITY sets hideIdentity", async () => {
    process.env.RB_NO_IDENTITY = "1";
    const { buildState } = await import("../lib/welcome.js");
    expect(buildState().hideIdentity).toBe(true);
  });

  it("never throws even if config dir is unusable", async () => {
    // On win32 getConfigDir() throws when APPDATA is missing; buildState() must swallow it.
    delete process.env.APPDATA;
    delete process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    const { buildState } = await import("../lib/welcome.js");
    expect(() => buildState()).not.toThrow();
  });
});
