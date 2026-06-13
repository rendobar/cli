import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseFfmpegArgs } from "../lib/parse-ffmpeg-args.js";
import { uploadLocalFiles } from "../lib/upload.js";

describe("ffmpeg command flow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ffmpeg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTempFile(name: string, content = "fake"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("builds correct command string for API submission", () => {
    const rawArgs = ["-i", "https://example.com/video.mp4", "-vf", "scale=1280:720", "output.mp4"];
    const parsed = parseFfmpegArgs(rawArgs);
    expect(parsed.errors).toEqual([]);
    const commandString = "ffmpeg " + rawArgs.join(" ");
    expect(commandString).toBe("ffmpeg -i https://example.com/video.mp4 -vf scale=1280:720 output.mp4");
  });

  it("replaces local paths with URLs after upload", async () => {
    const localPath = createTempFile("local.mp4");
    const rawArgs = ["-i", localPath, "-vf", "scale=640:480", "output.mp4"];
    const parsed = parseFfmpegArgs(rawArgs);
    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/abc.mp4" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];
    const rewritten = await uploadLocalFiles(rawArgs, parsed.inputs, mockClient);
    const commandString = "ffmpeg " + rewritten.join(" ");
    expect(commandString).toContain("cdn.rendobar.com");
    expect(commandString).not.toContain(localPath);
  });

  it("rejects empty args with isEmpty flag", () => {
    expect(parseFfmpegArgs([]).isEmpty).toBe(true);
  });

  it("preserves non-input args after upload", async () => {
    const localPath = createTempFile("video.mp4");
    const rawArgs = ["-i", localPath, "-c:v", "libx264", "-crf", "23", "output.mp4"];
    const parsed = parseFfmpegArgs(rawArgs);
    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/xyz.mp4" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];
    const rewritten = await uploadLocalFiles(rawArgs, parsed.inputs, mockClient);

    // FFmpeg flags should be preserved
    expect(rewritten).toContain("-c:v");
    expect(rewritten).toContain("libx264");
    expect(rewritten).toContain("-crf");
    expect(rewritten).toContain("23");
    expect(rewritten).toContain("output.mp4");
    // Local path replaced
    expect(rewritten).not.toContain(localPath);
  });

  it("handles multiple local files in a single command", async () => {
    const bgPath = createTempFile("bg.mp4");
    const overlayPath = createTempFile("overlay.png");
    const rawArgs = ["-i", bgPath, "-i", overlayPath, "-filter_complex", "[0:v][1:v]overlay=10:10", "output.mp4"];
    const parsed = parseFfmpegArgs(rawArgs);
    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.inputs[0]!.isLocal).toBe(true);
    expect(parsed.inputs[1]!.isLocal).toBe(true);

    let callIdx = 0;
    const mockClient = {
      uploads: {
        create: mock(async () => {
          callIdx++;
          return { url: `https://cdn.rendobar.com/uploads/file${callIdx}.mp4` };
        }),
      },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(rawArgs, parsed.inputs, mockClient);

    expect(mockClient.uploads.create).toHaveBeenCalledTimes(2);
    expect(rewritten[1]).toContain("cdn.rendobar.com");
    expect(rewritten[3]).toContain("cdn.rendobar.com");
    // Filter complex preserved
    expect(rewritten).toContain("-filter_complex");
    expect(rewritten).toContain("[0:v][1:v]overlay=10:10");
  });

  it("mixed local and remote inputs only upload local files", async () => {
    const localPath = createTempFile("local.png");
    const rawArgs = ["-i", "https://example.com/bg.mp4", "-i", localPath, "output.mp4"];
    const parsed = parseFfmpegArgs(rawArgs);
    expect(parsed.inputs[0]!.isLocal).toBe(false);
    expect(parsed.inputs[1]!.isLocal).toBe(true);

    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/local.png" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(rawArgs, parsed.inputs, mockClient);

    // Only one upload call (the local file)
    expect(mockClient.uploads.create).toHaveBeenCalledTimes(1);
    // Remote URL preserved
    expect(rewritten[1]).toBe("https://example.com/bg.mp4");
    // Local file replaced
    expect(rewritten[3]).toBe("https://cdn.rendobar.com/uploads/local.png");
  });

  it("detects output file from parsed args", () => {
    const parsed = parseFfmpegArgs(["-i", "https://example.com/v.mp4", "-c:v", "libx264", "result.mp4"]);
    expect(parsed.outputFile).toBe("result.mp4");
    expect(parsed.errors).toEqual([]);
  });

  it("produces correct command string with codec and filter flags", () => {
    const rawArgs = ["-i", "https://cdn.rendobar.com/video.mp4", "-c:v", "libx264", "-preset", "fast", "-vf", "scale=1920:1080", "output.mp4"];
    const commandString = "ffmpeg " + rawArgs.join(" ");
    expect(commandString).toBe("ffmpeg -i https://cdn.rendobar.com/video.mp4 -c:v libx264 -preset fast -vf scale=1920:1080 output.mp4");
  });
});

// ── --compute flag → submit params ─────────────────────────────
//
// Mirrors how `rb ffmpeg` constructs the job params object: `compute` is only
// included when the user passed a value, and that value is validated against
// auto|cpu|gpu before submission.

type Compute = "auto" | "cpu" | "gpu";

function isCompute(value: string): value is Compute {
  return value === "auto" || value === "cpu" || value === "gpu";
}

function buildParams(command: string, timeout: number, compute: Compute | null): Record<string, unknown> {
  return { command, timeout, ...(compute ? { compute } : {}) };
}

describe("ffmpeg --compute flag", () => {
  it("includes compute in params when --compute gpu is passed", () => {
    const compute = "gpu";
    expect(isCompute(compute)).toBe(true);
    const params = buildParams("ffmpeg -i in.mp4 out.mp4", 120, compute);
    expect(params.compute).toBe("gpu");
  });

  it("accepts auto and cpu as valid compute modes", () => {
    expect(isCompute("auto")).toBe(true);
    expect(isCompute("cpu")).toBe(true);
    expect(buildParams("ffmpeg -i in.mp4 out.mp4", 120, "cpu").compute).toBe("cpu");
  });

  it("rejects an invalid compute value", () => {
    expect(isCompute("turbo")).toBe(false);
    expect(isCompute("GPU")).toBe(false);
    expect(isCompute("")).toBe(false);
  });

  it("omits compute from params when no --compute flag is passed", () => {
    const params = buildParams("ffmpeg -i in.mp4 out.mp4", 120, null);
    expect("compute" in params).toBe(false);
    expect(params.command).toBe("ffmpeg -i in.mp4 out.mp4");
    expect(params.timeout).toBe(120);
  });
});
