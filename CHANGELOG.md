# Changelog

## [1.3.3](https://github.com/rendobar/cli/compare/v1.3.2...v1.3.3) (2026-06-06)


### Bug Fixes

* prune leftover update artifacts from the bin dir before updating ([#41](https://github.com/rendobar/cli/issues/41)) ([f05252c](https://github.com/rendobar/cli/commit/f05252cd03eb6818b04a5ba2de5b89e5c921cf6e))

## [1.3.2](https://github.com/rendobar/cli/compare/v1.3.1...v1.3.2) (2026-06-06)


### Bug Fixes

* repair rb update on Windows and wire the background update check ([#37](https://github.com/rendobar/cli/issues/37)) ([69f2a73](https://github.com/rendobar/cli/commit/69f2a7316c7cc434662b5014129611ac71141e37))

## [1.3.1](https://github.com/rendobar/cli/compare/v1.3.0...v1.3.1) (2026-06-06)


### Bug Fixes

* **deps:** bump dependency @rendobar/sdk to v2 ([#30](https://github.com/rendobar/cli/issues/30)) ([67f1234](https://github.com/rendobar/cli/commit/67f12349b24aa72bf379ef78c5104225e6a7c312))

## [1.3.0](https://github.com/rendobar/cli/compare/v1.2.0...v1.3.0) (2026-06-06)


### Features

* show served multi-file output and ffmpeg errorDetail ([#35](https://github.com/rendobar/cli/issues/35)) ([59587fe](https://github.com/rendobar/cli/commit/59587fe5b4005c5c126262c20c242d62433c97af))

## [1.2.0](https://github.com/rendobar/cli/compare/v1.1.1...v1.2.0) (2026-06-02)


### Features

* submit ffmpeg job type instead of raw.ffmpeg ([#32](https://github.com/rendobar/cli/issues/32)) ([e65042b](https://github.com/rendobar/cli/commit/e65042be972ec9befb5639c69bca263488109085))

## [1.1.1](https://github.com/rendobar/cli/compare/v1.1.0...v1.1.1) (2026-06-02)


### Bug Fixes

* **deps:** bump dependency citty to ^0.2.0 ([#24](https://github.com/rendobar/cli/issues/24)) ([4f3ecbe](https://github.com/rendobar/cli/commit/4f3ecbe87929b4b40bb5d971c70ca2ee1a8cbbbf))

## [1.1.0](https://github.com/rendobar/cli/compare/v1.0.1...v1.1.0) (2026-05-31)


### Features

* add welcome screen for bare `rb` and `rb --help` ([#15](https://github.com/rendobar/cli/issues/15)) ([a4e3550](https://github.com/rendobar/cli/commit/a4e355017a98251f7f057f024b4001342fa16fcd))


### Bug Fixes

* locate running binary via execPath instead of argv[0] ([#16](https://github.com/rendobar/cli/issues/16)) ([c233e1f](https://github.com/rendobar/cli/commit/c233e1f1a7d354e152be62f8a6046d4d0b6904b5))
* shell-escape ffmpeg argv before joining for API submission ([#14](https://github.com/rendobar/cli/issues/14)) ([761396f](https://github.com/rendobar/cli/commit/761396f88120211daeed258301f4dedd97b9731d))

## [1.0.1](https://github.com/rendobar/cli/compare/v1.0.0...v1.0.1) (2026-04-24)


### Bug Fixes

* use RUNNER_TEMP in install-scripts Windows live-mode path ([#10](https://github.com/rendobar/cli/issues/10)) ([9917b3c](https://github.com/rendobar/cli/commit/9917b3c2a3e5b98ee2a0f3168fba55c99b10e062))

## 1.0.0 (2026-04-24)


### Features

* add install/uninstall scripts + E2E workflow ([#4](https://github.com/rendobar/cli/issues/4)) ([03c49ee](https://github.com/rendobar/cli/commit/03c49ee20764456a15113b3ad09f3ba8aa14050d))
* initial source drop for standalone CLI repo ([9039fa7](https://github.com/rendobar/cli/commit/9039fa7d3d7bfdb1e026323192fa5e66d7eca78d))


### Bug Fixes

* bulletproof watchdog issue bodies and add Claude Code memory ([#3](https://github.com/rendobar/cli/issues/3)) ([2249ded](https://github.com/rendobar/cli/commit/2249ded143c0a6a4082f3495c66aba455fb283af))


### Miscellaneous

* reset release state for clean v1.0.0 under new rules ([#8](https://github.com/rendobar/cli/issues/8)) ([258f949](https://github.com/rendobar/cli/commit/258f9495a7e89def2feb070ff75c00bbe7952a21))

## Changelog

All notable changes to the Rendobar CLI are documented in this file. Generated automatically by [release-please](https://github.com/googleapis/release-please).
