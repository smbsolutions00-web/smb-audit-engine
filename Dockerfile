# ---------- Stage 1: Build ----------
# Build the app on Node 20 (matches our local dev environment and the
# package-lock.json we've been testing against). The Playwright base
# image ships Node 24, which makes npm ci fail on some of our deps,
# so we keep build + runtime on different Node majors via multi-stage.
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install dependencies first as a separate layer so Docker can cache
# them when only source files change.
COPY package.json package-lock.json ./
# --include=dev pulls in vite/esbuild/tsx/typescript needed for the build.
RUN npm ci --include=dev

# Copy the rest of the source and build the bundle.
COPY . .
RUN npm run build

# Trim the install down to production-only deps so we can copy a slim
# node_modules into the runtime stage. Skip optional deps to save space
# (Playwright pulls a lot of optional binaries we don't need at runtime).
RUN npm prune --omit=dev


# ---------- Stage 2: Runtime ----------
# Official Playwright image ships Chromium + every system lib it needs
# (libnss3, libxkbcommon, libdrm, libgbm, etc) pre-installed. This is
# the only way to run Playwright on Render — its standard build sandbox
# blocks `sudo apt-get`, which `npx playwright install --with-deps`
# requires.
#
# Tag must match the playwright-core version in package.json (^1.59.1).
# The image ships Node 24 by default, but better-sqlite3 (and any other
# native module) was compiled against Node 20 in the builder stage, so
# we install Node 20 over the top to match. Both Node versions can
# coexist; we just put 20 first on the PATH.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runtime

# Install Node 20 from the official NodeSource binary tarball into
# /opt/node20 and put it FIRST on PATH so it shadows the Node 24 that
# ships with the Playwright base image. Verifying the version at the
# end of the RUN forces a build failure if anything goes wrong.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl xz-utils \
  && curl -fsSL https://nodejs.org/dist/v20.20.1/node-v20.20.1-linux-x64.tar.xz -o /tmp/node20.tar.xz \
  && mkdir -p /opt/node20 \
  && tar -xJf /tmp/node20.tar.xz -C /opt/node20 --strip-components=1 \
  && rm /tmp/node20.tar.xz \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/node20/bin:${PATH}"
RUN node --version | grep -q "^v20" || (echo "FATAL: node is not v20 ($(node --version))" && exit 1)

WORKDIR /app

# Copy built artifacts + production node_modules from the build stage.
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist /app/dist

# Tell Playwright to use the Chromium that ships in the base image
# (saves ~300 MB vs. re-downloading it).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Persistent disk for SQLite (data.db) + uploaded Manus PDFs is mounted
# at /var/data on Render. render.yaml controls the actual mount; this
# just documents the contract.
ENV DATA_DIR=/var/data
ENV NODE_ENV=production

# Stay as root at runtime:
#   1) Render's persistent disk at /var/data is owned by root — switching
#      to a non-root user requires a chown step that's fragile across
#      redeploys.
#   2) Chromium runs fine as root because the scraper passes --no-sandbox
#      (see CHROMIUM_LAUNCH_ARGS in server/keysearch-scraper.ts). The
#      browser process is still sandboxed by the container boundary.

EXPOSE 5000
# Absolute path to Node 20 so the runtime can never accidentally pick
# up the Node 24 binary that ships in the Playwright base image.
CMD ["/opt/node20/bin/node", "dist/index.cjs"]
