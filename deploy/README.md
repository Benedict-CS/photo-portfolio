# Deploy — LAN Ubuntu VM

This folder contains the scripts and systemd units needed to run the
portfolio on a Linux VM as a self-managed service.

Tested on **Ubuntu 22.04 / 24.04**, bare Node 22 via NodeSource, no Docker.

## What gets installed

| Piece | Purpose | Location |
| --- | --- | --- |
| `photo-portfolio.service` | The Astro/Node server | systemd unit |
| `photo-portfolio-backup.{service,timer}` | Daily zip of DB + thumbs | 03:30 local time |
| Node 22.x | Runtime | `/usr/bin/node` via NodeSource |
| App code | Repo clone | `~/photo-portfolio/` |
| Backups | Zip archives | `~/photo-portfolio/backups/` |

The app listens on **`0.0.0.0:4321`**, so any device on the LAN can hit
`http://<vm-ip>:4321/`.

## First-time install

```bash
# On the VM, as your normal user (e.g. ben — NOT root):
ssh ben@192.168.1.xxx

# 1. Clone the repo into your home directory
git clone https://github.com/Benedict-CS/photo-portfolio.git ~/photo-portfolio
cd ~/photo-portfolio

# 2. Copy your .env from the dev machine (run this on the Windows side):
#    scp .env ben@192.168.1.xxx:photo-portfolio/
#    Required keys:
#      NEXTCLOUD_URL=https://cloud.ben.winlab.tw
#      NEXTCLOUD_SHARE_TOKEN=65XGM5PRjLPnj8q
#      NEXTCLOUD_SHARE_PASSWORD=...
#      ADMIN_PASSWORD=...
#    Optional:
#      SITE_URL=http://192.168.1.xxx:4321   # for canonical/sitemap URLs

# 3. Run the installer — it'll ask for your sudo password.
bash deploy/install.sh
```

You should see `Open the site: http://192.168.1.xxx:4321/` at the end.
Open it in a browser; the map should load with your photos.

## Updates

```bash
ssh ben@192.168.1.xxx
cd ~/photo-portfolio
bash deploy/update.sh
```

This pulls the latest `main`, rebuilds, and restarts the service.

## Operations cheat-sheet

```bash
# Service
sudo systemctl status  photo-portfolio
sudo systemctl restart photo-portfolio
sudo systemctl stop    photo-portfolio

# Logs (live tail)
journalctl -u photo-portfolio -f

# Health check (uptime monitors / cron)
curl http://localhost:4321/health

# Backup — manual run
sudo systemctl start photo-portfolio-backup

# Next scheduled backup
systemctl list-timers photo-portfolio-backup.timer

# Restore (from a backup zip)
unzip -d ~/restore backups/photo-portfolio-YYYY-MM-DD.zip
# then copy .astro/content.db + public/thumbs/ back into the app dir
# and `sudo systemctl restart photo-portfolio`
```

## Network

LAN-only by default, no HTTPS. If you later want `http://photos.local`
without typing the port, you have two clean options:

1. **Caddy** (recommended — 5 lines):

   ```caddyfile
   :80 {
     reverse_proxy localhost:4321
     encode gzip
     header Cache-Control "public, max-age=60"
     handle_path /thumbs/* {
       header Cache-Control "public, max-age=31536000, immutable"
       reverse_proxy localhost:4321
     }
   }
   ```

   `sudo apt install caddy && sudo systemctl enable --now caddy`.

2. **nginx** — same idea, more boilerplate.

## Uninstall

```bash
sudo systemctl disable --now photo-portfolio photo-portfolio-backup.timer
sudo rm /etc/systemd/system/photo-portfolio*.service \
        /etc/systemd/system/photo-portfolio*.timer
sudo systemctl daemon-reload
rm -rf ~/photo-portfolio
```
