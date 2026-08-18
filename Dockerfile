# syntax=docker/dockerfile:1

# hacker-opds container image.
#
# Three stages so the runtime layer carries neither the source tree nor the
# build toolchain: `deps` resolves node_modules, `build` produces .output, and
# `runtime` copies only what the server actually opens at request time.
#
# Alpine. The one real risk in choosing musl is @resvg/resvg-js, which ships a
# prebuilt native addon per platform+libc and is the only thing here with no
# pure-JS fallback. Its musl builds for both x64 and arm64 are published and
# already pinned in bun.lock, and a container built this way was checked against
# the real database: covers and EPUBs came out byte-for-byte identical to the
# glibc image, which matters because those bytes are hashed into ETags.
#
# 220MB to 115MB, and 83MB of what is left is the bun binary itself.

ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------------------
# deps - resolve node_modules for the target platform.
# ---------------------------------------------------------------------------
# Separate from `build` so a source-only change reuses this layer. The lockfile
# pins a platform-specific @resvg optional dependency per architecture, so this
# stage genuinely differs between linux/amd64 and linux/arm64 and cannot be
# shared across them.
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# build - vite/nitro bundle.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

# tzdata is not decoration. nitro's scheduled tasks (hourly prewarm, nightly
# retention) are evaluated against process local time, so without a real zone
# database the nightly job would fire at 04:30 UTC while editions are cut in
# Europe/Amsterdam. Bun's bundled ICU covers EDITION_TZ formatting either way;
# this is for the cron side.
RUN apk add --no-cache tzdata

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
#
# Only /data is chowned. Recursing over /app as well would rewrite every file
# in .output, and because that is a separate layer from the COPY, docker would
# store the whole bundle twice - 12.6MB of pure duplication. Leaving the code
# root-owned and world-readable is also the stricter arrangement: the server
# runs as bun and cannot modify its own bundle.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

USER bun
EXPOSE 3000

# /healthz always answers 200 by design (a degraded report is more useful than
# an error page), so liveness alone would never fail. Parsing for status "ok"
# makes this catch the case a restart can actually fix: DATA_DIR unreadable.
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
    CMD bun -e 'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||3000)+"/healthz");const b=await r.json();process.exit(b.status==="ok"?0:1)'

CMD ["bun", "run", "/app/.output/server/index.mjs"]
