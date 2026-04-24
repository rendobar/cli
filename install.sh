#!/bin/sh
# Rendobar CLI installer for macOS and Linux
# Usage: curl -fsSL https://rendobar.com/install.sh | sh
# Env:
#   RENDOBAR_INSTALL_DIR        override binary dir (default: $HOME/.rendobar/bin)
#   RENDOBAR_VERSION            pin a specific tag (e.g. "v1.0.0"); default = latest stable
#   RENDOBAR_GITHUB_TOKEN       optional GH token to lift the 60/hr unauth rate limit
#                               (falls back to GITHUB_TOKEN for CI environments)
#   RENDOBAR_NO_MODIFY_PATH=1   install binary but do not touch shell rc files
#                               (use for Docker, provisioning, or when rc is managed elsewhere)
set -eu
# Note: we do NOT set -o pipefail here. `set` is a POSIX special-builtin,
# so in dash the unknown option kills the shell before `|| true` can fire.
# Instead, the two pipelines that matter (tag parsing and checksum verify)
# each check their output explicitly below.

REPO="rendobar/cli"
INSTALL_DIR="${RENDOBAR_INSTALL_DIR:-$HOME/.rendobar/bin}"
BIN_NAME="rb"
PINNED_VERSION="${RENDOBAR_VERSION:-}"
GH_TOKEN_VALUE="${RENDOBAR_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
NO_MODIFY_PATH="${RENDOBAR_NO_MODIFY_PATH:-0}"

# --- downloader detection -------------------------------------------------

# Detect downloader once; all subsequent fetches go through this.
# Headers (with potentially spaced values like "Bearer TOKEN") require
# tool-specific syntax, so we pick curl/wget up front and keep call sites
# explicit rather than papering over with string args.
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER=curl
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER=wget
else
  echo "Error: need curl or wget to install Rendobar CLI." >&2
  exit 1
fi

# Download $1 (URL) to $2 (path). Follows redirects, 3 retries.
download_to_file() {
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused -o "$2" "$1"
  else
    wget --quiet --tries=3 --retry-connrefused -O "$2" "$1"
  fi
}

# Fetch $1 with optional bearer token in $2; print response to stdout.
fetch_api() {
  _url="$1"
  _token="${2:-}"
  if [ "$DOWNLOADER" = curl ]; then
    if [ -n "$_token" ]; then
      curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused \
        -H "Accept: application/vnd.github+json" \
        -H "Authorization: Bearer $_token" \
        "$_url"
    else
      curl -fsSL --retry 3 --retry-delay 2 --retry-connrefused \
        -H "Accept: application/vnd.github+json" \
        "$_url"
    fi
  else
    if [ -n "$_token" ]; then
      wget --quiet --tries=3 --retry-connrefused \
        --header="Accept: application/vnd.github+json" \
        --header="Authorization: Bearer $_token" \
        -O - "$_url"
    else
      wget --quiet --tries=3 --retry-connrefused \
        --header="Accept: application/vnd.github+json" \
        -O - "$_url"
    fi
  fi
}

# --- OS/arch detection ----------------------------------------------------

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux*)  OS="linux" ;;
  darwin*) OS="darwin" ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Rendobar CLI supports: Linux (x64/arm64), macOS (x64/arm64), Windows (x64 — use install.ps1)"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported arch: $ARCH"
    exit 1
    ;;
esac

ASSET="rb-${OS}-${ARCH}"
ARCHIVE="${ASSET}.tar.gz"

# --- resolve release tag --------------------------------------------------

if [ -n "$PINNED_VERSION" ]; then
  case "$PINNED_VERSION" in
    v*) LATEST_TAG="$PINNED_VERSION" ;;
    *)  LATEST_TAG="v$PINNED_VERSION" ;;
  esac
  echo "Using pinned version: $LATEST_TAG"
