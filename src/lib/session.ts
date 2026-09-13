/**
 * The authenticated client every command that calls the API starts from:
 * resolve the credential, refresh an expired OAuth token, build the client that
 * attributes traffic to this CLI. Exits 2 when there is no credential or the
 * refresh fails, which is what each command did on its own.
 */
import pc from "picocolors";
import { createCliClient } from "./client.js";
import { resolveAuth, refreshTokenIfNeeded, getApiBaseUrl, type AuthCredential } from "./auth.js";

export type CliClient = ReturnType<typeof createCliClient>;
export interface Session {
  client: CliClient;
  cred: AuthCredential;
  baseUrl: string;
}

export async function openSession(): Promise<Session> {
  let cred = resolveAuth();
  if (!cred) {
    process.stderr.write(pc.red("  ✗ Not authenticated. Run `rb login` or set RENDOBAR_API_KEY.\n"));
    process.exit(2);
  }
  if (cred.type === "oauth") {
    try {
      cred = await refreshTokenIfNeeded(cred);
    } catch (err) {
      process.stderr.write(pc.red(`  ✗ ${err instanceof Error ? err.message : "Auth error"}\n`));
      process.exit(2);
    }
  }
  const baseUrl = getApiBaseUrl();
  const client = createCliClient(cred.type === "apikey" ? { apiKey: cred.apiKey, baseUrl } : { accessToken: cred.accessToken, baseUrl });
  return { client, cred, baseUrl };
}
