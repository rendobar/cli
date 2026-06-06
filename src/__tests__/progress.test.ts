import { describe, it, expect } from "bun:test";
import { buildResult, servedEntryUrl } from "../lib/progress.js";

describe("buildResult — served output + errorDetail", () => {
  it("reads a single-file outputUrl", () => {
    const r = buildResult("complete", undefined, {
      outputUrl: "https://cdn.rendobar.com/jobs/job_1/output.mp4",
    });
    expect(r.outputUrl).toBe("https://cdn.rendobar.com/jobs/job_1/output.mp4");
    expect(r.output).toBeUndefined();
  });

  it("captures a served stream output (HLS playlist)", () => {
    const r = buildResult("complete", undefined, {
      outputUrl: null,
      output: {
        type: "stream",
        url: "https://api.rendobar.com/v/job_1/tok/master.m3u8",
        playlist: "master.m3u8",
        baseUrl: "https://api.rendobar.com/v/job_1/tok/",
        expiresAt: 123,
        fileCount: 7,
        files: [],
        manifestUrl: "https://api.rendobar.com/v/job_1/tok/_manifest.json",
      },
    });
    expect(r.outputUrl).toBeUndefined();
    expect(r.output?.type).toBe("stream");
    expect(r.output?.url).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
    expect(r.output?.fileCount).toBe(7);
  });

  it("captures a served set output (no entry url)", () => {
    const r = buildResult("complete", undefined, {
      outputUrl: null,
      output: {
        type: "set",
        baseUrl: "https://api.rendobar.com/v/job_2/tok/",
        expiresAt: 123,
        fileCount: 120,
        files: [],
        manifestUrl: "https://api.rendobar.com/v/job_2/tok/_manifest.json",
      },
    });
    expect(r.output?.type).toBe("set");
    expect(r.output?.url).toBeUndefined();
    expect(r.output?.baseUrl).toBe("https://api.rendobar.com/v/job_2/tok/");
    expect(r.output?.fileCount).toBe(120);
  });

  it("ignores a malformed output object", () => {
    const r = buildResult("complete", undefined, {
      output: { type: "bogus", baseUrl: 42 },
    });
    expect(r.output).toBeUndefined();
  });

  it("surfaces errorDetail (ffmpeg stderr tail) on failure", () => {
    const r = buildResult("failed", undefined, {
      errorMessage: "Job failed",
      errorDetail: "frame= 100\n[error] Conversion failed!",
    });
    expect(r.error).toBe("Job failed");
    expect(r.errorDetail).toContain("Conversion failed!");
  });

  it("leaves errorDetail undefined when absent", () => {
    const r = buildResult("failed", undefined, { errorMessage: "Job failed" });
    expect(r.errorDetail).toBeUndefined();
  });
});

describe("servedEntryUrl", () => {
  it("prefers the stream entry url when present", () => {
    expect(
      servedEntryUrl({
        type: "stream",
        url: "https://api.rendobar.com/v/job_1/tok/master.m3u8",
        baseUrl: "https://api.rendobar.com/v/job_1/tok/",
        fileCount: 7,
      }),
    ).toBe("https://api.rendobar.com/v/job_1/tok/master.m3u8");
  });

  it("falls back to the base url for a set (no entry url)", () => {
    expect(
      servedEntryUrl({
        type: "set",
        baseUrl: "https://api.rendobar.com/v/job_2/tok/",
        fileCount: 120,
      }),
    ).toBe("https://api.rendobar.com/v/job_2/tok/");
  });
});
