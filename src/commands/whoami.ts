/**
 * `rb whoami` -- Display current authenticated identity.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { saveApiKey, saveOAuthCredentials } from "../lib/auth.js";
import { openSession } from "../lib/session.js";

export default defineCommand({
  meta: { name: "whoami", description: "Show current authenticated identity" },
  async run() {
    const { client, cred, baseUrl } = await openSession();

    try {
      const state = await client.orgs.current();

      process.stderr.write(`  ${pc.dim("Org")}       ${pc.bold(state.org.name)}\n`);
      process.stderr.write(`  ${pc.dim("Plan")}      ${state.plan.name}\n`);
      process.stderr.write(`  ${pc.dim("Balance")}   ${state.balance.balanceFormatted}\n`);

      // Refresh the welcome-screen identity cache (best-effort; never block whoami).
      try {
        const identity = { orgName: state.org.name, plan: state.plan.name };
        if (cred.type === "apikey") {
          await saveApiKey(cred.apiKey, undefined, identity);
        } else {
          await saveOAuthCredentials(
            { accessToken: cred.accessToken, refreshToken: cred.refreshToken, expiresAt: cred.expiresAt, identity },
            undefined,
          );
        }
      } catch { /* identity cache is best-effort */ }
    } catch (err) {
      process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : "Request failed"}\n`));
      process.exit(1);
    }
  },
});
