# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app

# System libs for sharp (libvips).
RUN apk add --no-cache vips-dev build-base python3 pkgconfig

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .

# Public site URL bakes into the build (Astro reads SITE_URL in
# astro.config.mjs for canonical, og:url, sitemap entries). Override per
# environment with `docker build --build-arg SITE_URL=https://...`.
ARG SITE_URL=http://localhost:4321
ENV SITE_URL=${SITE_URL}

# Builds with Astro DB; ASTRO_DATABASE_FILE is wired via .env or runtime env.
RUN npm run build

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

# sharp's libvips runtime, plus the tools the backup + verify scripts
# shell out to: zip/unzip for archive operations, sqlite for the
# row-count step of npm run verify-backup. tini handles signals.
RUN apk add --no-cache vips tini zip unzip sqlite

# Drop privileges
RUN addgroup -g 1001 app && adduser -D -u 1001 -G app app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/db ./db
COPY --from=builder --chown=app:app /app/.astro ./.astro
COPY --from=builder --chown=app:app /app/scripts ./scripts
COPY --from=builder --chown=app:app /app/metadata.json ./metadata.json
COPY --from=builder --chown=app:app /app/package.json ./

USER app
EXPOSE 4321

# tini handles signals so docker stop is graceful
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/entry.mjs"]
