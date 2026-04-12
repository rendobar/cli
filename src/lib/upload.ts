import * as path from "node:path";
import type { RendobarClient } from "@rendobar/sdk";
import type { ParsedInput } from "./parse-ffmpeg-args.js";

export interface UploadCallbacks {
  onFileStart?: (filename: string, size: number, index: number, total: number) => void;
  onFileDone?: (filename: string, index: number, total: number) => void;
}

export async function uploadLocalFiles(
  args: string[],
  inputs: ParsedInput[],
  client: Pick<RendobarClient, "uploads">,
  callbacks?: UploadCallbacks,
): Promise<string[]> {
  const result = [...args];
  const localInputs = inputs.filter((i) => i.isLocal);
  if (localInputs.length === 0) return result;

  // Verify all files exist
  for (const input of localInputs) {
    const file = Bun.file(input.value);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${input.value}`);
    }
  }

  // Upload sequentially so we can show per-file progress
  const total = localInputs.length;
  for (let i = 0; i < localInputs.length; i++) {
    // Guaranteed by loop bound i < localInputs.length
    const input = localInputs[i]!;
    const file = Bun.file(input.value);
    const buffer = await file.arrayBuffer();
    const filename = path.basename(input.value);

    callbacks?.onFileStart?.(filename, file.size, i, total);
    const { downloadUrl } = await client.uploads.upload(new Uint8Array(buffer), { filename });
    callbacks?.onFileDone?.(filename, i, total);

    result[input.index] = downloadUrl;
  }

  return result;
}
