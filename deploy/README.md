# Deploy — LAN Ubuntu VM

Run modes:

| Mode | When to use | Setup |
| --- | --- | --- |
| **Bare Node + systemd** | First-ever install, quick debugging | `bash deploy/install.sh` |
| **Docker compose** | Recommended once stable; survives VM rebuilds | `bash deploy/migrate-to-docker.sh` |

The bare-Node path is simpler for the first deploy; the Docker path is the
long-term home and what every other service in the portal uses.

The app listens on **`0.0.0.0:4321`**. Any LAN device can hit
`http://<vm-ip>:4321/`. Reverse-proxy it to a real domain in front (nginx
/ Caddy / Cloudflare Tunnel) — none of the scripts assume a proxy.

---

## First-time install (bare Node)

```bash
ssh ben@192.168.1.xxx

# 1. Clone into your home directory
git clone https://github.com/Benedict-CS/photo-portfolio.git ~/photo-portfolio
cd ~/photo-portfolio

# 2. Copy your .env from the dev machine (on Windows):
#    scp .env ben@192.168.1.xxx:photo-portfolio/
#    Required keys:
#      NEXTCLOUD_URL=https://cloud.ben.winlab.tw
#      NEXTCLOUD_SHARE_TOKEN=<your token>
#      NEXTCLOUD_SHARE_PASSWORD=<your password>
#      ADMIN_PASSWORD=<your admin password>
#    Optional:
#      SITE_URL=https://gallery.ben.winlab.tw   # for canonical/sitemap URLs

# 3. Run the installer
bash deploy/install.sh
```

You'll see `Open the site: http://<vm-ip>:4321/` at the end.

## Migrating bare Node → Docker

Once the bare-Node install has run cleanly for a few days, convert to Docker:

```bash
ssh ben@192.168.1.xxx
cd ~/photo-portfolio
git pull
bash deploy/migrate-to-docker.sh
```

The script:

- installs Docker Engine + compose plugin from the official apt repo (if absent)
- stops + disables the systemd `photo-portfolio.service` (left on disk for rollback)
- repoints the nightly backup timer at `docker compose exec`
- builds the image, bakes `SITE_URL` from `.env` into the bundle, and starts the container
- waits for `/health` before reporting done

After this, `~/photo-portfolio/{.astro,public/thumbs,backups}` are bind-mounted
into the container, so you can still inspect/edit them from the host.

## Updates (works in either mode)

```bash
cd ~/photo-portfolio
bash deploy/update.sh           # NOT sudo — it'll prompt for sudo where needed
```

`update.sh` auto-detects the current mode and does the right thing
(`docker compose up -d --build` vs `npm run build` + `systemctl restart`).

## Operations cheat-sheet

### Bare-Node mode

```bash
sudo systemctl status  photo-portfolio
sudo systemctl restart photo-portfolio
journalctl -u photo-portfolio -f
```

### Docker mode

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down            # stop
docker compose up -d           # start
docker compose exec app sh     # poke around inside
```

### Both

```bash
curl http://localhost:4321/health        # JSON health blob
systemctl list-timers photo-portfolio-backup.timer
sudo systemctl start  photo-portfolio-backup   # run a backup now
```

## Rollback Docker → bare Node

```bash
docker compose down
sudo systemctl enable --now photo-portfolio.service
```

(The systemd unit file is left on `/etc/systemd/system/` after migration
specifically to make this trivial.)

## Restore from backup

Backups live in `~/photo-portfolio/backups/photo-portfolio-YYYY-MM-DD.zip`
and contain `.astro/content.db` + `metadata.json` + `public/thumbs/`.

```bash
cd ~/photo-portfolio
# stop whichever mode is running
docker compose down 2>/dev/null || sudo systemctl stop photo-portfolio

unzip -o backups/photo-portfolio-YYYY-MM-DD.zip
# unzip restores files into the working directory in-place

# start again
docker compose up -d 2>/dev/null || sudo systemctl start photo-portfolio
```

## Uninstall

```bash
docker compose down 2>/dev/null || true
sudo systemctl disable --now photo-portfolio photo-portfolio-backup.timer 2>/dev/null || true
sudo rm /etc/systemd/system/photo-portfolio*.service \
        /etc/systemd/system/photo-portfolio*.timer 2>/dev/null || true
sudo systemctl daemon-reload
rm -rf ~/photo-portfolio
```
