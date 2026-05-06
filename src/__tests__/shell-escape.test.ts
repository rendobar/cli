import { describe, it, expect } from "bun:test";
import { shellEscape } from "../lib/shell-escape.js";

describe("shellEscape", () => {
  it("returns '' for empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("leaves alphanumeric and safe punctuation unquoted", () => {
    expect(shellEscape("foo")).toBe("foo");
    expect(shellEscape("scale=1280:720")).toBe("scale=1280:720");
    expect(shellEscape("https://example.com/v.mp4")).toBe("https://example.com/v.mp4");
    expect(shellEscape("a,b,c")).toBe("a,b,c");
    expect(shellEscape("-vf")).toBe("-vf");
  });

  it("wraps strings with spaces in single quotes", () => {
    expect(shellEscape("hello world")).toBe("'hello world'");
  });

  it("wraps strings with shell metacharacters", () => {
    expect(shellEscape("a;b")).toBe("'a;b'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("a&b")).toBe("'a&b'");
    expect(shellEscape("a$b")).toBe("'a$b'");
    expect(shellEscape("a*b")).toBe("'a*b'");
  });

  it("embeds single quotes via the POSIX '\\'' form", () => {
    expect(shellEscape("a'b")).toBe("'a'\\''b'");
    expect(shellEscape("'leading")).toBe("''\\''leading'");
    expect(shellEscape("trailing'")).toBe("'trailing'\\'''");
  });

  it("escapes the real-world filter expression that broke prod", () => {
    const filter = "select='lte(t,60)*not(mod(trunc(t*24),240))',setpts=N/TB/40,scale=-2:320";
    const escaped = shellEscape(filter);
    // Should wrap in singles and escape the embedded singles
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    expect(escaped).toContain("'\\''");
  });

  it("handles backslashes literally (no special escape outside the embedded-quote form)", () => {
    // POSIX inside single quotes: backslash is literal. shellEscape only inserts
    // its own escape sequence around literal single quotes.
    expect(shellEscape("a\\b")).toBe("'a\\b'");
  });

  it("argv → escape → join → split round-trip preserves all elements", () => {
    // Mirror what the CLI does and what the API parser must reverse.
    const argv = [
      "-i", "https://x.com/v.mp4",
      "-vf", "select='lte(t,60),x'",
      "-an",
      "output.gif",
    ];
    const command = argv.map(shellEscape).join(" ");

    // Inline POSIX parser identical to packages/shared/src/ffmpeg/sanitizer.ts
    function parse(cmd: string): string[] {
      const args: string[] = [];
      let cur = "";
      let inSingle = false;
      let inDouble = false;
      let escaped = false;
      for (const c of cmd) {
        if (escaped) { cur += c; escaped = false; continue; }
        if (c === "\\") {
          if (inSingle) { cur += c; continue; }
          escaped = true; continue;
        }
        if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (c === " " && !inSingle && !inDouble) {
          if (cur.length > 0) { args.push(cur); cur = ""; }
          continue;
        }
        cur += c;
      }
      if (cur.length > 0) args.push(cur);
      return args;
    }

    expect(parse(command)).toEqual(argv);
  });
});
