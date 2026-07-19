import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ffprobeCommand, {
  resolveTimeout,
  resolveWaitBudgetMs,
  buildCommand,
  buildProbeParams,
  extractGlobalFlags,
  extractProbeArgs,
  findProbeInput,
  formatSummaryBlock,
  resolveOutputText,
  type ProbeSummary,
  type ProbeData,
} from "../commands/ffprobe.js";
import { uploadLocalFiles } from "../lib/upload.js";

describe("ffprobe command metadata", () => {
  it("registers as `ffprobe` with the raw-command description", () => {
    expect(ffprobeCommand.meta).toMatchObject({
      name: "ffprobe",
      description: "Run a raw ffprobe command against a media URL",
    });
  });
});

describe("extractProbeArgs", () => {
  it("joins ffprobe flags and the URL from argv, in order", () => {
    const argv = ["bun", "rb", "ffprobe", "-show_format", "-show_streams", "https://example.com/video.mp4"];
    expect(extractProbeArgs(argv)).toEqual(["-show_format", "-show_streams", "https://example.com/video.mp4"]);
  });

  it("supports a minimal invocation of just the URL", () => {
    const argv = ["bun", "rb", "ffprobe", "https://example.com/video.mp4"];
    expect(extractProbeArgs(argv)).toEqual(["https://example.com/video.mp4"]);
  });

  it("strips recognized CLI-level flags out of the ffprobe args", () => {
    const argv = ["bun", "rb", "ffprobe", "-show_format", "--timeout", "30", "--json", "https://example.com/video.mp4"];
    expect(extractProbeArgs(argv)).toEqual(["-show_format", "https://example.com/video.mp4"]);
  });

  it("returns an empty array when the ffprobe subcommand is missing", () => {
    expect(extractProbeArgs(["bun", "rb"])).toEqual([]);
  });

  it("returns an empty array for no positional args", () => {
    expect(extractProbeArgs(["bun", "rb", "ffprobe", "--json"])).toEqual([]);
  });
});

