/**
 * POSIX shell-escape an argv element for embedding in a single command string.
 *
 * Used when the CLI joins argv into a `command` field for `ffmpeg` job
 * submission. The API-side parser implements the matching POSIX rules so
 * `argv → shellEscape → join → parse → argv` is lossless.
 *
 * Rules:
 * - Empty string → `''`.
 * - Strings made entirely of safe characters (alnum and a small set of
 *   shell-neutral punctuation) round-trip unquoted, keeping the produced
 *   string compact and human-readable.
 * - Otherwise wrap in single quotes; embed any literal single quote with
 *   the canonical `'\''` form (close-quote, backslash-escaped quote,
 *   open-quote). The API parser treats backslash outside single quotes as
 *   an escape character, so this round-trips losslessly.
 *
 * Critically: PowerShell on Windows strips outer double quotes before the
 * CLI sees argv. If we joined argv with a plain space, single quotes
 * embedded in filter expressions (e.g. `select='lte(t,60),x'`) would be
 * tokenized away on the API side, FFmpeg would re-interpret the unprotected
 * commas as filter graph separators, and the run would fail with
 * "Filter not found". Shell-escaping per element prevents this.
 */
export function shellEscape(arg: string): string {
  if (arg.length === 0) return "''";
  // The unquoted-safe set: alnum, underscore, and a small set of punctuation
  // that has no special meaning to POSIX shells when unquoted. Notable
  // exclusions and why they MUST be quoted:
  //   ~  (HOME expansion)
  //   *  ?  [  ]  (glob patterns)
  //   {  }  (brace expansion)
  //   $  `  (parameter / command substitution)
  //   !  (history expansion in interactive shells)
  //   #  (start-of-comment)
  //   space  tab  newline  (word splitting)
  //   <  >  |  &  ;  (redirection / control)
  //   '  "  \  (quoting itself)
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
