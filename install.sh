#!/usr/bin/env bash
set -euo pipefail

# ai-sync online installer
# Usage: curl -fsSL https://raw.githubusercontent.com/berlinguyinca/ai-sync/main/install.sh | bash

REPO="johnzastrow/ai-sync"
PINNED_VERSION="v0.2.3"   # Updated on each release — pinned to avoid pulling unreviewed main
INSTALL_DIR="${AI_SYNC_INSTALL_DIR:-${CLAUDE_SYNC_INSTALL_DIR:-$HOME/.ai-sync-cli}}"
SYNC_DIR="$HOME/.ai-sync"
BIN_LINK="/usr/local/bin/ai-sync"
DEFAULT_REPO_NAME="ai-config"

info()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m%s\033[0m\n' "$*"; }
err()   { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# Read user input — works even when script is piped via curl | bash
# Returns the value via stdout; caller captures with $()
prompt() {
  local msg="$1" default="$2" reply=""
  if [ ! -e /dev/tty ]; then
    # No tty available (headless/Docker) — use default silently
    echo "$default"
    return
  fi
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$msg" "$default" >/dev/tty
  else
    printf '%s: ' "$msg" >/dev/tty
  fi
  read -r reply </dev/tty || true
  if [ -z "$reply" ]; then
    echo "$default"
  else
    echo "$reply"
  fi
}

# ── uninstall ─────────────────────────────────────────────────────

if [ "${1:-}" = "--uninstall" ]; then
  info "Uninstalling ai-sync..."

  # Remove symlinks
  for link in "$BIN_LINK" "$HOME/.local/bin/ai-sync"; do
    if [ -L "$link" ]; then
      rm -f "$link" 2>/dev/null || sudo rm -f "$link" 2>/dev/null || true
      ok "Removed symlink: $link"
    fi
  done

  # Remove install directory
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed install directory: $INSTALL_DIR"
  fi

  echo ""
  ok "ai-sync uninstalled."
  echo ""
  echo "Your sync repo and backups were NOT removed:"
  echo "  Sync repo: $SYNC_DIR"
  echo "  Backups:   $HOME/.ai-sync-backups/"
  echo ""
  echo "To remove them too: rm -rf $SYNC_DIR $HOME/.ai-sync-backups"
  exit 0
fi

# ── migration from claude-sync ────────────────────────────────────

# Rename old install directory
if [ -d "$HOME/.claude-sync-cli" ] && [ ! -d "$INSTALL_DIR" ]; then
  info "Migrating install directory: ~/.claude-sync-cli -> ~/.ai-sync-cli"
  mv "$HOME/.claude-sync-cli" "$INSTALL_DIR"
fi

# Rename old sync directory
if [ -d "$HOME/.claude-sync" ] && [ ! -d "$SYNC_DIR" ]; then
  info "Migrating sync directory: ~/.claude-sync -> ~/.ai-sync"
  mv "$HOME/.claude-sync" "$SYNC_DIR"
fi

# Remove old symlink
if [ -L "/usr/local/bin/claude-sync" ]; then
  info "Removing old claude-sync symlink..."
  rm -f "/usr/local/bin/claude-sync" 2>/dev/null || sudo rm -f "/usr/local/bin/claude-sync" 2>/dev/null || true
fi
if [ -L "$HOME/.local/bin/claude-sync" ]; then
  rm -f "$HOME/.local/bin/claude-sync" 2>/dev/null || true
fi

# ── preflight ──────────────────────────────────────────────────────

command -v git >/dev/null 2>&1 || err "git is required but not installed"

# Check if Node.js 22+ is available
needs_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  local major
  major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  [ "$major" -lt 22 ]
}

NODE_VERSION="22"

install_node() {
  info "Node.js 22+ is required. Attempting to install..."

  # 1. Try fnm (fast node manager)
  if command -v fnm >/dev/null 2>&1; then
    info "Installing Node.js $NODE_VERSION via fnm..."
    fnm install "$NODE_VERSION"
    fnm use "$NODE_VERSION"
    eval "$(fnm env)"
    # Ensure fnm's node is first in PATH
    FNM_NODE_DIR="$(dirname "$(fnm exec --using="$NODE_VERSION" which node 2>/dev/null)")" || true
    if [ -n "$FNM_NODE_DIR" ] && [ -d "$FNM_NODE_DIR" ]; then
      export PATH="$FNM_NODE_DIR:$PATH"
    fi
    hash -r 2>/dev/null || true
    return 0
  fi

  # 2. Try nvm
  if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing Node.js $NODE_VERSION via nvm..."
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_VERSION"
    nvm use "$NODE_VERSION"
    hash -r 2>/dev/null || true
    return 0
  fi
  # Check common nvm locations even if NVM_DIR isn't set
  for nvm_path in "$HOME/.nvm/nvm.sh" "/usr/local/opt/nvm/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh"; do
    if [ -s "$nvm_path" ]; then
      info "Installing Node.js $NODE_VERSION via nvm..."
      export NVM_DIR="$(dirname "$nvm_path")"
      # shellcheck source=/dev/null
      . "$nvm_path"
      nvm install "$NODE_VERSION"
      nvm use "$NODE_VERSION"
      hash -r 2>/dev/null || true
      return 0
    fi
  done

  # 3. Try Homebrew (macOS)
  if command -v brew >/dev/null 2>&1; then
    info "Installing Node.js $NODE_VERSION via Homebrew..."
    brew install "node@$NODE_VERSION"
    # brew link may fail if unversioned 'node' formula is installed; that's OK
    brew link --overwrite "node@$NODE_VERSION" 2>/dev/null || true
    # Add Homebrew's node@22 bin to PATH so it takes precedence over old node
    BREW_NODE_BIN="$(brew --prefix "node@$NODE_VERSION" 2>/dev/null)/bin"
    if [ -d "$BREW_NODE_BIN" ]; then
      export PATH="$BREW_NODE_BIN:$PATH"
    fi
    hash -r 2>/dev/null || true
    return 0
  fi

  # Methods below require curl
  if ! command -v curl >/dev/null 2>&1; then
    err "No Node.js version manager (fnm/nvm) or Homebrew found, and curl is not available to download Node.js. Install Node.js 22+ manually."
  fi

  # 4. Download official binary (no root required, most reliable)
  info "Downloading Node.js $NODE_VERSION binary from nodejs.org..."
  local arch os_name
  arch=$(uname -m)
  os_name=$(uname -s | tr '[:upper:]' '[:lower:]')

  case "$arch" in
    x86_64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) err "Unsupported architecture: $arch" ;;
  esac

  case "$os_name" in
    linux|darwin) ;;
    *) err "Unsupported OS: $os_name" ;;
  esac

  local node_dir="$HOME/.local/node"
  local tarball_url="https://nodejs.org/dist/latest-v${NODE_VERSION}.x/node-v${NODE_VERSION}.0.0-${os_name}-${arch}.tar.xz"

  # Get the actual latest v22 URL from the index
  local latest_version
  latest_version=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_VERSION}.x/" | grep -oE "node-v${NODE_VERSION}\.[0-9]+\.[0-9]+" | head -1) || true
  if [ -n "$latest_version" ]; then
    tarball_url="https://nodejs.org/dist/latest-v${NODE_VERSION}.x/${latest_version}-${os_name}-${arch}.tar.xz"
  fi

  local tmp_tar
  tmp_tar=$(mktemp)
  curl -fsSL "$tarball_url" -o "$tmp_tar" || err "Failed to download Node.js from $tarball_url"

  mkdir -p "$node_dir"
  tar -xJf "$tmp_tar" -C "$node_dir" --strip-components=1
  rm -f "$tmp_tar"

  export PATH="$node_dir/bin:$PATH"
  ok "Node.js installed to $node_dir"
  warn "Add Node.js to your PATH permanently:"
  echo "  export PATH=\"$node_dir/bin:\$PATH\""
}

