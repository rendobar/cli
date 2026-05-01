# Rendobar CLI — hero demo

The hero recording for [rendobar.com](https://rendobar.com) and the [cli/README](../README.md).

Built with [charmbracelet/vhs](https://github.com/charmbracelet/vhs). The `.tape` source is versioned; `out/hero.{gif,mp4,webm}` are tracked so the README + docs can hotlink them.

## What it shows

12-second loop. `▸ rb ffmpeg -i intro.mp4 -vf scale=1920:1080 intro-1080p.mp4` renders in the cloud across five steps (Upload · Submit · Queue · Execute · Save), ending on the output filename + dashboard URL.

`rb` appears in brand emerald from the moment the prompt draws — courtesy of a PS1 trick (`bin/demo-rc.sh`), not a post-Enter repaint.

## Running locally

```bash
brew install vhs                  # macOS — needs ttyd + ffmpeg too
make -C demos                     # → demos/out/hero.{gif,mp4,webm}
```

Or directly: `vhs demos/hero.tape` from the `cli/` root.

## Architecture

The recording uses a **stub `rb`** at `bin/rb` (not the real binary), so demos are hermetic — no auth, no network, no flake. The stub emits byte-identical output to the real CLI's progress renderer (matches `src/lib/progress.ts`) with hand-tuned timings.

`bin/demo-rc.sh` is sourced by `hero.tape` in its `Hide` block. It sets the PS1 with green `rb ` baked in and defines `ffmpeg` as a shell function that dispatches to `bin/rb`. The tape only types `ffmpeg -i ...`, so visually the line reads `▸ rb ffmpeg -i ...` from the first frame.

## Style

- Resolution: **1280 × 720** (16:9, plays clean on rendobar.com cards)
- Font: **JetBrains Mono 24pt** (ships in the official VHS Docker image)
- Theme: emerald `#059669` accent, `#6ee7b7` cursor, brand-base `#0b0b0d` background
- Window chrome: macOS-style `Colorful` traffic lights
- No outer margin — terminal fills the frame edge to edge
- Typing speed: **35ms** — snappy but readable
- 1.0s settle pause before typing, 600ms beat before Enter, 2.4s hold on the final URL

## CI

`.github/workflows/demos.yml` regenerates on push to `main`, on every `v*` tag, and via manual dispatch. Outputs ship as a release asset.
