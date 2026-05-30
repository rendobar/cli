import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const ENV_KEYS = ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE", "TERM", "CI", "NO_UNICODE", "WT_SESSION", "TERM_PROGRAM"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ANSI = /\x1b\[[0-9;]*m/;

describe("theme.colorEnabled precedence", () => {
  it("--no-color overrides everything", () => {
    process.env.FORCE_COLOR = "1";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled(["--no-color"])).toBe(false);
  });
  it("NO_COLOR (even empty) disables", () => {
    process.env.NO_COLOR = "";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(false);
  });
  it("FORCE_COLOR enables even when not a TTY", () => {
    process.env.FORCE_COLOR = "1";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(true);
  });
  it("TERM=dumb disables", () => {
    process.env.TERM = "dumb";
    process.env.FORCE_COLOR = "";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(false);
  });
  it("FORCE_COLOR=0 does not force color on (and non-TTY stays off)", () => {
    process.env.FORCE_COLOR = "0";
    const { colorEnabled } = require("../lib/theme.js");
    expect(colorEnabled([])).toBe(false);
  });
});

describe("theme tokens", () => {
  it("heading emits ANSI when enabled", () => {
    process.env.FORCE_COLOR = "1";
    const { theme } = require("../lib/theme.js");
    expect(ANSI.test(theme.heading("X"))).toBe(true);
  });
  it("heading is plain when disabled", () => {
    process.env.NO_COLOR = "1";
    const { theme } = require("../lib/theme.js");
    expect(theme.heading("X")).toBe("X");
  });
});

describe("theme.stripWidth", () => {
  it("ignores ANSI escapes", () => {
    process.env.FORCE_COLOR = "1";
    const { theme, stripWidth } = require("../lib/theme.js");
    expect(stripWidth(theme.heading("hello"))).toBe(5);
  });
});

describe("theme.glyph fallback", () => {
  it("returns ASCII when NO_UNICODE set", () => {
    process.env.NO_UNICODE = "1";
    const { glyph } = require("../lib/theme.js");
    expect(glyph("check")).toBe("[ok]");
    expect(glyph("arrow")).toBe("->");
    expect(glyph("mid")).toBe("-");
  });
  it("returns unicode glyphs when unicode allowed", () => {
    delete process.env.NO_UNICODE;
    process.env.WT_SESSION = "1";
    const { glyph } = require("../lib/theme.js");
    expect(glyph("check")).toBe("✓");
  });
});
