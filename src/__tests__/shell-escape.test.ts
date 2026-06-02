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

  it("leaves underscore and __input_N placeholders unquoted", () => {
    expect(shellEscape("_")).toBe("_");
    expect(shellEscape("__input_0")).toBe("__input_0");
    expect(shellEscape("snake_case_var")).toBe("snake_case_var");
  });

  it("quotes shell metacharacters that would otherwise expand", () => {
    // Globs
    expect(shellEscape("*.mp4")).toBe("'*.mp4'");
    expect(shellEscape("file?.mp4")).toBe("'file?.mp4'");
    expect(shellEscape("[abc]")).toBe("'[abc]'");
    // Brace expansion
    expect(shellEscape("{a,b}")).toBe("'{a,b}'");
    // History / negation
    expect(shellEscape("!cmd")).toBe("'!cmd'");
    // Redirection / pipes / control
    expect(shellEscape("a>b")).toBe("'a>b'");
    expect(shellEscape("a<b")).toBe("'a<b'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("a&b")).toBe("'a&b'");
    expect(shellEscape("a;b")).toBe("'a;b'");
    // Tilde / comment
    expect(shellEscape("~user")).toBe("'~user'");
    expect(shellEscape("#hash")).toBe("'#hash'");
  });

  it("quotes whitespace including tabs and newlines", () => {
    expect(shellEscape("a b")).toBe("'a b'");
    expect(shellEscape("a\tb")).toBe("'a\tb'");
    expect(shellEscape("a\nb")).toBe("'a\nb'");
  });

  it("preserves unicode in quoted form", () => {
    expect(shellEscape("café")).toBe("'café'");
    expect(shellEscape("日本語")).toBe("'日本語'");
  });

  // Inline POSIX parser identical to packages/shared/src/ffmpeg/sanitizer.ts.
  // Kept here so the CLI suite verifies the contract without depending on
  // the monorepo source — these two implementations MUST stay in sync.
  const POSIX_DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);
  function parse(cmd: string): string[] {
    const args: string[] = [];
    let cur = "";
    let inSingle = false;
    let inDouble = false;
    let escapeFrom: "outside" | "double" | null = null;
    for (const c of cmd) {
      if (escapeFrom !== null) {
        if (escapeFrom === "double" && !POSIX_DOUBLE_QUOTE_ESCAPES.has(c)) {
          cur += "\\";
        }
        cur += c;
        escapeFrom = null;
        continue;
      }
      if (c === "\\") {
        if (inSingle) { cur += c; continue; }
        escapeFrom = inDouble ? "double" : "outside";
        continue;
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

  it("argv → escape → join → split round-trip preserves the prod failing command", () => {
    const argv = [
      "-i", "https://x.com/v.mp4",
      "-vf", "select='lte(t,60),x'",
      "-an",
      "output.gif",
    ];
    expect(parse(argv.map(shellEscape).join(" "))).toEqual(argv);
  });

  it("round-trip is lossless across an adversarial argv", () => {
    // Hits every special class: quotes, spaces, globs, dollar, backticks,
    // newlines, unicode, embedded singles, leading/trailing quotes.
    const argv = [
      "plain",
      "with space",
      "with\ttab",
      "with\nnewline",
      "globs*?[abc]",
      "$dollar`backtick`",
      "{brace,expansion}",
      "~tilde",
      "embedded'single",
      "'leading-single",
      "trailing-single'",
      `a"b'c\\d`,
      "café 日本語",
      "select='lte(t,60)*not(mod(trunc(t*24),240))',setpts=N/TB/40,scale=-2:320",
      "_underscore",
      "__input_0",
      "",
    ];
    const command = argv.map(shellEscape).join(" ");
    // Empty argv elements survive shellEscape (becomes `''`) and parse back
    // to "" — but our parser drops empty quoted segments via the
    // `current.length > 0` push gate. That's a known/accepted limitation:
    // ffmpeg never takes empty argv elements and the CLI never produces them
    // for ffmpeg. Filter the empty out before comparing.
    expect(parse(command)).toEqual(argv.filter((a) => a.length > 0));
  });
});
