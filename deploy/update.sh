#!/usr/bin/env bash
# Photo Portfolio — one-button update.
#
# What it does:
#   1. git pull (hard reset to origin/main)
#   2. detect Docker vs bare-Node systemd
#   3. rebuild + restart in whichever mode is live
#
# You only need to remember:
#   cd ~/photo-portfolio && bash deploy/update.sh
#
# Want it even shorter? Add this to ~/.bashrc:
#   alias pp-update='cd ~/photo-portfolio && bash deploy/update.sh'

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="photo-portfolio"

say()  { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }

cd "$APP_DIR"

# ---- 1. Pull latest --------------------------------------------------------
say "Fetching latest main"
git fetch --quiet origin
BEFORE_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"
git reset --hard origin/main
AFTER_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

# ---- 2. Pick the docker command (no-sudo wins, sudo as fallback) -----------
DOCKER=""
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
  elif sudo -n docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    warn "Falling back to 'sudo docker' — log out + back in (or run 'newgrp docker') to use docker without sudo."
  fi
fi

# ---- 3. Docker mode --------------------------------------------------------
if [[ -n "$DOCKER" ]] && [[ -f "$APP_DIR/docker-compose.yml" ]] \
   && $DOCKER compose ps --services 2>/dev/null | grep -qx "app"; then
  say "Docker mode — rebuilding and restarting the container"
  $DOCKER compose up -d --build

  say "Waiting for /health to go green…"
  for _ in $(seq 1 30); do
    if curl -fsS http://localhost:4321/health >/dev/null 2>&1; then
      say "Healthy. Tail logs with:  $DOCKER compose logs -f app"
      exit 0
    fi
    sleep 1
  done
  warn "/health didn't go green within 30s — check logs:  $DOCKER compose logs --tail 50 app"
  exit 1
fi

# ---- 4. Bare-Node systemd mode --------------------------------------------
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
