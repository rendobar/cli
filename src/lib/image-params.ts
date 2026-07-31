/**
 * Shared parameter-building helpers for `rb generate` and `rb edit`.
 *
 * Both commands submit to the same base image-job param shape (`GEN_BASE_PARAMS`
 * in the API's shared job registry): `prompt`, an optional `model` (tier alias
 * `economy`/`standard`/`premium` or a pinned model id -- the API defaults to
 * `economy` when omitted, so the CLI never sends a default itself), optional
 * `width`/`height`/`seed`, and an `enhancePrompt` boolean. `rb generate`
 * additionally exposes the model-dependent extras `negativePrompt`/`guidance`/
 * `steps`; `rb edit`'s flag surface only covers the base set today.
 */

/** Only fields the user actually set are included in the built params -- the
 * API resolves its own defaults (e.g. `model: "economy"`) for anything omitted. */
export interface GenBaseFlags {
  prompt: string;
  model?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  enhance?: boolean;
  negative?: string | null;
  guidance?: number | null;
  steps?: number | null;
}

export function buildGenParams(flags: GenBaseFlags): Record<string, unknown> {
  const params: Record<string, unknown> = { prompt: flags.prompt };
  if (flags.model) params.model = flags.model;
  if (flags.width != null) params.width = flags.width;
  if (flags.height != null) params.height = flags.height;
  if (flags.seed != null) params.seed = flags.seed;
  if (flags.enhance) params.enhancePrompt = true;
  if (flags.negative) params.negativePrompt = flags.negative;
  if (flags.guidance != null) params.guidance = flags.guidance;
  if (flags.steps != null) params.steps = flags.steps;
  return params;
}

/** Parses an integer flag value, returning null for missing/garbage input
 * (mirrors `rb ffmpeg`'s inline `--timeout` parsing). */
export function parseIntFlag(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const val = parseInt(raw, 10);
  return Number.isNaN(val) ? null : val;
}

/** Parses a float flag value (e.g. `--guidance 7.5`), returning null for
 * missing/garbage input. */
export function parseFloatFlag(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const val = parseFloat(raw);
  return Number.isNaN(val) ? null : val;
}
