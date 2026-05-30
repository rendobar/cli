import { describe, it, expect } from "bun:test";

async function runRb(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1", NO_UNICODE: "1", RB_NO_UPDATE_CHECK: "1", RENDOBAR_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("rb welcome wiring", () => {
  it("bare `rb` prints the welcome to stdout, exit 0", async () => {
    const { code, stdout } = await runRb([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rendobar");
    expect(stdout).toContain("CORE");
  }, 20000);

  it("`rb --help` prints welcome + FLAGS, exit 0", async () => {
    const { code, stdout } = await runRb(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("FLAGS");
    expect(stdout).toContain("--json");
  }, 20000);

  it("`rb --json` emits JSON with a commands array, exit 0", async () => {
    const { code, stdout } = await runRb(["--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(stdout);
    expect(Array.isArray(obj.commands)).toBe(true);
  }, 20000);

  it("`rb --quiet` prints nothing, exit 0", async () => {
    const { code, stdout } = await runRb(["--quiet"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
  }, 20000);

  it("unknown command errors to stderr, exit 2", async () => {
    const { code, stderr } = await runRb(["bogus"]);
    expect(code).toBe(2);
    expect(stderr.toLowerCase()).toContain("unknown command");
  }, 20000);

  it("`rb help` prints the welcome, exit 0", async () => {
    const { code, stdout } = await runRb(["help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Rendobar");
  }, 20000);

  it("stray ffmpeg flags hint at `rb ffmpeg`, exit 2", async () => {
    const { code, stderr } = await runRb(["-i", "in.mp4", "out.mp4"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Did you mean: rb ffmpeg");
  }, 20000);

  it("valid ffmpeg subcommand is NOT misread as unknown", async () => {
    // `ffmpeg` first positional must dispatch to the ffmpeg command (which will
    // fail later for its own reasons), NOT trigger unknown-command/hint at exit 2 from main.
    const { stderr } = await runRb(["ffmpeg", "--help"]);
    expect(stderr).not.toContain("unknown command");
    expect(stderr).not.toContain("Did you mean");
  }, 20000);
});
