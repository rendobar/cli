import * as fs from "node:fs";

const CREDENTIALS_FILE = "credentials.json";
export const CLI_CLIENT_ID = "rendobar-cli";
const REFRESH_BUFFER_MS = 60_000; // refresh 60s before expiry

export function getApiBaseUrl(): string {
  return process.env.RENDOBAR_API_URL ?? "https://api.rendobar.com";
}

// ── Types ────────────────────────────────────────────────────

export type AuthCredential =
  | { type: "apikey"; apiKey: string }
  | { type: "oauth"; accessToken: string; refreshToken?: string; expiresAt: number };

interface OAuthSaveData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

// ── Config directory ─────────────────────────────────────────

/**
 * Platform-appropriate config directory.
 * Linux/macOS: $XDG_CONFIG_HOME/rendobar or ~/.config/rendobar
 * Windows: %APPDATA%/rendobar
 */
export function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA environment variable is not set");
    return `${appData}/rendobar`;
  }
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
  return `${xdg}/rendobar`;
}

// ── Resolve credentials ──────────────────────────────────────

export function resolveAuth(configDir?: string): AuthCredential | null {
  // 1. Env var (highest priority)
  const envKey = process.env.RENDOBAR_API_KEY;
  if (envKey) return { type: "apikey", apiKey: envKey };

  // 2. Credentials file
  const dir = configDir ?? getConfigDir();
  try {
    const content = fs.readFileSync(`${dir}/${CREDENTIALS_FILE}`, "utf8");
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;

    // OAuth credentials (type="oauth")
    if (data.type === "oauth" && typeof data.accessToken === "string") {
      return {
        type: "oauth",
        accessToken: data.accessToken,
        refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : undefined,
        expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
      };
    }

    // Legacy API key format ({ apiKey: "rb_..." })
    if (typeof data.apiKey === "string") {
      return { type: "apikey", apiKey: data.apiKey };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Token refresh ────────────────────────────────────────────

export async function refreshTokenIfNeeded(
  cred: Extract<AuthCredential, { type: "oauth" }>,
  configDir?: string,
): Promise<Extract<AuthCredential, { type: "oauth" }>> {
  // No refresh token → degraded mode, can't refresh
  if (!cred.refreshToken) return cred;

  // Not expired yet → use as-is
  if (cred.expiresAt > Date.now() + REFRESH_BUFFER_MS) return cred;

  // Refresh
  const baseUrl = getApiBaseUrl();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: CLI_CLIENT_ID,
  });

  const res = await fetch(`${baseUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Token revoked or expired — force re-login
    clearCredentials(configDir);
    throw new Error("Session expired. Run `rb login` to sign in again.");
  }

  const json = (await res.json()) as Record<string, unknown>;
  const newCred: Extract<AuthCredential, { type: "oauth" }> = {
    type: "oauth",
    accessToken: json.access_token as string,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : cred.refreshToken,
    expiresAt: Date.now() + (json.expires_in as number) * 1000,
  };

  await saveOAuthCredentials(
    { accessToken: newCred.accessToken, refreshToken: newCred.refreshToken, expiresAt: newCred.expiresAt },
    configDir,
  );

  return newCred;
}

// ── Save credentials ─────────────────────────────────────────

export async function saveOAuthCredentials(data: OAuthSaveData, configDir?: string): Promise<void> {
  const dir = configDir ?? getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = `${dir}/${CREDENTIALS_FILE}`;
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(
    {
      type: "oauth",
      accessToken: data.accessToken,
      ...(data.refreshToken ? { refreshToken: data.refreshToken } : {}),
      expiresAt: data.expiresAt,
    },
    null,
    2,
  );
  await Bun.write(tmpPath, json);
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
}

export async function saveApiKey(apiKey: string, configDir?: string): Promise<void> {
  const dir = configDir ?? getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = `${dir}/${CREDENTIALS_FILE}`;
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify({ apiKey }, null, 2));
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows */ }
}

// ── Clear credentials ────────────────────────────────────────

export function clearCredentials(configDir?: string): void {
  const dir = configDir ?? getConfigDir();
  try { fs.unlinkSync(`${dir}/${CREDENTIALS_FILE}`); } catch { /* already gone */ }
}

// ── Open browser ─────────────────────────────────────────────

export async function openBrowser(url: string): Promise<void> {
  try {
    // Use Bun.spawn (not shell templates) to avoid & being interpreted
    // as a command separator on Windows cmd.exe.
    if (process.platform === "win32") {
      Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch { /* best-effort */ }
}
