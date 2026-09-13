import { describe, it, expect } from "bun:test";
import { runCommand, type CommandDef, type SubCommandsDef } from "citty";
import { instrumentCommands } from "../lib/telemetry.js";

// Dispatch through citty's real runCommand, the same way `rb <args>` does in
// main.ts, so these tests prove the wrapping survives citty's own resolution
// of nested subCommands instead of a hand-rolled stand-in for it.
async function dispatch(subs: SubCommandsDef, rawArgs: string[]): Promise<void> {
  const root: CommandDef = { subCommands: subs };
  await runCommand(root, { rawArgs });
}

describe("instrumentCommands", () => {
  it("wraps a top-level command's run and captures once under its own name", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const subs: SubCommandsDef = {
      ffmpeg: { run: async () => "ok" },
    };
    const wrapped = instrumentCommands(subs, "", async (command, success, durationMs) => {
      calls.push([command, success, durationMs]);
    });
    await dispatch(wrapped, ["ffmpeg"]);
    expect(calls).toEqual([["ffmpeg", true, expect.any(Number)]]);
  });

  it("wraps a nested subcommand's run and captures once as `parent child`", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const subs: SubCommandsDef = {
      storage: {
        meta: { name: "storage" },
        subCommands: {
          list: { run: async () => "listed" },
          ls: { run: async () => "ls'd" },
        },
      },
    };
    const wrapped = instrumentCommands(subs, "", async (command, success, durationMs) => {
      calls.push([command, success, durationMs]);
    });

    await dispatch(wrapped, ["storage", "list"]);
    await dispatch(wrapped, ["storage", "ls"]);

    expect(calls).toEqual([
      ["storage list", true, expect.any(Number)],
      ["storage ls", true, expect.any(Number)],
    ]);
  });

  it("does not capture for a parent command that has no run of its own", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const subs: SubCommandsDef = {
      storage: {
        subCommands: { list: { run: async () => "listed" } },
      },
    };
    const wrapped = instrumentCommands(subs, "", async (command, success, durationMs) => {
      calls.push([command, success, durationMs]);
    });
    // Dispatching to `storage` alone (no leaf picked, no run of its own)
    // is a citty "No command specified" error, not a captured event.
    await expect(dispatch(wrapped, ["storage"])).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("captures success=false and rethrows when the wrapped run throws", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const subs: SubCommandsDef = {
      ffmpeg: {
        run: async () => {
          throw new Error("boom");
        },
      },
    };
    const wrapped = instrumentCommands(subs, "", async (command, success, durationMs) => {
      calls.push([command, success, durationMs]);
    });
    await expect(dispatch(wrapped, ["ffmpeg"])).rejects.toThrow("boom");
    expect(calls).toEqual([["ffmpeg", false, expect.any(Number)]]);
  });

  it("recurses generically through arbitrary depth, not just `storage`", async () => {
    const calls: Array<[string, boolean, number]> = [];
    const subs: SubCommandsDef = {
      foo: {
        subCommands: {
          bar: {
            subCommands: {
              baz: { run: async () => "deep" },
            },
          },
        },
      },
    };
    const wrapped = instrumentCommands(subs, "", async (command, success, durationMs) => {
      calls.push([command, success, durationMs]);
    });
    await dispatch(wrapped, ["foo", "bar", "baz"]);
    expect(calls).toEqual([["foo bar baz", true, expect.any(Number)]]);
  });
});
