/**
 * `rb login` -- Authenticate via browser-based OAuth 2.1 PKCE flow.
 *
 * Default: opens browser, starts local callback server, exchanges code for tokens.
 * Fallback: --key rb_... for CI/headless/SSH environments.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { createClient } from "@rendobar/sdk";
import { saveApiKey, saveOAuthCredentials, getConfigDir, openBrowser, CLI_CLIENT_ID, getApiBaseUrl } from "../lib/auth.js";
const CALLBACK_PORT = 14832;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 120_000;

// ── PKCE helpers ─────────────────────────────────────────────

function generateCodeVerifier(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── HTML responses ───────────────────────────────────────────
// Pixel-matched to the dashboard: Polar-aligned dark theme tokens from global.css

const CHECK_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
const X_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e7000b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
const TERMINAL_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

function callbackPage(opts: { icon: string; title: string; subtitle: string; isError?: boolean }) {
  const iconBg = opts.isError ? "rgba(231,0,11,0.08)" : "rgba(34,197,94,0.08)";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title} — Rendobar CLI</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html{height:100%}
body{
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  min-height:100%;display:flex;align-items:center;justify-content:center;
  background:#070708;color:#fff;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
/* Subtle top glow — same as dashboard login/consent pages */
body::before{
  content:"";position:fixed;inset:0;pointer-events:none;
  background:radial-gradient(600px circle at 50% 0%,rgba(21,93,252,0.06),transparent 70%);
}
.wrapper{position:relative;z-index:1;width:100%;max-width:420px;padding:0 24px;
  display:flex;flex-direction:column;align-items:center}