if needs_node; then
  if command -v node >/dev/null 2>&1; then
    warn "Node.js $(node -v | tr -d v) found, but 22+ is required"
  fi
  install_node
fi

# Verify after install attempt
command -v node >/dev/null 2>&1 || err "Node.js installation failed — node not found in PATH"
command -v npm  >/dev/null 2>&1 || err "npm not found after Node.js install"

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22+ is required (found v$(node -v | tr -d v) after install attempt)"
fi

ok "Node.js $(node -v | tr -d v) found"

# ── install ────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation in $INSTALL_DIR to $PINNED_VERSION..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/$PINNED_VERSION"
  git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
else
  info "Cloning ai-sync $PINNED_VERSION into $INSTALL_DIR..."
  git clone --depth 1 --branch "$PINNED_VERSION" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

info "Installing dependencies..."
(cd "$INSTALL_DIR" && npm install --no-fund --no-audit --loglevel=error)

info "Updating package.json version to $PINNED_VERSION..."
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${PINNED_VERSION#v}\"/" "$INSTALL_DIR/package.json" 2>/dev/null || true

info "Building..."
(cd "$INSTALL_DIR" && npm run build --silent)

# ── link ───────────────────────────────────────────────────────────

info "Creating symlink..."

# Try /usr/local/bin first, fall back to ~/.local/bin
if [ -w "$(dirname "$BIN_LINK")" ] || [ -w "$BIN_LINK" ] 2>/dev/null; then
  ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_LINK"
  ok "Linked ai-sync -> $BIN_LINK"
elif [ -t 0 ] && command -v sudo >/dev/null 2>&1; then
  # Only use sudo when running interactively (not piped)
  sudo ln -sf "$INSTALL_DIR/dist/cli.js" "$BIN_LINK"
  ok "Linked ai-sync -> $BIN_LINK (via sudo)"
else
  FALLBACK_BIN="$HOME/.local/bin"
  mkdir -p "$FALLBACK_BIN"
  ln -sf "$INSTALL_DIR/dist/cli.js" "$FALLBACK_BIN/ai-sync"
  ok "Linked ai-sync -> $FALLBACK_BIN/ai-sync"
  case ":$PATH:" in
    *":$FALLBACK_BIN:"*) ;;
    *) warn "Add $FALLBACK_BIN to your PATH:"
       echo "  export PATH=\"$FALLBACK_BIN:\$PATH\"";;
  esac
