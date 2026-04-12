/**
 * `rb whoami` -- Display current authenticated identity.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { createClient } from "@rendobar/sdk";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl } from "../lib/auth.js";

export default defineCommand({
  meta: { name: "whoami", description: "Show current authenticated identity" },
  async run() {
    let cred = resolveAuth();
    if (!cred) {
      process.stderr.write(pc.red("  ✗ Not authenticated. Run `rb login` or set RENDOBAR_API_KEY.\n"));
      process.exit(2);
    }

    // Auto-refresh if OAuth and expired
    if (cred.type === "oauth") {
      try {
        cred = await refreshTokenIfNeeded(cred);
      } catch (err) {
        process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : "Auth error"}\n`));
        process.exit(2);
      }
    }

    const baseUrl = getApiBaseUrl();
    const clientConfig = cred.type === "apikey"
      ? { apiKey: cred.apiKey, baseUrl }
      : { accessToken: cred.accessToken, baseUrl };

    try {
      const client = createClient(clientConfig);
      const state = await client.orgs.current();

      process.stderr.write(`  ${pc.dim("Org")}       ${pc.bold(state.org.name)}\n`);
      process.stderr.write(`  ${pc.dim("Plan")}      ${state.plan.name}\n`);
      process.stderr.write(`  ${pc.dim("Balance")}   ${state.balance.balanceFormatted}\n`);
    } catch (err) {
      process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : "Request failed"}\n`));
      process.exit(1);
    }
  },
});
