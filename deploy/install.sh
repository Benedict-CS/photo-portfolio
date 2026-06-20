#!/usr/bin/env bash
# Photo Portfolio — first-time install for Ubuntu LTS (22.04 / 24.04).
#
# Run as the user that will own the app (e.g. `ben`), NOT root:
#   ssh ben@192.168.1.xxx
#   git clone https://github.com/Benedict-CS/photo-portfolio.git ~/photo-portfolio
#   cd ~/photo-portfolio
#   bash deploy/install.sh
#
# The script is idempotent — re-running it is safe. You'll be prompted
# for `sudo` (apt + systemctl) along the way.

set -euo pipefail

APP_NAME="photo-portfolio"
APP_USER="${USER}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MAJOR="22"
SERVICE_NAME="photo-portfolio"
BACKUP_NAME="photo-portfolio-backup"

# Pretty headings
say() { printf "\n\033[1;34m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m⚠ %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m✖ %s\033[0m\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "Do NOT run as root. Run as your normal user (e.g. ben)."
[[ -f "$APP_DIR/package.json" ]] || die "package.json not found in $APP_DIR — clone the repo first."

say "Installing system packages (apt)"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg

if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null | sed 's/^v//;s/\..*$//')" -lt "$NODE_MAJOR" ]]; then
  say "Installing Node.js $NODE_MAJOR.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node $(node -v) already installed"
fi

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
say "Using node at $NODE_BIN"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  warn ".env is missing — copy it from your dev machine BEFORE the service can start:"
  echo "    scp .env ${APP_USER}@<this-host>:${APP_DIR}/"
  echo "Required keys: NEXTCLOUD_URL, NEXTCLOUD_SHARE_TOKEN, NEXTCLOUD_SHARE_PASSWORD, ADMIN_PASSWORD"
  echo "Optional:      SITE_URL (e.g. http://192.168.1.50:4321 for LAN)"
fi

say "Installing npm dependencies"
$NPM_BIN ci --no-audit --no-fund

say "Building production bundle"
$NPM_BIN run build

# ---------- systemd: app service ----------

say "Writing systemd unit for the app"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Photo Portfolio (Astro + Node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=HOST=0.0.0.0
Environment=PORT=4321
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${APP_DIR}/dist/server/entry.mjs
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

# ---------- systemd: nightly backup ----------

say "Writing systemd backup service + timer"
sudo tee "/etc/systemd/system/${BACKUP_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Photo Portfolio nightly backup (DB + thumbs)
After=network.target

[Service]
Type=oneshot
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NPM_BIN} run backup
EOF

sudo tee "/etc/systemd/system/${BACKUP_NAME}.timer" >/dev/null <<EOF
[Unit]
Description=Run photo-portfolio backup every night

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
EOF

say "Reloading systemd + enabling units"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"
sudo systemctl enable --now "${BACKUP_NAME}.timer"

# ---------- Summary ----------
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT=4321

say "Done."
cat <<EOF

Service status:
  sudo systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f       # tail logs

Backup timer:
  systemctl list-timers ${BACKUP_NAME}.timer
  sudo systemctl start  ${BACKUP_NAME}   # run one now

Open the site:
  http://${HOST_IP:-<this-host>}:${PORT}/

To update later:
  cd ${APP_DIR} && bash deploy/update.sh

If .env wasn't on disk, copy it now then:
  sudo systemctl restart ${SERVICE_NAME}
EOF
