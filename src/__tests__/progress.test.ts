import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildResult, outputUrl, downloadUrlToFile, downloadFilesToDir, type JobFile } from "../lib/progress.js";

describe("buildResult — unified output", () => {
  it("reads a file output (headline file + meta)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        data: null,
        file: {
          url: "https://cdn.rendobar.com/jobs/job_1/output.mp4",
          path: "output.mp4",
          type: "video",
          size: 4096,
          meta: { format: "mp4", width: 1280, height: 720 },
        },
        files: [
          {
            url: "https://cdn.rendobar.com/jobs/job_1/output.mp4",
            path: "output.mp4",
            type: "video",
            size: 4096,
            meta: { format: "mp4", width: 1280, height: 720 },
          },
        ],
        expiresAt: 123,
      },
    });
    expect(r.output?.data).toBeNull();
    expect(r.output?.file?.url).toBe("https://cdn.rendobar.com/jobs/job_1/output.mp4");
    expect(r.output?.file?.type).toBe("video");
    expect(r.output?.file?.meta?.width).toBe(1280);
    expect(r.output?.files.length).toBe(1);
    expect(r.output?.expiresAt).toBe(123);
    expect(r.error).toBeUndefined();
  });

  it("reads a stream output (playlist headline file)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        data: null,
        file: {
          url: "https://api.rendobar.com/v/job_1/tok/master.m3u8",
          path: "master.m3u8",
          type: "playlist",
          size: 512,
        },
        files: [
          { url: "https://api.rendobar.com/v/job_1/tok/seg0.ts", path: "seg0.ts", type: "video", size: 1000 },
          { url: "https://api.rendobar.com/v/job_1/tok/seg1.ts", path: "seg1.ts", type: "video", size: 1000 },
        ],
        expiresAt: 123,
      },
    });
    expect(r.output?.file?.type).toBe("playlist");
    expect(r.output?.file?.url).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
    expect(r.output?.files.length).toBe(2);
  });

  it("reads a set output (no headline file, multiple files)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        data: null,
        file: null,
        files: [
          { url: "https://api.rendobar.com/v/job_2/tok/a.png", path: "a.png", type: "image", size: 100 },
          { url: "https://api.rendobar.com/v/job_2/tok/b.png", path: "b.png", type: "image", size: 100 },
        ],
        expiresAt: 123,
      },
    });
    expect(r.output?.file).toBeNull();
    expect(r.output?.files.length).toBe(2);
    expect(r.output?.files[0]?.path).toBe("a.png");
  });

  it("reads a data-only output (data non-null, no files)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        data: { duration: 12.5, streams: 2 },
        file: null,
        files: [],
        expiresAt: null,
      },
    });
    expect(r.output?.data).toEqual({ duration: 12.5, streams: 2 });
    expect(r.output?.file).toBeNull();
    expect(r.output?.files.length).toBe(0);
    expect(r.output?.expiresAt).toBeNull();
  });

  it("ignores a malformed output object (no files array)", () => {
    const r = buildResult("complete", undefined, {
      output: { data: null, file: null },
    });
    expect(r.output).toBeUndefined();
  });

  it("leaves output undefined when absent", () => {
    const r = buildResult("complete", undefined, {});
    expect(r.output).toBeUndefined();
  });

  it("surfaces a structured error (code + message + detail) on failure", () => {
    const r = buildResult("failed", undefined, {
      error: {
        code: "PROVIDER_ERROR",
        message: "Job failed",
        detail: "frame= 100\n[error] Conversion failed!",
        retryable: false,
      },
    });
    expect(r.error?.code).toBe("PROVIDER_ERROR");
    expect(r.error?.message).toBe("Job failed");
    expect(r.error?.detail).toContain("Conversion failed!");
    expect(r.error?.retryable).toBe(false);
  });

  it("defaults error.detail to null when absent", () => {
    const r = buildResult("failed", undefined, {
      error: { code: "TIMEOUT", message: "Job failed", retryable: true },
    });
    expect(r.error?.detail).toBeNull();
    expect(r.error?.retryable).toBe(true);
  });

  it("ignores a malformed error object", () => {
    const r = buildResult("failed", undefined, { error: { message: 42 } });
    expect(r.error).toBeUndefined();
  });
});

