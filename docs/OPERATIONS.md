# Operations runbook

## Health check

```
curl https://photos.yourdomain/health
```

200 if DB reachable + photo count surfaced. 503 if DB is down. Hook this into
**Uptime Kuma / Hetzner / better-stack** to page you when it stops responding.

Schema of the JSON:
```jsonc
{
  "ok": true,
  "photoCount": 24,
  "located": 17,
  "unlocated": 7,
  "favorites": 3,
  "manualLocation": 1,
  "dbBytes": 28672,
  "durationMs": 4,
  "node": "v22.x",
  "timestamp": "2026-06-19T12:34:56.000Z"
}
```

## Rate limiting

`/api/metadata` POST and DELETE are capped at **60 writes / minute / IP**
(in-memory leaky bucket, per `x-forwarded-for` if behind a proxy). Past the
cap → `429 Too Many Requests` with a `Retry-After` header. Resets when the
oldest hit in the window ages out.

If you sit behind a reverse proxy, make sure it sets `X-Forwarded-For` so the
limiter sees per-client IPs (not the proxy's own IP):

```nginx
location / {
  proxy_pass http://localhost:4321;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Real-IP $remote_addr;
}
```

## Auto backup (systemd timer)

The `npm run backup` script zips `.astro/content.db`, `metadata.json`, and
`public/thumbs/` into `./backups/photo-portfolio-<timestamp>.zip`. Wire it to
run nightly:

`/etc/systemd/system/photo-portfolio-backup.service`
```ini
[Unit]
Description=Photo Portfolio nightly backup

[Service]
Type=oneshot
User=photoportfolio
WorkingDirectory=/srv/photo-portfolio
ExecStart=/usr/bin/npm run backup
```

`/etc/systemd/system/photo-portfolio-backup.timer`
```ini
[Unit]
Description=Run photo portfolio backup at 04:00 daily

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now photo-portfolio-backup.timer
sudo systemctl list-timers photo-portfolio-backup.timer
```

### Rotate / prune

The script doesn't prune. Add a tiny cleanup in the same service or just:

```bash
find /srv/photo-portfolio/backups -name '*.zip' -mtime +14 -delete
```

### Plain cron alternative

If you're not on systemd:
```cron
0 4 * * *  cd /srv/photo-portfolio && /usr/bin/npm run backup >> /var/log/photo-portfolio-backup.log 2>&1
0 5 * * *  find /srv/photo-portfolio/backups -name '*.zip' -mtime +14 -delete
```

## Restore from a backup

```bash
cd /srv/photo-portfolio
sudo systemctl stop photo-portfolio          # or however you run it
unzip backups/photo-portfolio-2026-06-19T04-00-00.zip
sudo systemctl start photo-portfolio
```

The zip contains `.astro/content.db`, `metadata.json`, and `public/thumbs/`,
so unzipping at the project root overwrites everything in place.

## Logs

Astro server logs to stdout. Capture with journalctl if running under systemd:
```bash
journalctl -u photo-portfolio -f
```

Errors you care about: `[photos] sync:` lines (Nextcloud reachability),
`429` responses (someone hammering the API), 5xx in nginx access logs.

## Common ops

| Action | Command |
|---|---|
| Re-sync immediately | `npm run sync` |
| Backup now | `npm run backup` |
| Rebuild + restart | `npm run predeploy && sudo systemctl restart photo-portfolio` |
| Reset DB (nuke + re-seed) | `rm .astro/content.db && npm run sync` |
| Tail health | `watch -n 5 'curl -s localhost:4321/health \| jq .'` |