fi

echo ""
ok "ai-sync installed successfully!"

# Use the built binary directly — symlink may not be in PATH yet
AI_SYNC="node $INSTALL_DIR/dist/cli.js"

# ── environment selection ──────────────────────────────────────────

info "Which environments do you want to sync?"
echo "  1) Claude Code only (default)"
echo "  2) OpenCode only"
echo "  3) Both Claude Code and OpenCode"
ENV_CHOICE=$(prompt "Choose" "1")

case "$ENV_CHOICE" in
  1) echo '["claude"]' > "$INSTALL_DIR/.environments.json" ;;
  2) echo '["opencode"]' > "$INSTALL_DIR/.environments.json" ;;
  3) echo '["claude","opencode"]' > "$INSTALL_DIR/.environments.json" ;;
  *) warn "Invalid choice '$ENV_CHOICE', using Claude Code only"
     echo '["claude"]' > "$INSTALL_DIR/.environments.json" ;;
esac

# Install slash commands (e.g., /sync)
info "Installing slash command skills..."
$AI_SYNC install-skills --no-update-check 2>/dev/null && ok "Slash commands installed" || warn "Skill installation skipped (run 'ai-sync install-skills' later)"

# ── setup sync repo ───────────────────────────────────────────────

# Skip setup if sync repo already exists (update flow)
if [ -d "$SYNC_DIR/.git" ]; then
  echo ""
  ok "Sync repo already configured at $SYNC_DIR"
  echo "  ai-sync push    # push local changes"
  echo "  ai-sync pull    # pull remote changes"
  echo "  ai-sync status  # check sync state"
  echo ""
  exit 0
