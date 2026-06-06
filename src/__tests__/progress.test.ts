import { describe, it, expect } from "bun:test";
import { buildResult, outputUrl } from "../lib/progress.js";

describe("buildResult — discriminated output", () => {
  it("reads a file output (download url + meta)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        kind: "file",
        url: "https://cdn.rendobar.com/jobs/job_1/output.mp4",
        expiresAt: 123,
        poster: null,
        meta: { format: "mp4", width: 1280, height: 720, sizeBytes: 4096 },
      },
    });
    expect(r.output?.kind).toBe("file");
    if (r.output?.kind === "file") {
      expect(r.output.url).toBe("https://cdn.rendobar.com/jobs/job_1/output.mp4");
      expect(r.output.poster).toBeNull();
      expect(r.output.meta.width).toBe(1280);
    }
    expect(r.error).toBeUndefined();
  });

  it("reads a stream output (HLS playlist)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        kind: "stream",
        url: "https://api.rendobar.com/v/job_1/tok/master.m3u8",
        manifest: "hls",
        baseUrl: "https://api.rendobar.com/v/job_1/tok/",
        expiresAt: 123,
        fileCount: 7,
        files: [],
        manifestUrl: "https://api.rendobar.com/v/job_1/tok/_manifest.json",
      },
    });
    expect(r.output?.kind).toBe("stream");
    if (r.output?.kind === "stream") {
      expect(r.output.url).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
      expect(r.output.manifest).toBe("hls");
      expect(r.output.fileCount).toBe(7);
    }
  });

  it("reads a set output (no entry url)", () => {
    const r = buildResult("complete", undefined, {
      output: {
        kind: "set",
        baseUrl: "https://api.rendobar.com/v/job_2/tok/",
        expiresAt: 123,
        fileCount: 120,
        files: [],
        manifestUrl: "https://api.rendobar.com/v/job_2/tok/_manifest.json",
      },
    });
    expect(r.output?.kind).toBe("set");
    if (r.output?.kind === "set") {
      expect(r.output.baseUrl).toBe("https://api.rendobar.com/v/job_2/tok/");
      expect(r.output.fileCount).toBe(120);
    }
  });

  it("ignores a malformed output object", () => {
    const r = buildResult("complete", undefined, {
      output: { kind: "bogus", baseUrl: 42 },
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
  it("returns the download url for a file", () => {
    expect(
      outputUrl({
        kind: "file",
        url: "https://cdn.rendobar.com/jobs/job_1/output.mp4",
        poster: null,
        meta: {},
      }),
    ).toBe("https://cdn.rendobar.com/jobs/job_1/output.mp4");
  });

  it("returns the entry playlist for a stream", () => {
    expect(
      outputUrl({
        kind: "stream",
        url: "https://api.rendobar.com/v/job_1/tok/master.m3u8",
        manifest: "hls",
        baseUrl: "https://api.rendobar.com/v/job_1/tok/",
        fileCount: 7,
        manifestUrl: "https://api.rendobar.com/v/job_1/tok/_manifest.json",
      }),
    ).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
  });

  it("falls back to the base url for a set (no entry url)", () => {
    expect(
      outputUrl({
        kind: "set",
        baseUrl: "https://api.rendobar.com/v/job_2/tok/",
        fileCount: 120,
        manifestUrl: "https://api.rendobar.com/v/job_2/tok/_manifest.json",
      }),
    ).toBe("https://api.rendobar.com/v/job_2/tok/");
  });
});
