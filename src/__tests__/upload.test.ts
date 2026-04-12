import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { uploadLocalFiles } from "../lib/upload.js";

describe("uploadLocalFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-upload-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTempFile(name: string, content = "fake"): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("uploads local files and replaces paths in args", async () => {
    const localPath = createTempFile("video.mp4");
    const mockUpload = mock(() => Promise.resolve({ downloadUrl: "https://cdn.rendobar.com/uploads/abc123.mp4" }));
    const mockClient = { uploads: { upload: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const args = ["-i", localPath, "-vf", "scale=1280:720", "output.mp4"];
    const inputs = [{ index: 1, value: localPath, isLocal: true }];

    const result = await uploadLocalFiles(args, inputs, mockClient);

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(result[1]).toBe("https://cdn.rendobar.com/uploads/abc123.mp4");
    expect(result[0]).toBe("-i");
    expect(result[2]).toBe("-vf");
  });

  it("uploads multiple files and replaces all paths", async () => {
    const pathA = createTempFile("a.mp4");
    const pathB = createTempFile("b.mp3");
    let callCount = 0;
    const mockUpload = mock(async () => {
      callCount++;
      return { downloadUrl: `https://cdn.rendobar.com/uploads/file${callCount}.mp4` };
    });
    const mockClient = { uploads: { upload: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const args = ["-i", pathA, "-i", pathB, "output.mp4"];
    const inputs = [
      { index: 1, value: pathA, isLocal: true },
      { index: 3, value: pathB, isLocal: true },
    ];

    const result = await uploadLocalFiles(args, inputs, mockClient);

    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(result[1]).toContain("cdn.rendobar.com");
    expect(result[3]).toContain("cdn.rendobar.com");
  });

  it("skips URL inputs (no upload needed)", async () => {
    const mockUpload = mock(() => Promise.resolve({ downloadUrl: "" }));
    const mockClient = { uploads: { upload: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const args = ["-i", "https://example.com/video.mp4", "output.mp4"];
    const inputs = [{ index: 1, value: "https://example.com/video.mp4", isLocal: false }];

    const result = await uploadLocalFiles(args, inputs, mockClient);

    expect(mockUpload).not.toHaveBeenCalled();
    expect(result[1]).toBe("https://example.com/video.mp4");
  });

  it("throws when local file does not exist", async () => {
    const mockUpload = mock(() => Promise.resolve({ downloadUrl: "" }));
    const mockClient = { uploads: { upload: mockUpload } } as unknown as Parameters<typeof uploadLocalFiles>[2];

    const args = ["-i", "/nonexistent/file.mp4", "output.mp4"];
    const inputs = [{ index: 1, value: "/nonexistent/file.mp4", isLocal: true }];

    await expect(uploadLocalFiles(args, inputs, mockClient)).rejects.toThrow("File not found");
  });
});
