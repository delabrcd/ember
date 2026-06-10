# Built on the official Playwright image so Chromium + its OS deps are present
# for the in-process scraper. Node 20 ships in this image.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# Test stage: source + deps, no build. `docker build --target test -t ng-test ./app`
# then `docker run --rm ng-test` runs the hand-calculated unit tests.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS test
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npx", "vitest", "run"]

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Version comes from the git tag at build time (see the CI workflow). It is
# written into package.json and inlined into the app as NEXT_PUBLIC_APP_VERSION.
ARG APP_VERSION=0.0.0-dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Stamp the version, then `npm run build` (= prisma generate && next build).
RUN npm pkg set version="$APP_VERSION" && npm run build

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# poppler-utils provides `pdftotext`, used to parse the bill PDFs for the
# per-fuel supply/delivery breakdown (full history; the API only has ~24 months).
# postgresql-client provides `pg_dump`/`psql` for the entrypoint's pre-migrate
# database backup (see docker-entrypoint.sh).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils postgresql-client && rm -rf /var/lib/apt/lists/*
# Dedicated non-root user. uid/gid 1000 is taken by the base image's `ubuntu`
# user, so `ember` gets 1002. HOME lives under /tmp so chromium/psql have a
# writable home even when the uid is overridden at runtime (see below).
RUN groupadd -g 1002 ember && useradd -u 1002 -g 1002 -m -d /home/ember -s /sbin/nologin ember
ENV HOME=/tmp
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
# prisma/ carries schema.prisma only — the single source of truth, applied at boot
# via `prisma db push` (see docker-entrypoint.sh). There are no migration files.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh
# Arbitrary-uid tolerance. The image defaults to the `ember` user, but the
# operator's deployment overrides it with `user: "1003:1004"` (matching the host
# `mediauser` uid:gid) so the host backup — which runs as mediauser — can read the
# session files, incl. the persisted crypto key secret.key. A plain
# `docker run --user uid:gid` does NOT add the supplementary group 0 that the
# classic OpenShift idiom relies on, so the overridden process is in *only* that
# gid; runtime-writable paths must therefore be writable by group 0 (for a
# group-0 deploy) AND by "other" (for an arbitrary gid like 1004). We keep group-0
# ownership too so a `--user uid:0` deploy works as well.
#   /data            — DATA_DIR/BACKUP_DIR default. In prod the leaf dirs
#                      (pdfs/session/backups) are bind-mounted host-owned, so their
#                      perms come from the host; these in-image perms cover the
#                      unmounted parent + a no-volume `docker run`.
#   /app/.next/cache — `next start` (non-standalone) writes its fetch/image cache
#                      here at runtime; the rest of /app stays read-only.
#   /etc/passwd      — the entrypoint appends a passwd line for the running uid so
#                      getpwuid() resolves (psql/pg_dump and chromium otherwise
#                      abort with "local user with ID … does not exist").
RUN chmod +x ./docker-entrypoint.sh \
    && mkdir -p /data/pdfs /data/session /app/.next/cache \
    && chown -R ember:0 /data /app/.next/cache \
    && chmod -R g=u,o+rwX /data /app/.next/cache \
    && chmod g=u,o+w /etc/passwd
EXPOSE 3000
USER ember
ENTRYPOINT ["./docker-entrypoint.sh"]
