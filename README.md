<h1 align="center">Rendobar CLI</h1>
<p align="center">
  <strong>Serverless video processing from your terminal.</strong><br>
  Watermark, transcode, caption, render videos with one command.
</p>
<p align="center">
  <a href="https://rendobar.com">Website</a> •
  <a href="https://rendobar.com/docs">Docs</a> •
  <a href="https://www.npmjs.com/package/@rendobar/sdk">SDK</a> •
  <a href="https://github.com/rendobar/cli/releases/latest">Latest Release</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/rendobar/cli?label=version" alt="Version">
  <img src="https://img.shields.io/github/downloads/rendobar/cli/total?label=downloads" alt="Downloads">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
</p>

---

## Install

The Rendobar CLI ships as a standalone binary for macOS, Linux, and Windows. No Node or npm dependency.

### macOS / Linux

```bash
curl -fsSL https://rendobar.com/install.sh | bash
```

### Windows (PowerShell)

```powershell
iwr https://rendobar.com/install.ps1 -useb | iex
```

### Verify

```bash
rb --version
rb doctor
```

## Quick start

```bash
# Authenticate
rb login

# Watermark a video
rb ffmpeg -i input.mp4 -vf "drawtext=text='PREVIEW':fontsize=48:fontcolor=white@0.5" output.mp4

# Check what the CLI can do
rb --help
```

Full usage: [rendobar.com/docs/cli](https://rendobar.com/docs/cli)

## Auto-update

The CLI notifies you of new releases on the next run after a check. Update with:

```bash
rb update
```

Self-replaces the binary in-place with checksum verification and automatic rollback if the new binary fails.

## What is Rendobar?

Rendobar is a serverless media processing platform — watermark, transcode, caption, render videos with one API call. Credit-based billing. MCP-native for AI agents.

- **Website**: https://rendobar.com
- **Docs**: https://rendobar.com/docs
- **API**: https://api.rendobar.com
- **SDK**: [@rendobar/sdk](https://www.npmjs.com/package/@rendobar/sdk) on npm

## This repository

This is the **public source + distribution repository** for the Rendobar CLI. It contains:

- Full CLI source (TypeScript, bundled via Bun)
- Binary releases for macOS, Linux, and Windows (see [Releases](https://github.com/rendobar/cli/releases))
- Tests, workflows, issue templates
- License

Bug reports, feature requests, and pull requests are welcome.

## Contributing

```bash
git clone https://github.com/rendobar/cli.git
cd cli
pnpm install
pnpm test
pnpm typecheck
pnpm dev -- --version
```

Build a standalone binary locally:

```bash
pnpm build
./rb --version
```

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/). Releases and version bumps are automated by [release-please](https://github.com/googleapis/release-please).

## Support

- **Bugs**: [open an issue](https://github.com/rendobar/cli/issues/new?template=bug.md)
- **Feature requests**: [open an issue](https://github.com/rendobar/cli/issues/new?template=feature.md)
- **Docs**: https://rendobar.com/docs
- **Contact**: hello@rendobar.com

## License

MIT — see [LICENSE](./LICENSE).
