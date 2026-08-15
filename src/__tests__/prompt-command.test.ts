import { describe, it, expect, mock } from "bun:test";
import promptCommand, {
  PROMPT_URL,
  FALLBACK_PROMPT,
  resolvePrompt,
  clipboardCommands,
} from "../commands/prompt.js";

describe("prompt command metadata", () => {
  it("registers as `prompt` with the paste-into-your-agent description", () => {
    expect(promptCommand.meta).toMatchObject({
      name: "prompt",
      description: "Print the AI integration prompt (paste into Claude, ChatGPT, or Cursor)",
    });
  });
});

describe("FALLBACK_PROMPT", () => {
  it("tells the agent to read the key from env, never from the chat", () => {
    expect(FALLBACK_PROMPT).toContain("RENDOBAR_API_KEY");
    expect(FALLBACK_PROMPT).toContain("Never ask me to paste the key");
  });

  it("points the agent at the live job catalog instead of a baked-in list", () => {
    expect(FALLBACK_PROMPT).toContain("https://api.rendobar.com/jobs/types");
  });

  it("uses only canonical Rendobar URLs", () => {
    expect(FALLBACK_PROMPT).toContain("https://rendobar.com");
    expect(FALLBACK_PROMPT).toContain("https://app.rendobar.com");
    expect(FALLBACK_PROMPT).not.toContain("www.rendobar.com");
  });
});

describe("resolvePrompt", () => {
  const liveText = "# Add Rendobar to this project\n\nRendobar ... RENDOBAR_API_KEY ...";

  function fetchReturning(status: number, body: string): typeof fetch {
    return mock(() =>
      Promise.resolve(new Response(body, { status })),
    ) as unknown as typeof fetch;
  }

  it("returns the fetched text when the live copy responds OK", async () => {
    expect(await resolvePrompt(fetchReturning(200, liveText))).toBe(liveText);
  });

  it("falls back on a non-2xx response", async () => {
    expect(await resolvePrompt(fetchReturning(404, "Not Found"))).toBe(FALLBACK_PROMPT);
  });

  it("falls back on a network error", async () => {
    const failing = mock(() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch;
    expect(await resolvePrompt(failing)).toBe(FALLBACK_PROMPT);
  });

  it("falls back when the body is not the prompt (edge error page)", async () => {
    expect(await resolvePrompt(fetchReturning(200, "<html>site under maintenance</html>"))).toBe(FALLBACK_PROMPT);
  });

  it("falls back on an empty body", async () => {
    expect(await resolvePrompt(fetchReturning(200, "   "))).toBe(FALLBACK_PROMPT);
  });

  it("requests the canonical prompt URL", async () => {
    const spy = mock(() => Promise.resolve(new Response(liveText, { status: 200 })));
    await resolvePrompt(spy as unknown as typeof fetch);
    expect(spy).toHaveBeenCalledTimes(1);
    const firstArg = (spy.mock.calls[0] as unknown[])[0];
    expect(firstArg).toBe(PROMPT_URL);
    expect(PROMPT_URL).toBe("https://rendobar.com/prompts/integrate.md");
  });
});

describe("clipboardCommands", () => {
  it("uses clip on Windows and pbcopy on macOS", () => {
    expect(clipboardCommands("win32")).toEqual([{ cmd: "clip", args: [] }]);
    expect(clipboardCommands("darwin")).toEqual([{ cmd: "pbcopy", args: [] }]);
  });

  it("tries Wayland then X11 tools on Linux", () => {
    expect(clipboardCommands("linux").map((c) => c.cmd)).toEqual(["wl-copy", "xclip", "xsel"]);
  });
});