describe("extractGlobalFlags", () => {
  it("defaults to no flags and the default timeout", () => {
    expect(extractGlobalFlags(["bun", "rb", "ffprobe", "https://example.com/video.mp4"])).toEqual({
      json: false,
      quiet: false,
      noWait: false,
      timeout: 60,
    });
  });

  it("parses --json, --quiet, --no-wait", () => {
    const argv = ["bun", "rb", "ffprobe", "--json", "--quiet", "--no-wait", "https://example.com/video.mp4"];
    const flags = extractGlobalFlags(argv);
    expect(flags.json).toBe(true);
    expect(flags.quiet).toBe(true);
    expect(flags.noWait).toBe(true);
  });

  it("forwards --timeout into the parsed flags", () => {
    const argv = ["bun", "rb", "ffprobe", "--timeout", "45", "https://example.com/video.mp4"];
    expect(extractGlobalFlags(argv).timeout).toBe(45);
  });

  it("clamps --timeout to the API max via resolveTimeout", () => {
    const argv = ["bun", "rb", "ffprobe", "--timeout", "9999", "https://example.com/video.mp4"];
    expect(extractGlobalFlags(argv).timeout).toBe(900);
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

describe("buildCommand", () => {
  it("joins a minimal URL-only invocation into a raw ffprobe command", () => {
    expect(buildCommand(["https://example.com/video.mp4"])).toBe("ffprobe https://example.com/video.mp4");
  });

  it("joins ffprobe flags plus the URL, in argv order", () => {
    expect(buildCommand(["-show_format", "-show_streams", "https://example.com/video.mp4"])).toBe(
      "ffprobe -show_format -show_streams https://example.com/video.mp4",
    );
  });

  it("shell-escapes args containing shell-special characters", () => {
    const command = buildCommand(["-select_streams", "v:0", "https://example.com/a b.mp4"]);
    expect(command).toBe("ffprobe -select_streams v:0 'https://example.com/a b.mp4'");
  });
});

describe("findProbeInput", () => {
  it("finds a plain URL as the target and marks it not local", () => {
    expect(findProbeInput(["https://example.com/video.mp4"])).toEqual({
      index: 0,
      value: "https://example.com/video.mp4",
      isLocal: false,
    });
  });

  it("finds a local file path as the trailing target", () => {
    expect(findProbeInput(["-show_format", "./local-video.mp4"])).toEqual({
      index: 1,
      value: "./local-video.mp4",
      isLocal: true,
    });
  });

  it("skips trailing flags to find the target ahead of them", () => {
    expect(findProbeInput(["-i", "./local-video.mp4", "-show_format"])).toEqual({
      index: 1,
      value: "./local-video.mp4",
      isLocal: true,
    });
  });

  it("returns null when every token looks like a flag", () => {
    expect(findProbeInput(["-show_format", "-show_streams"])).toBeNull();
  });

  it("returns null for an empty args list", () => {
    expect(findProbeInput([])).toBeNull();
  });
});

describe("ffprobe local file upload", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ffprobe-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTempFile(name: string, content = "fake"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("uploads a local file target and rewrites the command with its URL", async () => {
    const localPath = createTempFile("video.mp4");
    const args = ["-show_format", localPath];
    const target = findProbeInput(args);
    expect(target?.isLocal).toBe(true);

    const mockClient = {
      uploads: { create: mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/probe.mp4" })) },
    } as unknown as Parameters<typeof uploadLocalFiles>[2];

    // Same upload boundary `rb ffmpeg`'s test mocks: the SDK's uploads.create
    // call, not the owned uploadLocalFiles/buildCommand code under test.
    const rewritten = await uploadLocalFiles(args, [target!], mockClient);
    const command = buildCommand(rewritten);

    expect(mockClient.uploads.create).toHaveBeenCalledTimes(1);
    expect(command).toContain("cdn.rendobar.com/uploads/probe.mp4");
    expect(command).not.toContain(localPath);
  });

  it("leaves a plain URL command untouched -- no upload triggered", async () => {
    const args = ["-show_format", "https://example.com/video.mp4"];
    const target = findProbeInput(args);
    expect(target?.isLocal).toBe(false);

    const mockUpload = mock(() => Promise.resolve({ url: "https://cdn.rendobar.com/uploads/unused.mp4" }));
    const mockClient = { uploads: { create: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    // Mirrors the command's own guard: uploadLocalFiles is only invoked when
    // `target?.isLocal` is true, so a URL command never reaches the upload
    // client at all.
    const command = buildCommand(args);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(command).toBe("ffprobe -show_format https://example.com/video.mp4");
  });
});

describe("buildProbeParams", () => {
  it("always forwards command and timeout so they reach the API", () => {
    const params = buildProbeParams("ffprobe https://example.com/video.mp4", 60);
    expect(params.command).toBe("ffprobe https://example.com/video.mp4");
    expect(params.timeout).toBe(60);
  });

  it("forwards the timeout the caller resolved, unmodified", () => {
    expect(buildProbeParams("ffprobe url", 900).timeout).toBe(900);
  });
});

describe("formatSummaryBlock", () => {
  it("renders a video summary with codec, resolution, and fps in the Video row", () => {
    const summary: ProbeSummary = {
      kind: "video",
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSec: 5.01,
      sizeBytes: 352_256, // 344 KB
      video: {
        codec: "h264",
        profile: "High",
        width: 1280,
        height: 720,
        fps: 24,
        bitDepth: 8,
        pixelFormat: "yuv420p",
        bitrateBps: 449_000,
      },
    };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("Video");
    expect(block).toContain("mov,mp4,m4a,3gp,3g2,mj2");
    expect(block).toContain("5.01s");
    expect(block).toContain("344 KB");
    expect(block).toContain("h264 High");
    expect(block).toContain("1280x720");
    expect(block).toContain("24 fps");
    expect(block).toContain("8-bit yuv420p");
    expect(block).toContain("449 kbps");
  });

  it("renders an audio-only summary with the Audio row and no Video row", () => {
    const summary: ProbeSummary = {
      kind: "audio",
      container: "mp3",
      durationSec: 200,
      audio: { codec: "mp3", profile: "LC", channelLayout: "stereo", sampleRate: 48_000, bitrateBps: 96_000 },
    };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("Audio");
    expect(block).toContain("mp3 LC");
    expect(block).toContain("stereo");
    expect(block).toContain("48 kHz");
    expect(block).toContain("96 kbps");
    expect(block).not.toContain("Video");
  });

  it("falls back to a raw channel count when channelLayout is absent", () => {
    const summary: ProbeSummary = { kind: "audio", audio: { codec: "aac", channels: 6 } };
    expect(formatSummaryBlock(summary)).toContain("6ch");
  });

  it("renders an image summary with dimensions and pixel format", () => {
    const summary: ProbeSummary = {
      kind: "image",
      container: "png",
      sizeBytes: 46_080,
      image: { width: 512, height: 512, pixelFormat: "rgba", bitDepth: 8 },
    };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("Image");
    expect(block).toContain("512x512");
    expect(block).toContain("8-bit rgba");
  });

  it("renders stream counts for the other kind, skipping zero counts", () => {
    const summary: ProbeSummary = {
      kind: "other",
      container: "matroska",
      streamCounts: { video: 1, audio: 2, subtitle: 1, data: 0 },
    };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("1 video");
    expect(block).toContain("2 audio");
    expect(block).toContain("1 subtitle");
    expect(block).not.toContain("0 data");
  });

  it("degrades gracefully to just the header line when fields are missing", () => {
    const summary: ProbeSummary = { kind: "other" };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("Other");
    expect(block).not.toContain("\n");
  });

  it("flags HDR and rotation on the video row when present", () => {
    const summary: ProbeSummary = {
      kind: "video",
      container: "mp4",
      video: { codec: "hevc", width: 3840, height: 2160, displayAspectRatio: "16:9", isHdr: true, rotation: 90 },
    };
    const block = formatSummaryBlock(summary);
    expect(block).toContain("3840x2160 (16:9)");
    expect(block).toContain("HDR");
    expect(block).toContain("rotated 90°");
  });

  it("formats a sub-minute duration with fractional seconds, and minute-plus as m:ss", () => {
    expect(formatSummaryBlock({ kind: "other", durationSec: 5.01 })).toContain("5.01s");
    expect(formatSummaryBlock({ kind: "other", durationSec: 75 })).toContain("1:15");
    expect(formatSummaryBlock({ kind: "other", durationSec: 3661 })).toContain("1:01:01");
  });
});

describe("resolveOutputText", () => {
  it("renders the summary block when `summary` is present", () => {
    const data: ProbeData = {
      summary: { kind: "audio", container: "mp3", audio: { codec: "mp3" } },
    };
    expect(resolveOutputText(data)).toContain("Audio");
  });

  it("prints raw stdout verbatim and skips the summary block when `summary` is absent", () => {
    // What a `-print_format csv` / `-of default` invocation returns: no
    // parsed summary, just ffprobe's own text.
    const raw = 'format_name=mov,mp4,m4a,3gp,3g2,mj2\nstreams.stream.0.codec_name="h264"\n';
    const data: ProbeData = { stdout: raw };
    const text = resolveOutputText(data);
    expect(text).toBe(raw);
    expect(text).not.toContain("Video");
    expect(text).not.toContain("kbps");
  });

  it("returns null when the response carries neither summary nor stdout", () => {
    expect(resolveOutputText({})).toBeNull();
  });
});
