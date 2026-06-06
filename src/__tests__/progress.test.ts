import { describe, it, expect } from "bun:test";
import { buildResult, outputUrl } from "../lib/progress.js";

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
