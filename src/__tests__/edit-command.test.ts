import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import editCommand, { extractEditArgs, parseEditFlags } from "../commands/edit.js";
import { buildGenParams } from "../lib/image-params.js";
import { isLocalPath, type ParsedInput } from "../lib/parse-ffmpeg-args.js";
import { uploadLocalFiles } from "../lib/upload.js";

describe("edit command metadata", () => {
  it("registers as `edit` with the expected description", () => {
    expect(editCommand.meta).toMatchObject({
      name: "edit",
      description: "Edit one or more images from a text instruction",
    });
  });
});

describe("extractEditArgs", () => {
  it("returns everything after the `edit` token", () => {
    const argv = ["bun", "rb", "edit", "--prompt", "make the sky purple", "--image", "a.png"];
    expect(extractEditArgs(argv)).toEqual(["--prompt", "make the sky purple", "--image", "a.png"]);
  });

  it("returns an empty array when the edit subcommand is missing", () => {
    expect(extractEditArgs(["bun", "rb"])).toEqual([]);
  });
});

describe("parseEditFlags", () => {
  it("defaults to null/empty/false for every flag when none are passed", () => {
    expect(parseEditFlags([])).toEqual({
      prompt: null, images: [], model: null, seed: null, output: null,
      json: false, quiet: false, noWait: false, urlOnly: false,
    });
  });

  it("collects repeated --image flags into an ordered array", () => {
    const flags = parseEditFlags(["--image", "https://example.com/a.png", "--image", "./b.png", "--image", "./c.png"]);
    expect(flags.images).toEqual(["https://example.com/a.png", "./b.png", "./c.png"]);
  });

  it("parses --prompt, --model, --seed, --output", () => {
    const flags = parseEditFlags([
      "--prompt", "make the sky purple",
      "--model", "standard",
      "--seed", "42",
      "--output", "edited.webp",
    ]);
    expect(flags.prompt).toBe("make the sky purple");
    expect(flags.model).toBe("standard");
    expect(flags.seed).toBe(42);
    expect(flags.output).toBe("edited.webp");
  });

  it("parses the standard job flags: --json, --quiet, --no-wait, --url-only", () => {
    const flags = parseEditFlags(["--json", "--quiet", "--no-wait", "--url-only"]);
    expect(flags.json).toBe(true);
    expect(flags.quiet).toBe(true);
    expect(flags.noWait).toBe(true);
    expect(flags.urlOnly).toBe(true);
  });

  it("mixes a single --image with other flags in any order", () => {
    const flags = parseEditFlags(["--prompt", "remove the logo", "--image", "./photo.jpg", "--output", "out.webp"]);
    expect(flags.images).toEqual(["./photo.jpg"]);
    expect(flags.prompt).toBe("remove the logo");
    expect(flags.output).toBe("out.webp");
  });
});

describe("edit flags -> submit params (integration of parseEditFlags + buildGenParams)", () => {
  it("builds only prompt/model/seed -- edit's flag surface doesn't expose width/height/enhance/negative/guidance/steps", () => {
    const flags = parseEditFlags(["--prompt", "make the sky purple", "--model", "economy", "--seed", "1"]);
    const params = buildGenParams({ prompt: flags.prompt!, model: flags.model, seed: flags.seed });
    expect(params).toEqual({ prompt: "make the sky purple", model: "economy", seed: 1 });
  });
});

describe("edit local image upload (reuses rb ffmpeg's uploadLocalFiles flow)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-edit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTempFile(name: string, content = "fake"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("classifies a URL image as remote and a bare path as local", () => {
    expect(isLocalPath("https://cdn.rendobar.com/uploads/a.png")).toBe(false);
    expect(isLocalPath("./local.png")).toBe(true);
  });

  it("uploads local --image paths and rewrites them to asset URLs, leaving URL images untouched", async () => {
    const localPath = createTempFile("edit-source.png");
    const images = ["https://example.com/remote.png", localPath];
    const parsedImages: ParsedInput[] = images.map((value, index) => ({ index, value, isLocal: isLocalPath(value) }));
    expect(parsedImages[0]!.isLocal).toBe(false);
    expect(parsedImages[1]!.isLocal).toBe(true);

    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/edit-source.png" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(images, parsedImages, mockClient);

    expect(mockClient.uploads.create).toHaveBeenCalledTimes(1);
    expect(rewritten[0]).toBe("https://example.com/remote.png");
    expect(rewritten[1]).toBe("https://cdn.rendobar.com/uploads/edit-source.png");
  });

  it("uploads multiple local images, each getting its own asset URL", async () => {
    const pathA = createTempFile("a.png");
    const pathB = createTempFile("b.png");
    const images = [pathA, pathB];
    const parsedImages: ParsedInput[] = images.map((value, index) => ({ index, value, isLocal: isLocalPath(value) }));

    let callIdx = 0;
    const mockClient = {
      uploads: {
        create: mock(async () => {
          callIdx++;
          return { url: `https://cdn.rendobar.com/uploads/img${callIdx}.png` };
        }),
      },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(images, parsedImages, mockClient);

    expect(mockClient.uploads.create).toHaveBeenCalledTimes(2);
    expect(rewritten).toEqual([
      "https://cdn.rendobar.com/uploads/img1.png",
      "https://cdn.rendobar.com/uploads/img2.png",
    ]);
  });

  it("skips the upload call entirely when every --image is already a URL", async () => {
    const images = ["https://example.com/a.png", "https://example.com/b.png"];
    const parsedImages: ParsedInput[] = images.map((value, index) => ({ index, value, isLocal: isLocalPath(value) }));
    expect(parsedImages.every((p) => !p.isLocal)).toBe(true);

    const mockUpload = mock(() => Promise.resolve({ url: "unused" }));
    const mockClient = { uploads: { create: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(images, parsedImages, mockClient);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(rewritten).toEqual(images);
  });
});
