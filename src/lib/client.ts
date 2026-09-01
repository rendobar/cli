import { createClient } from "@rendobar/sdk";
import { VERSION } from "../generated/version.js";

/**
 * Build an SDK client that attributes all CLI traffic as `cli/<version>`.
 *
 * The SDK defaults the `X-Rendobar-Client` header to "sdk"; wrappers are meant
 * to override it so usage analytics can tell CLI-originated jobs apart from
 * dashboard/sdk/mcp/n8n traffic. Use this everywhere instead of the raw
 * `createClient`.
 *
 * The version half matters as much as the name: without it a bug report can say
 * a job came from the CLI but not which build, and this CLI self-updates, so
 * the installed version is exactly the thing nobody can tell you. VERSION is
 * generated from package.json at build time, so it cannot drift.
 */
export function createCliClient(config: Parameters<typeof createClient>[0] = {}) {
  return createClient({ ...config, client: `cli/${VERSION}` });
}
