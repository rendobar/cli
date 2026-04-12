const OUTPUT_EXTENSIONS = new Set([
  "mp4", "mkv", "webm", "mov", "avi", "ts",
  "gif", "png", "jpg", "jpeg",
  "mp3", "wav", "flac", "ogg", "aac", "opus", "m4a",
  "srt", "vtt",
]);

const PIPE_PATTERNS = ["pipe:0", "pipe:", "/dev/stdin"];

const FLAGS_WITH_VALUE = new Set([
  "-f", "-c", "-c:v", "-c:a", "-b:v", "-b:a", "-r", "-s", "-ar", "-ac",
  "-preset", "-crf", "-qp", "-g", "-bf", "-maxrate", "-bufsize", "-profile",
  "-level", "-pix_fmt", "-t", "-ss", "-to", "-vf", "-af", "-filter_complex",
  "-map", "-metadata", "-disposition", "-threads", "-movflags", "-tag:v",
  "-sample_fmt", "-channel_layout", "-acodec", "-vcodec", "-scodec",
]);

export interface ParsedInput {
  index: number;
  value: string;
  isLocal: boolean;
}

export interface ParseResult {
  inputs: ParsedInput[];
  outputFile: string | null;
  errors: string[];
  isEmpty: boolean;
}

export function parseFfmpegArgs(args: string[]): ParseResult {
  if (args.length === 0) {
    return { inputs: [], outputFile: null, errors: [], isEmpty: true };
  }

  const inputs: ParsedInput[] = [];
  const errors: string[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "-i" && i + 1 < args.length) {
      const value = args[i + 1]!;
      consumed.add(i);
      consumed.add(i + 1);

      if (PIPE_PATTERNS.some((p) => value.startsWith(p))) {
        errors.push(`Pipe input (${value}) not supported in cloud mode. Use a file path or URL.`);
        i++;
        continue;
      }

      const isLocal = !value.startsWith("http://") && !value.startsWith("https://");
      inputs.push({ index: i + 1, value, isLocal });
      i++;
      continue;
    }

    if (arg.startsWith("-") && FLAGS_WITH_VALUE.has(arg) && i + 1 < args.length) {
      consumed.add(i);
      consumed.add(i + 1);
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      consumed.add(i);
    }
  }

  let outputFile: string | null = null;
  const lastThree = args.slice(-3).join(" ");
  if (!lastThree.endsWith("-f null -")) {
    for (let i = args.length - 1; i >= 0; i--) {
      if (consumed.has(i)) continue;
      const arg = args[i]!;
      if (arg === "-" || arg.startsWith("-")) continue;
      const dotIndex = arg.lastIndexOf(".");
      if (dotIndex > 0) {
        const ext = arg.slice(dotIndex + 1).toLowerCase();
        if (OUTPUT_EXTENSIONS.has(ext)) {
          outputFile = arg;
          break;
        }
      }
    }
  }

  if (inputs.length === 0 && errors.length === 0) {
    errors.push("No input files. FFmpeg requires at least one -i flag.");
  }

  return { inputs, outputFile, errors, isEmpty: false };
}
