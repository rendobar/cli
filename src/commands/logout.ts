/**
 * `rb logout` -- Sign out and revoke tokens.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveAuth, clearCredentials, CLI_CLIENT_ID, getApiBaseUrl } from "../lib/auth.js";

export default defineCommand({
  meta: { name: "logout", description: "Sign out of Rendobar CLI" },
  async run() {
    const cred = resolveAuth();

    if (!cred) {
      process.stderr.write(pc.dim("  Not signed in.\n"));
      return;
    }

    // Revoke refresh token (best-effort)
    if (cred.type === "oauth" && cred.refreshToken) {
      const baseUrl = getApiBaseUrl();
      try {
        await fetch(`${baseUrl}/auth/oauth2/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: cred.refreshToken,
            client_id: CLI_CLIENT_ID,
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* best-effort */ }
    }

    clearCredentials();
    process.stderr.write(`  ${pc.green("✓")} Signed out\n`);
  },
});
