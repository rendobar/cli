import { createClient } from "@rendobar/sdk";

/**
 * Build an SDK client that attributes all CLI traffic as `client=cli`.
 *
 * The SDK defaults the `X-Rendobar-Client` header to "sdk"; wrappers are meant
 * to override it so usage analytics can tell CLI-originated jobs apart from
 * dashboard/sdk/mcp/n8n traffic. Use this everywhere instead of the raw
 * `createClient`.
 */
export function createCliClient(config: Parameters<typeof createClient>[0] = {}) {
  return createClient({ ...config, client: "cli" });
}