fi

# Check if ~/.claude exists (first machine vs new machine)
if [ ! -d "$HOME/.claude" ]; then
  echo ""
  warn "No ~/.claude directory found. Run claude first to generate config,"
  echo "then run: ai-sync init"
  echo ""
  exit 0
fi

echo ""
info "Let's set up your sync repo."
echo ""

# Check for gh CLI
if ! command -v gh >/dev/null 2>&1; then
  warn "GitHub CLI (gh) not found — skipping automatic repo creation."
  echo ""
  echo "Create a repo on GitHub manually, then run:"
  echo "  ai-sync init"
  echo "  cd ~/.ai-sync && git remote add origin <repo-url>"
  echo "  ai-sync push"
  echo ""
  exit 0
fi

# Verify gh is authenticated
if ! gh auth status >/dev/null 2>&1; then
  warn "GitHub CLI not authenticated — skipping automatic repo creation."
  echo "Run 'gh auth login' first, then:"
  echo "  ai-sync init"
  echo "  cd ~/.ai-sync && git remote add origin <repo-url>"
  echo "  ai-sync push"
  echo ""
  exit 0
fi

GH_USER=$(gh api user --jq '.login' 2>/dev/null) || GH_USER=""
if [ -z "$GH_USER" ]; then
  warn "Could not determine GitHub username — skipping automatic repo creation."
  echo "  ai-sync init"
  echo "  cd ~/.ai-sync && git remote add origin <repo-url>"
  echo "  ai-sync push"
  echo ""
  exit 0
fi

REPO_NAME=$(prompt "Repository name" "$DEFAULT_REPO_NAME")

# Sanitize repo name: lowercase, replace spaces/special chars with hyphens, strip leading/trailing hyphens
REPO_NAME=$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g; s/^-*//; s/-*$//')
if [ -z "$REPO_NAME" ]; then
  REPO_NAME="$DEFAULT_REPO_NAME"
fi

REPO_VISIBILITY=$(prompt "Visibility (private/public)" "private")

# Validate visibility
case "$REPO_VISIBILITY" in
  private|public) ;;
  *) warn "Invalid visibility '$REPO_VISIBILITY', using 'private'"
     REPO_VISIBILITY="private" ;;
esac

REMOTE_URL="git@github.com:$GH_USER/$REPO_NAME.git"

echo ""
info "Creating $REPO_VISIBILITY repo: $GH_USER/$REPO_NAME"

REPO_EXISTED=false
GH_CREATE_OUTPUT=$(gh repo create "$REPO_NAME" --"$REPO_VISIBILITY" --description "AI tool config synced by ai-sync" 2>&1) && {
  ok "GitHub repo created"
} || {
  if echo "$GH_CREATE_OUTPUT" | grep -qi "already exists"; then
    REPO_EXISTED=true
    ok "Repository $GH_USER/$REPO_NAME already exists — will bootstrap from it"
  else
    err "Failed to create repo: $GH_CREATE_OUTPUT"
  fi
}

if [ "$REPO_EXISTED" = true ]; then
  # Second machine: clone the existing repo and apply to local config
  info "Bootstrapping from existing repo..."
  $AI_SYNC bootstrap "$REMOTE_URL"
else
  # First machine: init from local config and push
  info "Initializing sync repo..."
  $AI_SYNC init

  info "Adding remote and pushing..."
  git -C "$SYNC_DIR" remote add origin "$REMOTE_URL" 2>/dev/null || \
    git -C "$SYNC_DIR" remote set-url origin "$REMOTE_URL"
  $AI_SYNC push
fi

echo ""
ok "All done! Your config is synced to $REMOTE_URL"
echo ""
echo "On other machines, run:"
echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash"
echo ""
