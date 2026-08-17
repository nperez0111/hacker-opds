# syntax=docker/dockerfile:1

# hacker-opds container image.
#
# Three stages so the runtime layer carries neither the source tree nor the
# build toolchain: `deps` resolves node_modules, `build` produces .output, and
# `runtime` copies only what the server actually opens at request time.
#
# Debian slim rather than Alpine. @resvg/resvg-js ships a prebuilt native addon
# per platform+libc, and the glibc builds are the ones that see real use; musl
# would work but buys a smaller image in exchange for a less-travelled binary
# doing the one thing in this codebase that has no pure-JS fallback.

ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------------------
# deps - resolve node_modules for the target platform.
# ---------------------------------------------------------------------------
# Separate from `build` so a source-only change reuses this layer. The lockfile
# pins a platform-specific @resvg optional dependency per architecture, so this
# stage genuinely differs between linux/amd64 and linux/arm64 and cannot be
# shared across them.
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# build - vite/nitro bundle.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# tzdata is not decoration. nitro's scheduled tasks (hourly prewarm, nightly
# retention) are evaluated against process local time, so without a real zone
# database the nightly job would fire at 04:30 UTC while editions are cut in
# Europe/Amsterdam. Bun's bundled ICU covers EDITION_TZ formatting either way;
# this is for the cron side.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# This is the whole application. A few packages are deliberately excluded from
# the bundle (see vite.config.ts and the traceDeps list in nitro.config.ts) but
# Nitro traces them into .output/server/node_modules, so nothing else needs
# copying alongside - including the platform-specific @resvg addon, which is
# resolved for this image's architecture during the build stage above.
COPY --from=build /app/.output ./.output

# Baked at build time by the workflow. src/health.ts prefers this over shelling
# out to git, which is the point - there is no git in this image.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Amsterdam \
    LOG_LEVEL=info \
    LOG_PRETTY=false

# PUBLIC_BASE_URL is intentionally unset. Leaving it empty makes the OPDS and
# RSS feeds derive their absolute URLs from the incoming request, which is what
# you want behind a reverse proxy whose hostname this image cannot know. Set it
# explicitly only if the proxy rewrites Host.

# The database, EPUB blobs, cached images and unpacked fonts all live here. A
# container without this mounted keeps a 90-day archive on its writable layer
# and loses it on the next redeploy - see docker-compose.yml for a named volume.
RUN mkdir -p /data && chown -R bun:bun /data /app
VOLUME ["/data"]

USER bun
EXPOSE 3000

# /healthz always answers 200 by design (a degraded report is more useful than
# an error page), so liveness alone would never fail. Parsing for status "ok"
# makes this catch the case a restart can actually fix: DATA_DIR unreadable.
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
    CMD bun -e 'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/healthz");const b=await r.json();process.exit(b.status==="ok"?0:1)'

CMD ["bun", "run", "/app/.output/server/index.mjs"]
