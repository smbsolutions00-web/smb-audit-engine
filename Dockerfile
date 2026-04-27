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

# Install Node 20 (matches the builder stage so native modules load).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && node --version

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
CMD ["node", "dist/index.cjs"]
