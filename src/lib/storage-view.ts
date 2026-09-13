/**
 * Pure rendering and parsing for `rb storage`. No I/O: every function here
 * takes data the command already has and returns lines or a parsed value.
 */
import type { StorageObject } from "@rendobar/sdk";
import { getDashboardBaseUrl } from "./auth.js";
import { fmtBytes } from "./progress.js";

export interface ConnectionRow {
  id: string;
  provider: string;
  bucket: string;
  region?: string;
  access?: "read";
  pending?: true;
  defaultDestination?: true;
}

/**
 * The one connection shape n8n, Activepieces, the local MCP server and the CLI
 * return. The hosted MCP server returns more fields than this.
 */
export interface ConnectionJson {
  id: string;
  provider: string;
  bucket: string;
  region: string | null;
  access: "read" | "deliver";
  pending: boolean;
  defaultDestination: boolean;
}

const PREFIX = "storage://";

// Escapes %, ? and # in that order, matching encodeStoragePath in rendobar/rendobar#696 (packages/shared/src/storage/refs.ts).
export function encodeStoragePath(path: string): string {
  return path.replace(/[%?#]/g, (c) => encodeURIComponent(c));
}

// Mirrors decodeStoragePath in rendobar/rendobar#696: falls back to the literal text when it is not valid percent-encoding.
function decodeStoragePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `<id>`, `<id>/<folder>` or `storage://<id>/<folder>`, as the id and a folder prefix ending in "/". */
export function parseStorageTarget(arg: string): { id: string; prefix: string } | { error: string } {
  const isUri = arg.startsWith(PREFIX);
  const bare = isUri ? arg.slice(PREFIX.length) : arg;
  const slash = bare.indexOf("/");
  const id = slash === -1 ? bare : bare.slice(0, slash);
  if (id === "") return { error: "Name a connection, for example rb storage ls prod-media/raw/. Run rb storage list for the ids." };
  const rawRest = slash === -1 ? "" : bare.slice(slash + 1);
  // A storage:// URI was copied from `rb storage ls` output, so it is decoded. A bare
  // <id>/<folder> was typed by hand, so it stays literal.
  const rest = isUri ? decodeStoragePath(rawRest) : rawRest;
  return { id, prefix: rest === "" || rest.endsWith("/") ? rest : `${rest}/` };
}

/**
 * `rb storage list --json` prints this, not the SDK's raw connection object,
 * which carries fields (endpoint, accountId, projectRef, pathTemplate, pathStyle,
 * checks, deliverySummary, problem) that n8n, Activepieces, the local MCP server
 * and the CLI all leave out. The hosted MCP server exposes more of them.
 */
export function connectionJson(c: ConnectionRow): ConnectionJson {
  return {
    id: c.id,
    provider: c.provider,
    bucket: c.bucket,
    region: c.region ?? null,
    access: c.access === "read" ? "read" : "deliver",
    pending: c.pending === true,
    defaultDestination: c.defaultDestination === true,
  };
}

export function formatConnections(rows: readonly ConnectionRow[]): string[] {
  if (rows.length === 0) return [`No storage connected. Connect a bucket at ${getDashboardBaseUrl()}/storage`];
  const head = ["ID", "PROVIDER", "BUCKET", "ACCESS", ""];
  const body = rows.map((r) => [
    r.id,
    r.provider,
    r.bucket,
    r.pending ? "pending" : r.access === "read" ? "read only" : "deliver",
    r.defaultDestination ? "default" : "",
  ]);
  const widths = head.map((h, col) => Math.max(h.length, ...body.map((row) => (row[col] ?? "").length)));
  return [head, ...body].map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd());
}

export function formatListing(id: string, page: { folders: readonly string[]; objects: readonly StorageObject[] }): string[] {
  const blank = `${"".padStart(9)}  ${"".padEnd(10)}`;
  const lines = page.folders.map((folder) => `${blank}  ${PREFIX}${id}/${encodeStoragePath(folder)}`);
  for (const o of page.objects) {
    const date = o.lastModified === null ? "" : new Date(o.lastModified).toISOString().slice(0, 10);
    lines.push(`${fmtBytes(o.size).padStart(9)}  ${date.padEnd(10)}  ${PREFIX}${id}/${encodeStoragePath(o.key)}`);
  }
  return lines;
}

/** Credentials from before connected storage carry no storage scope. Say how to get one. */
export function storageHint(code: string, message: string): string {
  if (code !== "INSUFFICIENT_SCOPE") return message;
  return `${message} A sign-in or API key made before September 13, 2026 does not have storage access. Run rb login again, or make a new API key.`;
}

/** A bad token and a missing storage scope are both authorization problems, so both exit 2. */
export function storageExitCode(statusCode: number, code: string): 1 | 2 {
  return statusCode === 401 || code === "INSUFFICIENT_SCOPE" ? 2 : 1;
}
