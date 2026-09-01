/**
 * `rb prompt` -- Print the AI integration prompt.
 *
 * The prompt is the copy-paste text a user hands to Claude, ChatGPT, or Cursor
 * to integrate Rendobar into their codebase. The live copy at
 * https://rendobar.com/prompts/integrate.md is fetched first (short timeout) so
 * users always get the latest text; the bundled fallback below covers offline
 * and air-gapped runs.
 */
import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import pc from "picocolors";

export const PROMPT_URL = "https://rendobar.com/prompts/integrate.md";
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Bundled fallback copy of the integration prompt.
 *
 * Canonical source: `packages/shared/src/constants/integration-prompt.ts` in
 * the rendobar/rendobar monorepo (`buildIntegrationPrompt()`, constants
 * interpolated). When the template changes there, re-render it and paste the
 * output here verbatim.
 */
export const FALLBACK_PROMPT = `# Add Rendobar to this project

You are integrating Rendobar (https://rendobar.com), a media processing and AI generation API, into this codebase. These instructions supersede anything you remember about Rendobar. Work from the live sources below, not from memory.

Live sources of truth:
- Job catalog: GET https://api.rendobar.com/jobs/types (public, no auth). Per-type parameters AND the media each type reads: GET https://api.rendobar.com/jobs/types/{type}/schema (the \`inputs\` object names each media input, whether it takes a URL or a list, and whether the type accepts any filename)
- OpenAPI 3.1 spec: https://api.rendobar.com/openapi.json
- Capability map: https://rendobar.com/llms.txt
- Docs text for AI: https://rendobar.com/docs/llms-full.txt (human docs at https://rendobar.com/docs)
- Error reference: https://rendobar.com/docs/support/errors

API key rules, follow exactly:
- I created an API key in the Rendobar dashboard. Ask me to put it in this project's env as RENDOBAR_API_KEY, in a gitignored env file, and wait for my confirmation before running anything that calls the API.
- Never ask me to paste the key into this chat. Never print, log, or commit it. Never put it in client-side code.

Step 0, detect the stack before writing code:
- Inspect the project (package.json, requirements.txt, go.mod, composer.json, Gemfile). JavaScript or TypeScript: use the official SDK, @rendobar/sdk. Anything else: call the REST API directly using the OpenAPI spec above. Same endpoints, same shapes.
- If the project is empty, ask me which stack I want.

Steps (SDK path; mirror with plain HTTP on the REST path):
1. Install @rendobar/sdk. Create the client with createClient({ apiKey: process.env.RENDOBAR_API_KEY }).
2. Read the live job catalog and pick the job types this project needs from what it actually lists. Do not invent job types or parameters.
3. Submit with client.jobs.create({ type, inputs, params }). Media inputs are URLs. Pass an idempotencyKey anywhere a retry could double-submit.
4. Results: client.jobs.wait(job.id) is fine for scripts. For a production server, use webhooks: ask me to add an endpoint at https://app.rendobar.com/webhooks, then verify signatures with verifyWebhook from "@rendobar/sdk/webhooks".
5. Handle errors by machine code (error.code), never message text. INSUFFICIENT_CREDITS: tell me to top up at https://app.rendobar.com/billing. RATE_LIMITED: retry with backoff. Full list in the error reference.
6. Local files: upload through the assets flow (POST https://api.rendobar.com/assets, documented in the docs), then pass the returned asset url as the job input.
7. Definition of done: a runnable check that submits an ffprobe job on https://cdn.rendobar.com/assets/examples/sample.mp4 and prints the result. Read that job type's schema first, its parameters are not the same as every other type. Show me the one command that runs it. On a 401, check both causes before reporting: the key may not be reaching the process env, or the key itself may be invalid for this API (revoked, mistyped, or issued for a different environment such as staging). Tell me which one it is.

Hard rules:
- The API base is https://api.rendobar.com with no version prefix. There is no batch endpoint. One job produces one output.
- Additive changes only. Do not refactor or remove unrelated code.
- When something is ambiguous, choose the smallest default that keeps the app compiling and tell me what you chose. Ask me only when it is a product decision.

If I am talking to you inside an MCP-capable client (Claude, Cursor, and others), also offer to connect Rendobar's MCP server for running jobs in conversation: https://api.rendobar.com/mcp over OAuth, or npx -y @rendobar/mcp with the key read from env. That is separate from the codebase integration above.
`;

/**
 * Fetch the live prompt, falling back to the bundled copy on any failure:
 * network error, timeout, non-2xx, or a body that is clearly not the prompt
 * (e.g. an HTML error page from a misconfigured edge).
 */
export async function resolvePrompt(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(PROMPT_URL, {
      headers: { Accept: "text/markdown, text/plain" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return FALLBACK_PROMPT;
    const text = (await res.text()).trim();
    // Sanity gate: the real prompt always names the brand and the env var.
    if (text.length === 0 || !text.includes("Rendobar") || !text.includes("RENDOBAR_API_KEY")) {
      return FALLBACK_PROMPT;
    }
    return text;
  } catch {
    return FALLBACK_PROMPT;
  }
}

/** Native clipboard writers to try, in order, for a platform. */
export function clipboardCommands(platform: NodeJS.Platform): Array<{ cmd: string; args: string[] }> {
  switch (platform) {
    case "win32":
      return [{ cmd: "clip", args: [] }];
    case "darwin":
      return [{ cmd: "pbcopy", args: [] }];
    default:
      // Linux and BSDs: Wayland first, then the two X11 staples.
      return [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

function tryClipboardCommand(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", () => resolve(false)); // spawn failure (command not found)
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => {}); // EPIPE if the tool exits early; close handler decides
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      resolve(false);
    }
  });
}

/** Copy text to the system clipboard via native tools. Never throws. */
export async function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  for (const { cmd, args } of clipboardCommands(platform)) {
    if (await tryClipboardCommand(cmd, args, text)) return true;
  }
  return false;
}

export default defineCommand({
  meta: {
    name: "prompt",
    description: "Print the AI integration prompt (paste into Claude, ChatGPT, or Cursor)",
  },
  args: {
    copy: { type: "boolean", description: "Also copy the prompt to the clipboard", default: false },
  },
  async run({ args }) {
    const prompt = await resolvePrompt();
    process.stdout.write(prompt + "\n");

    if (args.copy) {
      const copied = await copyToClipboard(prompt);
      if (copied) {
        process.stderr.write(`  ${pc.green("✓")} Copied to clipboard.\n`);
      } else {
        process.stderr.write(`  ${pc.yellow("!")} Could not copy to clipboard (no clipboard tool found). The prompt is printed above.\n`);
      }
    }
  },
});
