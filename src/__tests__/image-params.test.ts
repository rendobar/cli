import { describe, it, expect } from "bun:test";
import { buildGenParams, parseIntFlag, parseFloatFlag } from "../lib/image-params.js";

describe("buildGenParams", () => {
  it("always includes prompt, and omits every optional field left unset", () => {
    const params = buildGenParams({ prompt: "a red fox in a snowy forest" });
    expect(params).toEqual({ prompt: "a red fox in a snowy forest" });
  });

  it("includes model only when set -- omitted means the API's own economy default applies", () => {
    expect(buildGenParams({ prompt: "x" })).not.toHaveProperty("model");
    expect(buildGenParams({ prompt: "x", model: "premium" }).model).toBe("premium");
    expect(buildGenParams({ prompt: "x", model: "qwen-image-2512" }).model).toBe("qwen-image-2512");
  });

  it("maps --enhance to enhancePrompt, only when true", () => {
    expect(buildGenParams({ prompt: "x", enhance: true })).toHaveProperty("enhancePrompt", true);
    expect(buildGenParams({ prompt: "x", enhance: false })).not.toHaveProperty("enhancePrompt");
    expect(buildGenParams({ prompt: "x" })).not.toHaveProperty("enhancePrompt");
  });

  it("maps --negative to negativePrompt", () => {
    expect(buildGenParams({ prompt: "x", negative: "blurry, low quality" }).negativePrompt).toBe("blurry, low quality");
    expect(buildGenParams({ prompt: "x", negative: null })).not.toHaveProperty("negativePrompt");
  });

  it("forwards width, height, seed, guidance, steps unmodified when present", () => {
    const params = buildGenParams({
      prompt: "x", width: 1024, height: 768, seed: 42, guidance: 7.5, steps: 30,
    });
    expect(params).toMatchObject({ width: 1024, height: 768, seed: 42, guidance: 7.5, steps: 30 });
  });

  it("treats seed 0 as a real value, not \"unset\"", () => {
    expect(buildGenParams({ prompt: "x", seed: 0 })).toHaveProperty("seed", 0);
  });

  it("builds the full param set for a generate-style call", () => {
    const params = buildGenParams({
      prompt: "cyberpunk city at night",
      model: "premium",
      width: 1024,
      height: 1024,
      seed: 7,
      enhance: true,
      negative: "text, watermark",
      guidance: 6,
      steps: 40,
    });
    expect(params).toEqual({
      prompt: "cyberpunk city at night",
      model: "premium",
      width: 1024,
      height: 1024,
      seed: 7,
      enhancePrompt: true,
      negativePrompt: "text, watermark",
      guidance: 6,
      steps: 40,
    });
  });

  it("builds the narrower edit-style param set -- prompt/model/seed only", () => {
    const params = buildGenParams({ prompt: "make the sky purple", model: "economy", seed: 42 });
    expect(params).toEqual({ prompt: "make the sky purple", model: "economy", seed: 42 });
  });
});

describe("parseIntFlag", () => {
  it("parses a valid integer string", () => {
    expect(parseIntFlag("1024")).toBe(1024);
  });
  it("returns null for undefined", () => {
    expect(parseIntFlag(undefined)).toBeNull();
  });
  it("returns null for garbage input", () => {
    expect(parseIntFlag("not-a-number")).toBeNull();
  });
  it("truncates a float string like parseInt does", () => {
    expect(parseIntFlag("42.9")).toBe(42);
  });
});

describe("parseFloatFlag", () => {
  it("parses a valid float string", () => {
    expect(parseFloatFlag("7.5")).toBe(7.5);
  });
  it("parses a valid integer string", () => {
    expect(parseFloatFlag("6")).toBe(6);
  });
  it("returns null for undefined", () => {
    expect(parseFloatFlag(undefined)).toBeNull();
  });
  it("returns null for garbage input", () => {
    expect(parseFloatFlag("not-a-number")).toBeNull();
  });
});