/* Brand pill */
.brand{
  display:inline-flex;align-items:center;gap:8px;
  margin-bottom:32px;padding:6px 14px;
  border-radius:9999px;border:1px solid #1d1d20;background:#101012;
  font-size:13px;font-weight:500;color:#7d7f8c;letter-spacing:0.01em;
}
.brand svg{opacity:0.5}
/* Card */
.card{
  width:100%;padding:32px 24px;text-align:center;
  border-radius:16px;border:1px solid #1d1d20;background:#101012;
  box-shadow:0 24px 48px -12px rgba(0,0,0,0.4);
}
.icon-ring{
  width:48px;height:48px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;
  margin-bottom:20px;background:${iconBg};
}
h1{font-size:16px;font-weight:600;letter-spacing:-0.01em;color:#fff;margin-bottom:6px}
.sub{font-size:14px;color:#7d7f8c;line-height:1.5}
/* Footer */
.footer{margin-top:24px;font-size:12px;color:#6e707c}
.footer a{color:#155dfc;text-decoration:none}
.footer a:hover{text-decoration:underline}
</style></head>
<body>
<div class="wrapper">
  <div class="brand">${TERMINAL_SVG} Rendobar CLI</div>
  <div class="card">
    <div class="icon-ring">${opts.icon}</div>
    <h1>${opts.title}</h1>
    <p class="sub">${opts.subtitle}</p>
  </div>
  <p class="footer">Return to your terminal${opts.isError ? "" : " — this tab will close automatically"}</p>
</div>
${opts.isError ? "" : "<script>setTimeout(()=>window.close(),3000)</script>"}
</body></html>`;
}

const SUCCESS_HTML = callbackPage({
  icon: CHECK_SVG,
  title: "Signed in",
  subtitle: "Authentication complete. You can close this tab.",
});
const ERROR_HTML = (msg: string) => callbackPage({
  icon: X_SVG,
  title: msg,
  subtitle: "Something went wrong. Check your terminal for details.",
  isError: true,
});

// ── Command ──────────────────────────────────────────────────

export default defineCommand({
  meta: { name: "login", description: "Authenticate with Rendobar" },
  args: {
    key: { type: "string", description: "API key for non-interactive mode (rb login --key rb_...)" },
  },
  async run({ args }) {
    // ── API key path (--key flag) ────────────────────────
    if (args.key) {
      const apiKey = args.key.trim();
      if (!apiKey.startsWith("rb_")) {
        process.stderr.write(pc.red("  \u2717 Invalid API key. Keys start with rb_\n"));
        process.exit(2);
      }
      try {
        const client = createClient({ apiKey });
        const state = await client.orgs.current();
        await saveApiKey(apiKey);
        process.stderr.write(`  ${pc.green("\u2713")} Verified | ${pc.bold(state.org.name)} | ${state.plan.name} plan\n`);
        process.stderr.write(`  ${pc.dim(`Saved to ${getConfigDir()}/credentials.json`)}\n`);
      } catch (err) {
        process.stderr.write(pc.red(`  \u2717 Verification failed: ${err instanceof Error ? err.message : "Unknown error"}\n`));
        process.exit(2);
      }
      return;
    }

    // ── OAuth PKCE path (default) ────────────────────────
    const baseUrl = getApiBaseUrl();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    // Start local callback server
    let resolveCallback: ((params: URLSearchParams) => void) | null = null;
    let rejectCallback: ((err: Error) => void) | null = null;
    const callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    let server: ReturnType<typeof Bun.serve> | null = null;
    let callbackHandled = false;

    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: CALLBACK_PORT,
        fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === "/favicon.ico") {
            return new Response(null, { status: 204 });
          }

          if (url.pathname === "/callback" && !callbackHandled) {
            callbackHandled = true;
            const params = url.searchParams;

            if (params.has("error")) {
              resolveCallback?.(params);
              return new Response(ERROR_HTML(params.get("error_description") || params.get("error") || "Login failed"), {
                headers: { "Content-Type": "text/html" },
              });
            }

            resolveCallback?.(params);
            return new Response(SUCCESS_HTML, {
              headers: { "Content-Type": "text/html" },
            });
          }

          return new Response(null, { status: 404 });
        },
      });
    } catch {
      process.stderr.write(pc.red(`  \u2717 Port ${CALLBACK_PORT} in use. Use ${pc.bold("rb login --key")} instead.\n`));
      process.exit(2);
    }

    // Build authorization URL
    const authParams = new URLSearchParams({
      client_id: CLI_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid media:full offline_access",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    const authUrl = `${baseUrl}/auth/oauth2/authorize?${authParams}`;

    process.stderr.write("  Opening browser...\n");
    process.stderr.write(`  ${pc.dim("If it didn't open, visit:")}\n`);
    process.stderr.write(`  ${pc.cyan(authUrl)}\n\n`);
    await openBrowser(authUrl);

    // Wait for callback with timeout
    const timeout = setTimeout(() => {
      rejectCallback?.(new Error("timeout"));
    }, LOGIN_TIMEOUT_MS);

    let params: URLSearchParams;
    try {
      params = await callbackPromise;
    } catch {
      clearTimeout(timeout);
      server.stop();
      process.stderr.write(pc.red("  \u2717 Login timed out. Try again.\n"));
      process.exit(2);
    }
    clearTimeout(timeout);

    // Handle error response
    if (params.has("error")) {
      const errorMsg = params.get("error") === "access_denied" ? "Login cancelled." : `Login failed: ${params.get("error")}.`;
      setTimeout(() => server?.stop(), 500);
      process.stderr.write(pc.red(`  \u2717 ${errorMsg}\n`));
      process.exit(2);
    }

    // Validate state
    if (params.get("state") !== state) {
      setTimeout(() => server?.stop(), 500);
      process.stderr.write(pc.red("  \u2717 Security check failed. Try again.\n"));
      process.exit(2);
    }

    const code = params.get("code");
    if (!code) {
      setTimeout(() => server?.stop(), 500);
      process.stderr.write(pc.red("  \u2717 No authorization code received.\n"));
      process.exit(2);
    }

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: CLI_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });

    let tokenData: Record<string, unknown>;
    try {
      const tokenRes = await fetch(`${baseUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        throw new Error(errBody);
      }
      tokenData = (await tokenRes.json()) as Record<string, unknown>;
    } catch (err) {
      setTimeout(() => server?.stop(), 500);
      process.stderr.write(pc.red(`  \u2717 Failed to complete login: ${err instanceof Error ? err.message : "Unknown error"}\n`));
      process.exit(2);
    }

    // Save credentials
    const accessToken = tokenData.access_token as string;
    const refreshToken = typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : undefined;
    const expiresIn = (tokenData.expires_in as number) ?? 3600;

    await saveOAuthCredentials({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    // Verify by fetching org info
    try {
      const client = createClient({ accessToken, baseUrl });
      const orgState = await client.orgs.current();
      process.stderr.write(`  ${pc.green("\u2713")} Signed in | ${pc.bold(orgState.org.name)} | ${orgState.plan.name} plan\n`);
    } catch {
      process.stderr.write(`  ${pc.green("\u2713")} Signed in, but couldn't verify org. Run ${pc.bold("rb whoami")} to check.\n`);
    }

    process.stderr.write(`  ${pc.dim(`Saved to ${getConfigDir()}/credentials.json`)}\n`);

    // Delay stop so browser receives the success HTML
    setTimeout(() => server?.stop(), 500);
  },
});
