import { describe, it, expect } from "bun:test";
import generateCommand, { extractGenerateArgs, parseGenerateFlags } from "../commands/generate.js";
import { buildGenParams } from "../lib/image-params.js";

describe("generate command metadata", () => {
  it("registers as `generate` with the expected description", () => {
    expect(generateCommand.meta).toMatchObject({
      name: "generate",
      description: "Generate an image from a text prompt",
    });
  });
});

describe("extractGenerateArgs", () => {
  it("returns everything after the `generate` token", () => {
    const argv = ["bun", "rb", "generate", "--prompt", "a red fox", "--width", "1024"];
    expect(extractGenerateArgs(argv)).toEqual(["--prompt", "a red fox", "--width", "1024"]);
  });

  it("returns an empty array when the generate subcommand is missing", () => {
    expect(extractGenerateArgs(["bun", "rb"])).toEqual([]);
  });

  it("returns an empty array for a bare invocation", () => {
    expect(extractGenerateArgs(["bun", "rb", "generate"])).toEqual([]);
  });
});

describe("parseGenerateFlags", () => {
  it("defaults to null/false for every flag when none are passed", () => {
    expect(parseGenerateFlags([])).toEqual({
      prompt: null, model: null, width: null, height: null, seed: null,
      enhance: false, negative: null, guidance: null, steps: null, output: null,
      json: false, quiet: false, noWait: false, urlOnly: false,
    });
  });

  it("parses --prompt", () => {
    expect(parseGenerateFlags(["--prompt", "a red fox in a snowy forest"]).prompt).toBe("a red fox in a snowy forest");
  });

  it("parses --model as either a tier alias or a pinned model id", () => {
    expect(parseGenerateFlags(["--model", "premium"]).model).toBe("premium");
    expect(parseGenerateFlags(["--model", "qwen-image-2512"]).model).toBe("qwen-image-2512");
  });

  it("parses numeric flags: width, height, seed, guidance, steps", () => {
    const flags = parseGenerateFlags([
      "--width", "1024", "--height", "768", "--seed", "42", "--guidance", "7.5", "--steps", "30",
    ]);
    expect(flags.width).toBe(1024);
    expect(flags.height).toBe(768);
    expect(flags.seed).toBe(42);
    expect(flags.guidance).toBe(7.5);
    expect(flags.steps).toBe(30);
  });

  it("parses --enhance as a boolean flag (no value consumed)", () => {
    const flags = parseGenerateFlags(["--enhance", "--prompt", "x"]);
    expect(flags.enhance).toBe(true);
    expect(flags.prompt).toBe("x");
  });

  it("parses --negative", () => {
    expect(parseGenerateFlags(["--negative", "blurry, low quality"]).negative).toBe("blurry, low quality");
  });

  it("parses --output", () => {
    expect(parseGenerateFlags(["--output", "logo.webp"]).output).toBe("logo.webp");
  });

  it("parses the standard job flags: --json, --quiet, --no-wait, --url-only", () => {
    const flags = parseGenerateFlags(["--json", "--quiet", "--no-wait", "--url-only"]);
    expect(flags.json).toBe(true);
    expect(flags.quiet).toBe(true);
    expect(flags.noWait).toBe(true);
    expect(flags.urlOnly).toBe(true);
  });

  it("parses a full flag set together, in any order", () => {
    const flags = parseGenerateFlags([
      "--prompt", "cyberpunk city at night",
      "--model", "premium",
      "--width", "1024",
      "--height", "1024",
      "--seed", "7",
      "--enhance",
      "--negative", "text, watermark",
      "--guidance", "6",
      "--steps", "40",
      "--output", "city.webp",
    ]);
    expect(flags).toMatchObject({
      prompt: "cyberpunk city at night",
      model: "premium",
      width: 1024,
      height: 1024,
      seed: 7,
      enhance: true,
      negative: "text, watermark",
      guidance: 6,
      steps: 40,
      output: "city.webp",
    });
  });

  it("ignores a value-flag with nothing after it rather than throwing", () => {
    expect(() => parseGenerateFlags(["--prompt"])).not.toThrow();
    expect(parseGenerateFlags(["--prompt"]).prompt).toBeNull();
  });
});

describe("generate flags -> submit params (integration of parseGenerateFlags + buildGenParams)", () => {
  it("builds the exact job params the API expects from parsed flags", () => {
    const flags = parseGenerateFlags(["--prompt", "a red fox", "--model", "economy", "--seed", "1"]);
    const params = buildGenParams({
      prompt: flags.prompt!,
      model: flags.model,
      width: flags.width,
      height: flags.height,
      seed: flags.seed,
      enhance: flags.enhance,
      negative: flags.negative,
      guidance: flags.guidance,
      steps: flags.steps,
    });
    expect(params).toEqual({ prompt: "a red fox", model: "economy", seed: 1 });
  });
});
