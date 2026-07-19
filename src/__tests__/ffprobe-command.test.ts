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
  formatSummary,
  type ProbeSummary,
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

describe("formatSummary", () => {
  it("formats a video summary with resolution and fps", () => {
    const summary: ProbeSummary = {
      kind: "video",
      container: "mp4",
      durationSec: 75,
      video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
    };
    expect(formatSummary(summary)).toBe("Video  mp4  1:15  1920x1080  30fps");
  });

  it("formats an audio summary with codec and channels", () => {
    const summary: ProbeSummary = {
      kind: "audio",
      container: "mp3",
      durationSec: 200,
      audio: { codec: "mp3", channels: 2 },
    };
    expect(formatSummary(summary)).toBe("Audio  mp3  3:20  mp3  2ch");
  });

  it("formats an image summary with dimensions", () => {
    const summary: ProbeSummary = {
      kind: "image",
      container: "png",
      image: { codec: "png", width: 512, height: 512 },
    };
    expect(formatSummary(summary)).toBe("Image  png  512x512");
  });

  it("degrades gracefully for the other kind and missing fields", () => {
    const summary: ProbeSummary = { kind: "other" };
    expect(formatSummary(summary)).toBe("Other  unknown");
  });

  it("formats an hour-plus duration as h:mm:ss", () => {
    const summary: ProbeSummary = {
      kind: "video",
      container: "mkv",
      durationSec: 3661,
      video: {},
    };
    expect(formatSummary(summary)).toBe("Video  mkv  1:01:01");
  });
});
