import { describe, it, expect } from "bun:test";
import { parseFfmpegArgs } from "../lib/parse-ffmpeg-args.js";

describe("parseFfmpegArgs", () => {
  it("extracts single URL input and output filename", () => {
    const result = parseFfmpegArgs(["-i", "https://example.com/video.mp4", "-vf", "scale=1280:720", "output.mp4"]);
    expect(result.inputs).toEqual([{ index: 1, value: "https://example.com/video.mp4", isLocal: false }]);
    expect(result.outputFile).toBe("output.mp4");
    expect(result.errors).toEqual([]);
  });

  it("detects local file input", () => {
    const result = parseFfmpegArgs(["-i", "./video.mp4", "output.mp4"]);
    expect(result.inputs[0]!.isLocal).toBe(true);
  });

  it("handles multiple inputs", () => {
    const result = parseFfmpegArgs(["-i", "./video.mp4", "-i", "./audio.mp3", "output.mp4"]);
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]!.value).toBe("./video.mp4");
    expect(result.inputs[1]!.value).toBe("./audio.mp3");
  });

  it("detects no output when -f null -", () => {
    const result = parseFfmpegArgs(["-i", "https://example.com/v.mp4", "-f", "null", "-"]);
    expect(result.outputFile).toBeNull();
  });

  it("rejects pipe:0 input", () => {
    const result = parseFfmpegArgs(["-i", "pipe:0", "output.mp4"]);
    expect(result.errors).toContain("Pipe input (pipe:0) not supported in cloud mode. Use a file path or URL.");
  });

  it("rejects pipe: input", () => {
    const result = parseFfmpegArgs(["-i", "pipe:", "output.mp4"]);
    expect(result.errors[0]).toContain("Pipe input");
  });

  it("rejects /dev/stdin input", () => {
    const result = parseFfmpegArgs(["-i", "/dev/stdin", "output.mp4"]);
    expect(result.errors[0]).toContain("Pipe input");
  });

  it("returns empty inputs error when no -i flag", () => {
    const result = parseFfmpegArgs(["-vf", "scale=1280:720", "output.mp4"]);
    expect(result.errors).toContain("No input files. FFmpeg requires at least one -i flag.");
  });

  it("returns empty when no args", () => {
    const result = parseFfmpegArgs([]);
    expect(result.isEmpty).toBe(true);
  });

  it("handles complex filter_complex with multiple inputs", () => {
    const result = parseFfmpegArgs(["-i", "bg.mp4", "-i", "overlay.png", "-filter_complex", "[0:v][1:v]overlay=10:10", "output.mp4"]);
    expect(result.inputs).toHaveLength(2);
    expect(result.outputFile).toBe("output.mp4");
  });

  it("does not falsely detect output in flag value", () => {
    const result = parseFfmpegArgs(["-i", "input.mp4", "-metadata", "title=test.mp4", "real-output.mp4"]);
    expect(result.outputFile).toBe("real-output.mp4");
  });

  it("detects various output extensions", () => {
    for (const ext of ["mkv", "webm", "mov", "mp3", "wav", "gif", "png"]) {
      const result = parseFfmpegArgs(["-i", "input.mp4", `output.${ext}`]);
      expect(result.outputFile).toBe(`output.${ext}`);
    }
  });

  it("mixes local and URL inputs", () => {
    const result = parseFfmpegArgs(["-i", "https://example.com/bg.mp4", "-i", "./logo.png", "output.mp4"]);
    expect(result.inputs[0]!.isLocal).toBe(false);
    expect(result.inputs[1]!.isLocal).toBe(true);
  });
});
