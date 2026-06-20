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

## Migrating to TrueNAS Scale (or another VM)

Once you're on Docker, the whole app is just **one folder + one `docker compose up`**.
Two paths depending on the target:

### Plain VM-to-VM (rsync)

On the source VM, stop the app:

```bash
docker compose down
```

On the destination (already has Docker installed):

```bash
sudo rsync -av --info=progress2 \
  ben@<old-vm>:~/photo-portfolio/ \
  ~/photo-portfolio/
cd ~/photo-portfolio
docker compose up -d --build
```

That's it — `.astro/`, `public/thumbs/`, `backups/`, `.env`, source code all
come over in one shot. The image rebuilds locally from the Dockerfile.

### TrueNAS Scale

Two flavours, pick one:

**a) Custom App / docker-compose (recommended)** — TrueNAS Scale (≥ 24.10
"Electric Eel") ships native Docker. Create a dataset for the app:

```bash
# On TrueNAS shell
mkdir -p /mnt/<pool>/apps/photo-portfolio
rsync -av ben@<old-vm>:~/photo-portfolio/ /mnt/<pool>/apps/photo-portfolio/
cd /mnt/<pool>/apps/photo-portfolio
docker compose up -d --build
```

Open the Apps → Custom App UI and point it at the compose file if you want
TrueNAS to manage the lifecycle, or just leave it as `docker compose` on
the shell. Either way, the bind-mounted dataset is the source of truth
and snapshot-able with ZFS.

**b) Built-in app catalog** — none exists for this app (it's bespoke), so
use option (a).

### After migration

```bash
# Sanity-check on the new host:
curl -fsS http://localhost:4321/health | jq
docker compose logs --tail 50 app

# Update DNS / reverse proxy to point at the new IP, then optionally
# tear down the old VM.
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
