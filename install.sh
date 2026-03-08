#!/usr/bin/env bash
set -euo pipefail

# claude-sync online installer
# Usage: curl -fsSL https://raw.githubusercontent.com/berlinguyinca/claude-sync/main/install.sh | bash

REPO="berlinguyinca/claude-sync"
INSTALL_DIR="${CLAUDE_SYNC_INSTALL_DIR:-$HOME/.claude-sync-cli}"
BIN_LINK="/usr/local/bin/claude-sync"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m%s\033[0m\n' "$*"; }
err()   { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# ── preflight ──────────────────────────────────────────────────────

command -v git  >/dev/null 2>&1 || err "git is required but not installed"
command -v node >/dev/null 2>&1 || err "Node.js is required but not installed"
command -v npm  >/dev/null 2>&1 || err "npm is required but not installed"

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22+ is required (found v$(node -v | tr -d v))"
fi

# ── install ────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  info "Cloning claude-sync into $INSTALL_DIR..."
  git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

info "Installing dependencies..."
(cd "$INSTALL_DIR" && npm install --no-fund --no-audit --loglevel=error)

info "Building..."
(cd "$INSTALL_DIR" && npm run build --silent)

# ── link ───────────────────────────────────────────────────────────

info "Creating symlink..."

# Try /usr/local/bin first, fall back to ~/.local/bin
if [ -w "$(dirname "$BIN_LINK")" ] || [ -w "$BIN_LINK" ] 2>/dev/null; then
  ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_LINK"
  ok "Linked claude-sync -> $BIN_LINK"
elif [ -t 0 ] && command -v sudo >/dev/null 2>&1; then
  # Only use sudo when running interactively (not piped)
  sudo ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_LINK"
  ok "Linked claude-sync -> $BIN_LINK (via sudo)"
else
  FALLBACK_BIN="$HOME/.local/bin"
  mkdir -p "$FALLBACK_BIN"
  ln -sf "$INSTALL_DIR/dist/cli.js" "$FALLBACK_BIN/claude-sync"
  ok "Linked claude-sync -> $FALLBACK_BIN/claude-sync"
  case ":$PATH:" in
    *":$FALLBACK_BIN:"*) ;;
    *) printf '\n\033[1;33m%s\033[0m\n' "Add $FALLBACK_BIN to your PATH:"
       echo "  export PATH=\"$FALLBACK_BIN:\$PATH\"";;
  esac
fi

# ── done ───────────────────────────────────────────────────────────

echo ""
ok "claude-sync installed successfully!"
echo ""
echo "Get started:"
echo "  claude-sync init                  # sync your existing ~/.claude"
echo "  claude-sync bootstrap <repo-url>  # set up from a remote repo"
echo ""
