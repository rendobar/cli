/**
 * `rb storage` -- the buckets connected on the Storage page, and what is in them.
 * Data goes to stdout so it pipes. Messages go to stderr.
 */
import { defineCommand } from "citty";
import pc from "picocolors";
import { isApiError, type StorageObject } from "@rendobar/sdk";
import { openSession } from "../lib/session.js";
import { formatConnections, formatListing, parseStorageTarget, storageHint } from "../lib/storage-view.js";

function fail(code: 1 | 2, message: string): never {
  process.stderr.write(pc.red(`  ✗ ${message}\n`));
  process.exit(code);
}

function failRequest(err: unknown): never {
  if (isApiError(err)) fail(err.statusCode === 401 ? 2 : 1, storageHint(err.code, err.message));
  fail(1, err instanceof Error ? err.message : "Request failed");
}

const list = defineCommand({
  meta: { name: "list", description: "List the buckets connected on the Storage page" },
  args: { json: { type: "boolean", description: "Print the connections as JSON" } },
  async run({ args }) {
    const { client } = await openSession();
    try {
      const { data } = await client.storage.list();
      if (args.json) {
        console.log(JSON.stringify(data));
        return;
      }
      for (const line of formatConnections(data)) console.log(line);
    } catch (err) {
      failRequest(err);
    }
  },
});

const ls = defineCommand({
  meta: { name: "ls", description: "List folders and files in a connected bucket" },
  args: {
    // Not `required: true`: citty would reject a missing positional before run()
    // and exit 1. Validated below instead, so a missing id exits 2 like any
    // other bad argument, and without opening a session or calling the API.
    target: { type: "positional", required: false, description: "<id>[/<folder>] or storage://<id>[/<folder>]" },
    all: { type: "boolean", description: "Read every page instead of stopping after the first" },
    json: { type: "boolean", description: "Print the listing as JSON" },
  },
  async run({ args }) {
    const target = parseStorageTarget(args.target ?? "");
    if ("error" in target) fail(2, target.error);
    const { client } = await openSession();
    try {
      const folders: string[] = [];
      const objects: StorageObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.storage.listObjects(target.id, { prefix: target.prefix, cursor });
        folders.push(...page.folders);
        objects.push(...page.objects);
        cursor = page.cursor ?? undefined;
      } while (args.all && cursor !== undefined);
      if (args.json) {
        console.log(JSON.stringify({ folders, objects, cursor: cursor ?? null }));
        return;
      }
      for (const line of formatListing(target.id, { folders, objects })) console.log(line);
      if (cursor !== undefined) process.stderr.write(pc.dim("  More entries exist. Add --all to list every page.\n"));
    } catch (err) {
      failRequest(err);
    }
  },
});

export default defineCommand({
  meta: { name: "storage", description: "List connected storage and browse a bucket" },
  subCommands: { list, ls },
});
