import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveAuth,
  saveOAuthCredentials,
  saveApiKey,
  clearCredentials,
  getConfigDir,
} from "../lib/auth.js";

describe("auth", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-test-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveAuth", () => {
    it("returns apikey from RENDOBAR_API_KEY env var", () => {
      process.env.RENDOBAR_API_KEY = "rb_test_from_env";
      const result = resolveAuth(tmpDir);
      expect(result).toEqual({ type: "apikey", apiKey: "rb_test_from_env" });
    });

    it("returns oauth from credentials file with type=oauth", async () => {
      delete process.env.RENDOBAR_API_KEY;
      await saveOAuthCredentials(
        { accessToken: "tok_abc", refreshToken: "rt_abc", expiresAt: Date.now() + 3600_000 },
        tmpDir,
      );
      const result = resolveAuth(tmpDir);
      expect(result?.type).toBe("oauth");
      if (result?.type === "oauth") {
        expect(result.accessToken).toBe("tok_abc");
        expect(result.refreshToken).toBe("rt_abc");
      }
    });

    it("returns apikey from legacy credentials file (no type field)", async () => {
      delete process.env.RENDOBAR_API_KEY;
      await saveApiKey("rb_legacy_key", tmpDir);
      const result = resolveAuth(tmpDir);
      expect(result).toEqual({ type: "apikey", apiKey: "rb_legacy_key" });
    });

    it("returns null when no credentials exist", () => {
      delete process.env.RENDOBAR_API_KEY;
      expect(resolveAuth(tmpDir)).toBeNull();
    });

    it("env var takes priority over file", async () => {
      process.env.RENDOBAR_API_KEY = "rb_from_env";
      await saveOAuthCredentials(
        { accessToken: "tok_ignored", expiresAt: Date.now() + 3600_000 },
        tmpDir,
      );
      const result = resolveAuth(tmpDir);
      expect(result).toEqual({ type: "apikey", apiKey: "rb_from_env" });
    });

    it("returns oauth without refreshToken (degraded mode)", async () => {
      delete process.env.RENDOBAR_API_KEY;
      await saveOAuthCredentials(
        { accessToken: "tok_no_rt", expiresAt: Date.now() + 3600_000 },
        tmpDir,
      );
      const result = resolveAuth(tmpDir);
      expect(result?.type).toBe("oauth");
      if (result?.type === "oauth") {
        expect(result.refreshToken).toBeUndefined();
      }
    });
  });

  describe("saveApiKey", () => {
    it("creates directory and file", async () => {
      const nestedDir = path.join(tmpDir, "nested", "config");
      await saveApiKey("rb_test_save", nestedDir);
      const filePath = path.join(nestedDir, "credentials.json");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(content.apiKey).toBe("rb_test_save");
    });
  });

  describe("clearCredentials", () => {
    it("deletes the credentials file", async () => {
      await saveApiKey("rb_temp", tmpDir);
      expect(fs.existsSync(path.join(tmpDir, "credentials.json"))).toBe(true);
      clearCredentials(tmpDir);
      expect(fs.existsSync(path.join(tmpDir, "credentials.json"))).toBe(false);
    });

    it("does not throw if file already gone", () => {
      expect(() => clearCredentials(tmpDir)).not.toThrow();
    });
  });

  describe("getConfigDir", () => {
    it("returns platform-appropriate path", () => {
      expect(getConfigDir()).toContain("rendobar");
    });
  });
});
