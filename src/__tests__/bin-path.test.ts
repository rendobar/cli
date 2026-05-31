import { describe, it, expect } from "bun:test";
import { getBinPath } from "../lib/bin-path.js";

describe("getBinPath", () => {
  it("returns process.execPath (the real executable), not argv[0]", () => {
    // In a compiled Bun binary, process.argv[0] is the literal "bun" while
    // process.execPath is the actual rb.exe path. We must use execPath.
    expect(getBinPath()).toBe(process.execPath);
  });

  it("never returns the bare runtime name 'bun'", () => {
    expect(getBinPath()).not.toBe("bun");
  });

  it("returns a non-empty path", () => {
    expect(getBinPath().length).toBeGreaterThan(0);
  });
});
