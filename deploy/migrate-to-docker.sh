#!/usr/bin/env bash
# Migrate an existing bare-Node systemd install over to Docker compose.
#
#   cd ~/photo-portfolio && bash deploy/migrate-to-docker.sh
#
# This is a ONE-WAY move (the systemd app unit is disabled). Your data
# (.astro/content.db, public/thumbs/, backups/, .env) is bind-mounted
# into the container so nothing is copied or lost.
#
# Safe to re-run — it's idempotent.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="photo-portfolio"
BACKUP_NAME="photo-portfolio-backup"

say()  { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m✖ %s\033[0m\n" "$*" >&2; exit 1; }

cd "$APP_DIR"
[[ -f docker-compose.yml ]] || die "docker-compose.yml not found — run `git pull` first."
[[ -f .env ]] || die ".env missing — Docker run needs it."

# --- 1. Install Docker if absent ---------------------------------------------
if ! command -v docker >/dev/null; then
  say "Installing Docker Engine + compose plugin (official apt repo)"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
  fi
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  warn "You were added to the 'docker' group. Re-login (or 'newgrp docker') if the next step fails with a permissions error."
else
  say "Docker already installed ($(docker --version))"
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  warn "Falling back to 'sudo docker' for this session — re-login to use docker without sudo."
  DOCKER="sudo docker"
fi

# --- 2. Stop and disable the bare-Node systemd unit --------------------------
if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  say "Stopping + disabling systemd unit ${SERVICE_NAME}.service"
  sudo systemctl disable --now "${SERVICE_NAME}.service" || true
  warn "The unit file is left on disk at /etc/systemd/system/${SERVICE_NAME}.service (rollback-ready)."
  warn "Delete it manually once you're confident Docker is the new home."
fi

# --- 3. Repoint the backup timer at 'docker compose exec' --------------------
if systemctl list-unit-files | grep -q "^${BACKUP_NAME}.service"; then
  say "Repointing backup service to run inside the container"
  sudo tee "/etc/systemd/system/${BACKUP_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Photo Portfolio nightly backup (DB + thumbs, via docker)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=${USER}
WorkingDirectory=${APP_DIR}
ExecStart=${DOCKER##sudo } compose exec -T app npm run backup
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${BACKUP_NAME}.timer"
fi

# --- 3b. Backup AUTO-VERIFY — runs an hour after the backup ------------------
# Tests the newest zip: integrity, SQLite header, Photo row count. Loud
# failure surfaces a broken backup BEFORE you actually need to restore.
say "Installing backup-verify service + timer"
sudo apt-get install -y unzip sqlite3 >/dev/null 2>&1 || true
sudo tee "/etc/systemd/system/photo-portfolio-verify.service" >/dev/null <<EOF
[Unit]
Description=Photo Portfolio backup verification (restores newest backup + checks DB)
After=docker.service ${BACKUP_NAME}.service
Requires=docker.service

[Service]
Type=oneshot
User=${USER}
WorkingDirectory=${APP_DIR}
ExecStart=${DOCKER##sudo } compose exec -T app npm run verify-backup
EOF
sudo tee "/etc/systemd/system/photo-portfolio-verify.timer" >/dev/null <<EOF
[Unit]
Description=Run photo-portfolio backup verification daily (after backup)

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now photo-portfolio-verify.timer

# --- 4. Build the image and start the container ------------------------------
say "Building the Docker image (SITE_URL from .env will bake into the bundle)"
$DOCKER compose build

say "Starting the container"
$DOCKER compose up -d

say "Waiting for /health to go green…"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:4321/health >/dev/null 2>&1; then
    say "Container is healthy"
    break
  fi
  sleep 1
done

# --- Summary -----------------------------------------------------------------
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT=4321
say "Migration done."
cat <<EOF

Container status:
  ${DOCKER} compose ps
  ${DOCKER} compose logs -f app

Updates from here:
  cd ${APP_DIR}
  git pull
  ${DOCKER} compose up -d --build

Open the site:
  http://${HOST_IP:-<this-host>}:${PORT}/    (or your reverse-proxied domain)

Rolling back to bare Node (if needed):
  ${DOCKER} compose down
  sudo systemctl enable --now ${SERVICE_NAME}.service
EOF