describe("outputUrl", () => {
  it("returns the headline file url for a single file", () => {
    expect(
      outputUrl({
        data: null,
        file: { url: "https://cdn.rendobar.com/jobs/job_1/output.mp4", path: "output.mp4", type: "video", size: 1 },
        files: [{ url: "https://cdn.rendobar.com/jobs/job_1/output.mp4", path: "output.mp4", type: "video", size: 1 }],
        expiresAt: null,
      }),
    ).toBe("https://cdn.rendobar.com/jobs/job_1/output.mp4");
  });

  it("returns the manifest url for a stream", () => {
    expect(
      outputUrl({
        data: null,
        file: { url: "https://api.rendobar.com/v/job_1/tok/master.m3u8", path: "master.m3u8", type: "playlist", size: 1 },
        files: [{ url: "https://api.rendobar.com/v/job_1/tok/seg0.ts", path: "seg0.ts", type: "video", size: 1 }],
        expiresAt: null,
      }),
    ).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
  });

  it("falls back to the first file url for a set (no headline file)", () => {
    expect(
      outputUrl({
        data: null,
        file: null,
        files: [
          { url: "https://api.rendobar.com/v/job_2/tok/a.png", path: "a.png", type: "image", size: 1 },
          { url: "https://api.rendobar.com/v/job_2/tok/b.png", path: "b.png", type: "image", size: 1 },
        ],
        expiresAt: null,
      }),
    ).toBe("https://api.rendobar.com/v/job_2/tok/a.png");
  });

  it("returns undefined for a data-only output (no files)", () => {
    expect(
      outputUrl({ data: { ok: true }, file: null, files: [], expiresAt: null }),
    ).toBeUndefined();
  });
});

// ── Local download (behaves like a local tool) ─────────────────

describe("downloadUrlToFile — single file to a named local path", () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockBody(map: Record<string, string>): void {
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      const body = map[url];
      if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof globalThis.fetch;
  }

  it("fetches the signed url and writes to the exact local path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-dl-"));
    mockBody({ "https://signed.example/out.mp4": "VIDEO_BYTES" });

    const target = path.join(tmpDir, "out.mp4");
    await downloadUrlToFile("https://signed.example/out.mp4", target);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("VIDEO_BYTES");
  });

  it("throws on a non-ok response", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-dl-"));
    mockBody({});
    await expect(
      downloadUrlToFile("https://signed.example/missing.mp4", path.join(tmpDir, "x.mp4")),
    ).rejects.toThrow();
  });
});

describe("downloadFilesToDir — set/stream into a local folder", () => {
  const realFetch = globalThis.fetch;
  let tmpDir: string;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockBody(map: Record<string, string>): void {
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      const body = map[url];
      if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof globalThis.fetch;
  }

  it("downloads every file of a set, preserving each path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-set-"));
    const files: JobFile[] = [
      { url: "https://signed.example/a.png", path: "a.png", type: "image", size: 1 },
      { url: "https://signed.example/b.png", path: "b.png", type: "image", size: 1 },
    ];
    mockBody({ "https://signed.example/a.png": "A", "https://signed.example/b.png": "B" });

    const written = await downloadFilesToDir(files, tmpDir);

    expect(written.length).toBe(2);
    expect(fs.readFileSync(path.join(tmpDir, "a.png"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(tmpDir, "b.png"), "utf8")).toBe("B");
  });

  it("downloads a stream manifest + segments so it plays locally", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-hls-"));
    const files: JobFile[] = [
      { url: "https://signed.example/master.m3u8", path: "master.m3u8", type: "playlist", size: 1 },
      { url: "https://signed.example/seg0.ts", path: "seg0.ts", type: "video", size: 1 },
      { url: "https://signed.example/seg1.ts", path: "seg1.ts", type: "video", size: 1 },
    ];
    mockBody({
      "https://signed.example/master.m3u8": "#EXTM3U",
      "https://signed.example/seg0.ts": "S0",
      "https://signed.example/seg1.ts": "S1",
    });

    const written = await downloadFilesToDir(files, tmpDir);

    expect(written.length).toBe(3);
    expect(fs.readFileSync(path.join(tmpDir, "master.m3u8"), "utf8")).toBe("#EXTM3U");
    expect(fs.existsSync(path.join(tmpDir, "seg0.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "seg1.ts"))).toBe(true);
  });

  it("preserves nested relative paths and creates subdirs", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-nested-"));
    const files: JobFile[] = [
      { url: "https://signed.example/v/720p/seg0.ts", path: "720p/seg0.ts", type: "video", size: 1 },
    ];
    mockBody({ "https://signed.example/v/720p/seg0.ts": "NESTED" });

    const written = await downloadFilesToDir(files, tmpDir);

    expect(written.length).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "720p", "seg0.ts"), "utf8")).toBe("NESTED");
  });

  it("falls back to the url basename when a file has no path", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-nopath-"));
    const files: JobFile[] = [
      { url: "https://signed.example/cdn/frame_001.png", path: "", type: "image", size: 1 },
    ];
    mockBody({ "https://signed.example/cdn/frame_001.png": "PNG" });

    const written = await downloadFilesToDir(files, tmpDir);

    expect(written.length).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, "frame_001.png"), "utf8")).toBe("PNG");
  });
});
