import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ffprobeCommand, {
  isLocalSource,
  resolveTimeout,
  resolveWaitBudgetMs,
  buildProbeParams,
  selectPayload,
} from "../commands/ffprobe.js";
import { uploadLocalFiles } from "../lib/upload.js";

describe("ffprobe command metadata", () => {
  it("registers as `ffprobe` with a description", () => {
    expect(ffprobeCommand.meta).toMatchObject({ name: "ffprobe", description: "Probe media metadata in the cloud" });
  });

  it("declares the documented flags", () => {
    const args = ffprobeCommand.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(
      ["json", "no-wait", "quiet", "raw", "source", "timeout"].sort(),
    );
  });
});

describe("isLocalSource", () => {
  it("treats http/https URLs as remote", () => {
    expect(isLocalSource("http://example.com/video.mp4")).toBe(false);
    expect(isLocalSource("https://example.com/video.mp4")).toBe(false);
    expect(isLocalSource("https://cdn.rendobar.com/uploads/abc.mp4")).toBe(false);
  });

  it("treats anything else as a local file path", () => {
    expect(isLocalSource("./local.mp4")).toBe(true);
    expect(isLocalSource("video.mp4")).toBe(true);
    expect(isLocalSource("/abs/path/video.mp4")).toBe(true);
    expect(isLocalSource("C:\\Users\\me\\video.mp4")).toBe(true);
  });

  it("does not false-positive on a scheme-like prefix without //", () => {
    expect(isLocalSource("http:video.mp4")).toBe(true);
  });
});

describe("resolveTimeout", () => {
  it("defaults to 60 when no value is passed", () => {
    expect(resolveTimeout(undefined)).toBe(60);
  });

  it("parses a valid value", () => {
    expect(resolveTimeout("30")).toBe(30);
  });

  it("clamps above the 900s API max", () => {
    expect(resolveTimeout("9999")).toBe(900);
  });

  it("falls back to the default for garbage input", () => {
    expect(resolveTimeout("not-a-number")).toBe(60);
    expect(resolveTimeout("-5")).toBe(60);
    expect(resolveTimeout("0")).toBe(60);
  });
});

describe("buildProbeParams", () => {
  it("always forwards timeout so it bounds server-side probe execution", () => {
    expect(buildProbeParams(60).timeout).toBe(60);
    expect(buildProbeParams(900).timeout).toBe(900);
  });
});

describe("resolveWaitBudgetMs", () => {
  it("outlasts the server-side timeout by a margin", () => {
    expect(resolveWaitBudgetMs(900)).toBe((900 + 60) * 1000);
  });

  it("floors at the SDK's own default wait budget (300s) for small timeouts", () => {
    expect(resolveWaitBudgetMs(60)).toBe(300_000);
  });

  it("never equals the raw server timeout in milliseconds", () => {
    for (const t of [30, 60, 300, 900]) {
      expect(resolveWaitBudgetMs(t)).not.toBe(t * 1000);
    }
  });
});

describe("selectPayload", () => {
  const data = {
    summary: { kind: "video", durationSec: 12.5 },
    format: { name: "mp4" },
    streams: [{ index: 0 }],
    chapters: [],
  };

  it("returns just the summary by default", () => {
    expect(selectPayload(data, false)).toEqual(data.summary);
  });

  it("returns the full data object with --raw", () => {
    expect(selectPayload(data, true)).toEqual(data);
  });
});

describe("ffprobe local-file upload (reuses the ffmpeg upload path)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ffprobe-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads a single local source and rewrites it to the asset URL", async () => {
    const localPath = path.join(tmpDir, "clip.mp4");
    fs.writeFileSync(localPath, "fake");

    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/clip.mp4" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const rewritten = await uploadLocalFiles(
      [localPath],
      [{ index: 0, value: localPath, isLocal: true }],
      mockClient,
    );

    expect(mockClient.uploads.create).toHaveBeenCalledTimes(1);
    expect(rewritten[0]).toBe("https://cdn.rendobar.com/uploads/clip.mp4");
  });

  it("throws a clear error for a missing local file", async () => {
    const missingPath = path.join(tmpDir, "missing.mp4");
    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/x.mp4" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    await expect(
      uploadLocalFiles([missingPath], [{ index: 0, value: missingPath, isLocal: true }], mockClient),
    ).rejects.toThrow(/File not found/);
  });
});
