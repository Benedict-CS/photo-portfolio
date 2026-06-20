#!/usr/bin/env bash
# Photo Portfolio — update an existing install.
#
#   cd ~/photo-portfolio && bash deploy/update.sh
#
# Auto-detects whether the app is running under Docker (compose) or
# bare-Node systemd, and does the right thing in each case.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="photo-portfolio"

say() { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }

cd "$APP_DIR"

say "Fetching latest main"
git fetch --quiet origin
BEFORE_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"
git reset --hard origin/main
AFTER_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

# --- Docker mode -------------------------------------------------------------
if command -v docker >/dev/null && docker compose ps --services 2>/dev/null | grep -q "^app$"; then
  say "Docker mode — rebuilding and restarting the container"
  docker compose up -d --build
  say "Done. Tail logs with:  docker compose logs -f app"
  exit 0
fi

# --- Bare-Node systemd mode --------------------------------------------------
if [[ "$BEFORE_LOCK" != "$AFTER_LOCK" || ! -d node_modules ]]; then
  say "Lockfile changed → npm ci"
  npm ci --no-audit --no-fund
else
  say "Lockfile unchanged → skipping npm ci"
fi

say "Rebuilding"
npm run build

say "Restarting systemd service"
sudo systemctl restart "${SERVICE_NAME}.service"

say "Done. Current status:"
sudo systemctl --no-pager --lines=5 status "${SERVICE_NAME}.service" || true
