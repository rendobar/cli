/**
 * Pure rendering and parsing for `rb storage`. No I/O: every function here
 * takes data the command already has and returns lines or a parsed value.
 */
import type { StorageObject } from "@rendobar/sdk";
import { fmtBytes } from "./progress.js";

export interface ConnectionRow {
  id: string;
  provider: string;
  bucket: string;
  access?: "read";
  pending?: true;
  defaultDestination?: true;
}

const PREFIX = "storage://";

/** `<id>`, `<id>/<folder>` or `storage://<id>/<folder>`, as the id and a folder prefix ending in "/". */
export function parseStorageTarget(arg: string): { id: string; prefix: string } | { error: string } {
  const bare = arg.startsWith(PREFIX) ? arg.slice(PREFIX.length) : arg;
  const slash = bare.indexOf("/");
  const id = slash === -1 ? bare : bare.slice(0, slash);
  if (id === "") return { error: "Name a connection, for example rb storage ls prod-media/raw/. Run rb storage list for the ids." };
  const rest = slash === -1 ? "" : bare.slice(slash + 1);
  return { id, prefix: rest === "" || rest.endsWith("/") ? rest : `${rest}/` };
}

export function formatConnections(rows: readonly ConnectionRow[]): string[] {
  if (rows.length === 0) return ["No storage connected. Connect a bucket at https://app.rendobar.com/storage"];
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
  const lines = page.folders.map((folder) => `${blank}  ${PREFIX}${id}/${folder}`);
  for (const o of page.objects) {
    const date = o.lastModified === null ? "" : new Date(o.lastModified).toISOString().slice(0, 10);
    lines.push(`${fmtBytes(o.size).padStart(9)}  ${date.padEnd(10)}  ${PREFIX}${id}/${o.key}`);
  }
  return lines;
}

/** Credentials from before connected storage carry no storage scope. Say how to get one. */
export function storageHint(code: string, message: string): string {
  if (code !== "INSUFFICIENT_SCOPE") return message;
  return `${message} Run rb login again to grant storage access, or use an API key created after September 13, 2026.`;
}
