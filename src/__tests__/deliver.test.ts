import { describe, it, expect } from "bun:test";
import {
  readDeliverFlags,
  parseDeliveries,
  deliveryLine,
  deliveryExitCode,
  waitForDeliveries,
  finishDeliveries,
  type Delivery,
} from "../lib/deliver.js";

describe("readDeliverFlags", () => {
  it("collects every --deliver in order", () => {
    const argv = ["rb", "ffmpeg", "-i", "a.mp4", "--deliver", "storage://prod-media", "out.mp4", "--deliver", "storage://archive/exports"];
    expect(readDeliverFlags(argv)).toEqual({ destinations: ["storage://prod-media", "storage://archive/exports"], errors: [] });
  });

  it("names a repeated destination once", () => {
    expect(readDeliverFlags(["--deliver", "storage://a", "--deliver", "storage://a"]).destinations).toEqual(["storage://a"]);
  });

  it("refuses a value that is not a storage URI and says where ids come from", () => {
    const r = readDeliverFlags(["--deliver", "s3://bucket/key"]);
    expect(r.destinations).toEqual([]);
    expect(r.errors[0]).toContain("storage://<id>");
    expect(r.errors[0]).toContain("rb storage list");
  });

  it("refuses --deliver with no value, including when a flag follows it", () => {
    expect(readDeliverFlags(["--deliver"]).errors).toHaveLength(1);
    expect(readDeliverFlags(["--deliver", "--json"]).errors).toHaveLength(1);
  });

  it("refuses storage:// with no id", () => {
    expect(readDeliverFlags(["--deliver", "storage:///exports"]).errors).toHaveLength(1);
  });
});

describe("parseDeliveries", () => {
  it("reads the deliveries a job carries", () => {
    const job = { deliveries: [{ storageId: "a", status: "delivered", path: "x.mp4", url: "https://m.example.com/x.mp4", renamed: true }] };
    expect(parseDeliveries(job)).toEqual([{ storageId: "a", status: "delivered", path: "x.mp4", url: "https://m.example.com/x.mp4", renamed: true }]);
  });

  it("is empty for a job with no deliveries, and skips entries that are not whole deliveries", () => {
    expect(parseDeliveries({})).toEqual([]);
    expect(parseDeliveries({ deliveries: "no" })).toEqual([]);
    expect(parseDeliveries({ deliveries: [{ storageId: "a", status: "shipped" }, 3, { status: "failed" }, { storageId: "b", status: "pending" }] })).toEqual([
      { storageId: "b", status: "pending" },
    ]);
  });
});

describe("deliveryLine and deliveryExitCode", () => {
  const delivered: Delivery = { storageId: "prod-media", status: "delivered", path: "exports/clip.mp4" };
  const failed: Delivery = { storageId: "archive", status: "failed", reason: "destination_denied" };
  const pending: Delivery = { storageId: "backup", status: "pending" };

  it("says where each one landed or why it did not", () => {
    expect(deliveryLine(delivered)).toBe("Delivered to storage://prod-media/exports/clip.mp4");
    expect(deliveryLine(failed)).toBe("Not delivered to storage://archive, reason destination_denied");
    expect(deliveryLine(pending)).toContain("storage://backup");
  });

  it("exits 1 unless every delivery landed", () => {
    expect(deliveryExitCode([])).toBe(0);
    expect(deliveryExitCode([delivered])).toBe(0);
    expect(deliveryExitCode([delivered, failed])).toBe(1);
    expect(deliveryExitCode([pending])).toBe(1);
  });
});

describe("waitForDeliveries", () => {
  const pendingA: Delivery[] = [{ storageId: "a", status: "pending" }];

  it("reads the job until nothing is pending", async () => {
    const reads = [{ deliveries: pendingA }, { deliveries: [{ storageId: "a", status: "delivered", path: "x.mp4" }] }];
    let clock = 0;
    const settled = await waitForDeliveries(async () => reads.shift(), pendingA, {
      timeoutMs: 60_000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(settled).toEqual([{ storageId: "a", status: "delivered", path: "x.mp4" }]);
  });

  it("stops at the deadline and returns what it last saw", async () => {
    let clock = 0;
    let reads = 0;
    const settled = await waitForDeliveries(async () => { reads++; return { deliveries: pendingA }; }, pendingA, {
      timeoutMs: 5_000,
      intervalMs: 2_000,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect(settled).toEqual(pendingA);
    expect(reads).toBe(3);
  });
});

describe("finishDeliveries", () => {
  const steps = { step: async (_label: string, fn: () => Promise<unknown>) => fn(), info: () => {} } as never;

  it("returns 0 and reads nothing for a job with no deliveries", async () => {
    let reads = 0;
    const client = { jobs: { get: async () => { reads++; return {}; } } };
    expect(await finishDeliveries(steps, client, "job_1", { deliveries: [] }, { quiet: true })).toBe(0);
    expect(reads).toBe(0);
  });

  it("settles pending deliveries onto the result and returns 1 when one did not land", async () => {
    const client = { jobs: { get: async () => ({ deliveries: [{ storageId: "a", status: "failed", reason: "destination_denied" }] }) } };
    const result: { deliveries: Delivery[] } = { deliveries: [{ storageId: "a", status: "pending" }] };
    expect(await finishDeliveries(steps, client, "job_1", result, { quiet: true, intervalMs: 0 })).toBe(1);
    expect(result.deliveries).toEqual([{ storageId: "a", status: "failed", reason: "destination_denied" }]);
  });
});
