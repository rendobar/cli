/**
 * Connected-storage delivery for the commands that produce a file.
 *
 * A job is complete before its deliveries start, so the result read at
 * completion usually shows them pending. The commands wait for them here,
 * bounded, so `--json` and the exit code carry the settled outcome.
 */
import pc from "picocolors";
import type { StepRenderer } from "./progress.js";

/** One destination's outcome, as GET /jobs/:id reports it. */
export interface Delivery {
  storageId: string;
  status: "pending" | "delivered" | "failed";
  path?: string;
  url?: string;
  reason?: string;
  renamed?: boolean;
}

export interface JobReader {
  jobs: { get(id: string, options?: { signal?: AbortSignal }): Promise<unknown> };
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FinishOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  quiet: boolean;
}

/**
 * How long a command keeps the terminal waiting for deliveries. Technical, not a
 * product cap: the delivery itself continues on Rendobar after the CLI stops
 * waiting, and the job page shows the outcome. Five minutes covers a large
 * multipart write without holding a CI step open indefinitely.
 */
export const DELIVERY_WAIT_MS = 5 * 60_000;

const PREFIX = "storage://";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is Delivery["status"] => v === "pending" || v === "delivered" || v === "failed";

/** Every `--deliver <uri>` on the command line, in order, and what was wrong with any of them. */
export function readDeliverFlags(argv: readonly string[]): { destinations: string[]; errors: string[] } {
  const destinations: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--deliver") continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push("--deliver needs a destination, for example --deliver storage://prod-media");
      continue;
    }
    i++;
    const id = value.startsWith(PREFIX) ? (value.slice(PREFIX.length).split("/")[0] ?? "") : "";
    if (id === "") {
      errors.push(`--deliver takes storage://<id>[/<folder or path>], not "${value}". Run rb storage list for the ids.`);
      continue;
    }
    if (!destinations.includes(value)) destinations.push(value);
  }
  return { destinations, errors };
}

/** readDeliverFlags for a command: a bad --deliver exits 2 like any bad argument. */
export function deliverFlagsOrExit(argv: readonly string[]): string[] {
  const { destinations, errors } = readDeliverFlags(argv);
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(pc.red(`  ✗ ${err}\n`));
    process.exit(2);
  }
  return destinations;
}

/** The deliveries on a job read, skipping anything that is not a whole delivery. */
export function parseDeliveries(job: unknown): Delivery[] {
  if (!isRecord(job) || !Array.isArray(job.deliveries)) return [];
  return job.deliveries.flatMap((raw: unknown): Delivery[] => {
    if (!isRecord(raw) || typeof raw.storageId !== "string" || !isStatus(raw.status)) return [];
    return [
      {
        storageId: raw.storageId,
        status: raw.status,
        ...(typeof raw.path === "string" ? { path: raw.path } : {}),
        ...(typeof raw.url === "string" ? { url: raw.url } : {}),
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        ...(raw.renamed === true ? { renamed: true } : {}),
      },
    ];
  });
}

export function deliveryLine(d: Delivery): string {
  const where = d.path === undefined ? `${PREFIX}${d.storageId}` : `${PREFIX}${d.storageId}/${d.path}`;
  if (d.status === "delivered") return `Delivered to ${where}${d.renamed ? " (renamed, the name was taken)" : ""}`;
  if (d.status === "failed") return `Not delivered to ${where}, reason ${d.reason ?? "not given"}`;
  return `Still delivering to ${where} when the wait ended. The job page shows the outcome.`;
}

/** A command fails unless every delivery landed. */
export function deliveryExitCode(deliveries: readonly Delivery[]): 0 | 1 {
  return deliveries.some((d) => d.status !== "delivered") ? 1 : 0;
}

export async function waitForDeliveries(
  getJob: (signal?: AbortSignal) => Promise<unknown>,
  initial: Delivery[],
  opts: WaitOptions,
): Promise<Delivery[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 2_000;
  const deadline = now() + opts.timeoutMs;
  let current = initial;
  while (current.some((d) => d.status === "pending") && now() < deadline) {
    await sleep(interval);
    const next = parseDeliveries(await getJob(opts.signal));
    if (next.length > 0) current = next;
  }
  return current;
}

/**
 * After a job completes: wait for its deliveries, print one line each, write the
 * settled list back onto the result for --json, and return the exit code the
 * command ends with. A job may carry deliveries without --deliver, through the
 * account's default destination, so this keys off the result rather than the flag.
 */
export async function finishDeliveries(
  steps: Pick<StepRenderer, "step" | "info">,
  client: JobReader,
  jobId: string,
  result: { deliveries: Delivery[] },
  opts: FinishOptions,
): Promise<0 | 1> {
  if (result.deliveries.length === 0) return 0;
  const settle = () =>
    waitForDeliveries((signal) => client.jobs.get(jobId, { signal }), result.deliveries, {
      timeoutMs: opts.timeoutMs ?? DELIVERY_WAIT_MS,
      intervalMs: opts.intervalMs,
      signal: opts.signal,
    });
  result.deliveries = opts.quiet ? await settle() : await steps.step("Delivering", settle);
  if (!opts.quiet) {
    for (const d of result.deliveries) {
      const line = deliveryLine(d);
      steps.info(d.status === "delivered" ? pc.green(`✓ ${line}`) : d.status === "failed" ? pc.red(`✗ ${line}`) : pc.yellow(line));
    }
  }
  return deliveryExitCode(result.deliveries);
}
