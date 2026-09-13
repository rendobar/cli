import { describe, it, expect } from "bun:test";
import { parseStorageTarget, formatConnections, formatListing, storageHint, connectionJson } from "../lib/storage-view.js";
import { fmtBytes } from "../lib/progress.js";
import type { StorageConnection } from "@rendobar/sdk";

describe("parseStorageTarget", () => {
  it("accepts an id, an id with a folder, and the storage URI form", () => {
    expect(parseStorageTarget("prod-media")).toEqual({ id: "prod-media", prefix: "" });
    expect(parseStorageTarget("prod-media/raw/2026")).toEqual({ id: "prod-media", prefix: "raw/2026/" });
    expect(parseStorageTarget("storage://prod-media/raw/")).toEqual({ id: "prod-media", prefix: "raw/" });
  });

  it("refuses a target with no id", () => {
    expect(parseStorageTarget("storage:///raw")).toHaveProperty("error");
    expect(parseStorageTarget("")).toHaveProperty("error");
  });
});

describe("formatConnections", () => {
  it("prints one aligned row per connection with what it can do", () => {
    const lines = formatConnections([
      { id: "prod-media", provider: "s3", bucket: "acme-prod-media", defaultDestination: true },
      { id: "raw", provider: "r2", bucket: "raw", access: "read" },
      { id: "new-aws", provider: "s3", bucket: "incoming", pending: true },
    ]);
    expect(lines[0]).toStartWith("ID");
    expect(lines[1]).toContain("default");
    expect(lines[2]).toContain("read only");
    expect(lines[3]).toContain("pending");
    expect(lines[1]?.indexOf("s3")).toBe(lines[2]?.indexOf("r2"));
  });

  it("says where to connect one when there are none", () => {
    expect(formatConnections([])).toEqual(["No storage connected. Connect a bucket at https://app.rendobar.com/storage"]);
  });
});

describe("formatListing", () => {
  it("prints folders, then files with size, date and the URI to pass as an input", () => {
    const lines = formatListing("prod-media", {
      folders: ["raw/2026/"],
      objects: [{ key: "raw/clip.mp4", size: 18_400_000, lastModified: 1_757_000_000_000 }],
    });
    expect(lines[0]).toContain("storage://prod-media/raw/2026/");
    expect(lines[1]).toContain(fmtBytes(18_400_000));
    expect(lines[1]).toContain(new Date(1_757_000_000_000).toISOString().slice(0, 10));
    expect(lines[1]).toContain("storage://prod-media/raw/clip.mp4");
  });
});

describe("connectionJson", () => {
  it("returns exactly the seven client-facing fields, with access and booleans normalized", () => {
    const raw: StorageConnection = {
      id: "prod-media",
      provider: "s3",
      bucket: "acme-prod-media",
      region: "us-east-1",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      pathStyle: false,
      createdAt: 1_757_000_000_000,
      updatedAt: 1_757_000_000_000,
      access: "read",
      accountId: "123456789012",
      projectRef: "proj_abc123",
      pathTemplate: "{date}/{source_name}.{ext}",
      checks: [{ name: "read", status: "passed" }],
      deliverySummary: {
        jobsLast30d: 3,
        bytesLast30d: 1_000,
        lastAt: null,
        lastStatus: null,
        lastReason: null,
      },
      problem: { at: 1_757_000_000_000, message: "temporary outage" },
    };
    expect(connectionJson(raw)).toEqual({
      id: "prod-media",
      provider: "s3",
      bucket: "acme-prod-media",
      region: "us-east-1",
      access: "read",
      pending: false,
      defaultDestination: false,
    });
  });
});

describe("storageHint", () => {
  it("tells a credential without storage access how to get it", () => {
    expect(storageHint("INSUFFICIENT_SCOPE", "This endpoint requires the storage:read scope.")).toContain("rb login");
  });

  it("leaves other messages alone", () => {
    expect(storageHint("NOT_FOUND", 'Storage "x" not found.')).toBe('Storage "x" not found.');
  });
});
