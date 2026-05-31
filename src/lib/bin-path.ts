/**
 * Absolute path to the currently-running `rb` executable.
 *
 * In a Bun single-file executable (`bun build --compile`), `process.execPath`
 * is the compiled binary itself (the `rb` / `rb.exe`). `process.argv[0]` is the
 * embedded runtime name — the literal string `"bun"` — and must NOT be used:
 * doing so broke `rb update` ("cannot locate current binary at bun") and the
 * macOS quarantine check, which both need the real on-disk path.
 *
 * Verified on a compiled binary: execPath → "<dir>/rb.exe", argv[0] → "bun".
 */
export function getBinPath(): string {
  return process.execPath || "";
}
