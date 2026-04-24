#!/bin/sh
# Rendobar CLI uninstaller for macOS and Linux
# Usage: curl -fsSL https://rendobar.com/uninstall.sh | sh
# Env:
#   RENDOBAR_INSTALL_DIR        override binary dir (default: $HOME/.rendobar/bin)
#   RENDOBAR_CONFIG_DIR         override config dir (default: $HOME/.rendobar)
#   RENDOBAR_PURGE=1            also remove config dir (auth tokens, cached keys)
#   RENDOBAR_NO_MODIFY_PATH=1   skip rc-file cleanup (install never touched rc anyway)
set -eu

INSTALL_DIR="${RENDOBAR_INSTALL_DIR:-$HOME/.rendobar/bin}"
CONFIG_DIR="${RENDOBAR_CONFIG_DIR:-$HOME/.rendobar}"
BIN_NAME="rb"
PURGE="${RENDOBAR_PURGE:-0}"
NO_MODIFY_PATH="${RENDOBAR_NO_MODIFY_PATH:-0}"

removed_any=0

# 1. Remove binary
if [ -f "$INSTALL_DIR/$BIN_NAME" ]; then
  rm -f "$INSTALL_DIR/$BIN_NAME"
  echo "Removed $INSTALL_DIR/$BIN_NAME"
  removed_any=1
  # rmdir only succeeds if empty -- safe no-op when bin dir still has files.
  rmdir "$INSTALL_DIR" 2>/dev/null || true
else
  echo "No binary at $INSTALL_DIR/$BIN_NAME (skipping)"
fi

# 2. Remove PATH entry from shell rc files.
# install.sh appends:  <blank>\n# Added by Rendobar installer\n<export/set line>\n
# Strip the marker + the one following line (the export/set statement).
if [ "$NO_MODIFY_PATH" = "1" ]; then
  echo "Skipping rc cleanup (RENDOBAR_NO_MODIFY_PATH=1)."
else
  for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.config/fish/config.fish"; do
    [ -f "$RC" ] || continue
    if grep -q "# Added by Rendobar installer" "$RC" 2>/dev/null; then
      tmp="$(mktemp)"
      # Trap cleanup of the stray temp file in case awk or mv fails mid-way.
      trap 'rm -f "$tmp"' EXIT
      awk '
        /# Added by Rendobar installer/ { skip = 1; next }
        skip > 0 { skip--; next }
        { print }
      ' "$RC" > "$tmp"
      mv "$tmp" "$RC"
      trap - EXIT
      echo "Cleaned PATH entry from $RC"
      removed_any=1
    fi
  done
fi

# 3. Config dir (auth tokens) -- opt-in via RENDOBAR_PURGE=1
if [ "$PURGE" = "1" ]; then
  if [ -d "$CONFIG_DIR" ]; then
    rm -rf "$CONFIG_DIR"
    echo "Removed config dir $CONFIG_DIR"
    removed_any=1
  fi
else
  if [ -d "$CONFIG_DIR" ]; then
    echo ""
    echo "Config dir kept: $CONFIG_DIR"
    echo "  (contains auth tokens and cached settings)"
    echo "  To also remove it: RENDOBAR_PURGE=1 curl -fsSL https://rendobar.com/uninstall.sh | sh"
  fi
fi

echo ""
if [ "$removed_any" = "1" ]; then
  echo "Rendobar CLI uninstalled."
  echo "Revoke API keys at https://app.rendobar.com/settings/api-keys if needed."
else
  echo "Nothing to uninstall -- no Rendobar CLI found."
fi