else
  # Fetch latest non-draft, non-prerelease tag. The GitHub /releases/latest
  # endpoint already filters both.
  echo "Fetching latest release tag..."
  RESP=$(fetch_api "https://api.github.com/repos/${REPO}/releases/latest" "$GH_TOKEN_VALUE")
  LATEST_TAG=$(printf '%s\n' "$RESP" | \
    sed -n 's/.*"tag_name":[[:space:]]*"\(v[^"]*\)".*/\1/p' | \
    head -n1)

  if [ -z "$LATEST_TAG" ]; then
    echo "Failed to find a stable CLI release (looking for v*)."
    echo "If no releases exist yet, install.sh cannot proceed. Try again later."
    exit 1
  fi
  echo "Latest: $LATEST_TAG"
fi

VERSION="${LATEST_TAG#v}"

# --- download + verify ----------------------------------------------------

TMP=$(mktemp -d)
# Trap all common termination signals to guarantee tmp cleanup.
trap 'rm -rf "$TMP"' EXIT
trap 'rm -rf "$TMP"; exit 130' INT
trap 'rm -rf "$TMP"; exit 143' TERM HUP

ARCHIVE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ARCHIVE}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/checksums.txt"

echo "Downloading $ARCHIVE..."
download_to_file "$ARCHIVE_URL" "$TMP/$ARCHIVE"

echo "Downloading checksums.txt..."
download_to_file "$CHECKSUMS_URL" "$TMP/checksums.txt"

echo "Verifying checksum..."
cd "$TMP"
# Guard against an empty grep result: `sha256sum -c` with empty stdin prints
# a warning and exits 0, which would silently skip verification. Check first.
EXPECTED_LINE=$(grep " ${ARCHIVE}\$" checksums.txt || true)
if [ -z "$EXPECTED_LINE" ]; then
  echo "No checksum entry for $ARCHIVE in checksums.txt" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s\n' "$EXPECTED_LINE" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  EXPECTED=$(printf '%s\n' "$EXPECTED_LINE" | awk '{print $1}')
  ACTUAL=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch: expected $EXPECTED, got $ACTUAL" >&2
    exit 1
  fi
else
  echo "No SHA256 tool found (need sha256sum or shasum)" >&2
  exit 1
fi
echo "Checksum verified."

# --- extract + install ----------------------------------------------------

echo "Extracting..."
tar xzf "$ARCHIVE"

mkdir -p "$INSTALL_DIR"
mv "$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
chmod +x "$INSTALL_DIR/$BIN_NAME"

if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/$BIN_NAME" 2>/dev/null || true
fi

echo ""
echo "Installed rb $VERSION to $INSTALL_DIR/$BIN_NAME"
echo ""

# --- PATH handling --------------------------------------------------------

if [ "$NO_MODIFY_PATH" = "1" ]; then
  echo "Skipping PATH modification (RENDOBAR_NO_MODIFY_PATH=1)."
  echo "Add this directory to PATH manually: $INSTALL_DIR"
else
  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      echo "PATH already contains $INSTALL_DIR — ready to use."
      ;;
    *)
      SHELL_NAME="$(basename "${SHELL:-sh}")"
      case "$SHELL_NAME" in
        bash) RC="$HOME/.bashrc" ;;
        zsh)  RC="$HOME/.zshrc" ;;
        fish) RC="$HOME/.config/fish/config.fish" ;;
        *)    RC="$HOME/.profile" ;;
      esac
      if [ "$SHELL_NAME" = "fish" ]; then
        mkdir -p "$(dirname "$RC")"
        printf "\n# Added by Rendobar installer\nset -x PATH %s \$PATH\n" "$INSTALL_DIR" >> "$RC"
      else
        printf "\n# Added by Rendobar installer\nexport PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR" >> "$RC"
      fi
      echo "Added $INSTALL_DIR to PATH in $RC"
      echo ""
      echo "To use rb in THIS terminal without reopening, run:"
      echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
fi

echo ""
echo "Next: run 'rb login' to authenticate, then 'rb --help' to see commands."
