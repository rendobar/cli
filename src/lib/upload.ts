import * as path from "node:path";
import type { RendobarClient } from "@rendobar/sdk";
import type { ParsedInput } from "./parse-ffmpeg-args.js";

export interface UploadCallbacks {
  onFileStart?: (filename: string, size: number, index: number, total: number) => void;
  onFileProgress?: (filename: string, loaded: number, size: number, index: number, total: number) => void;
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

    // sha256 enables server-side dedup: re-uploading the same bytes skips the
    // transfer entirely (the API returns the existing ready asset).
    const checksum = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");

    callbacks?.onFileStart?.(filename, file.size, i, total);
    const asset = await client.uploads.create(new Uint8Array(buffer), {
      filename,
      checksum,
      onProgress: ({ loaded, total: size }) =>
        callbacks?.onFileProgress?.(filename, loaded, size, i, total),
    });
    callbacks?.onFileDone?.(filename, i, total);

    result[input.index] = asset.url;
  }

  return result;
}
