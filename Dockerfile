# Use the official Playwright image — it ships Chromium + every system lib
# (libnss3, libxkbcommon, libdrm, libgbm, libasound2, etc) pre-installed,
# which is the only way to run Playwright on Render's non-root build sandbox
# (--with-deps requires sudo, which Render blocks).
#
# Tag must match the playwright-core version in package.json (^1.59.1).
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# The base image runs as user "pwuser" by default. Switch to root briefly
# to install dependencies + build, then drop back to pwuser at runtime.
WORKDIR /app

# Install dependencies first (separate layer so Docker caches them
# independently of source changes — much faster rebuilds when only code
# changes).
COPY package.json package-lock.json ./
# --include=dev because vite/esbuild/tsx/typescript live in devDependencies
# but are needed for the build step below.
RUN npm ci --include=dev

# Copy the rest of the source and build the bundle.
COPY . .
RUN npm run build

# Tell Playwright to use the Chromium that's already in the base image
# (saves ~300 MB vs. re-downloading) and point its browser cache at the
# expected location.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Persistent disk for SQLite + uploads is mounted at /var/data on Render.
# render.yaml controls the actual mount; this just documents the contract.
ENV DATA_DIR=/var/data
ENV NODE_ENV=production

# Stay as root at runtime. Two reasons:
#   1) Render's persistent disk at /var/data is owned by root — a non-root
#      user can't write data.db or uploaded PDFs without a chown step that's
#      fragile across redeploys.
#   2) Chromium runs fine as root because we pass --no-sandbox in the
#      scraper (see server/keysearch-scraper.ts launch flags). The browser
#      stays sandboxed via the OS-level container boundary.

EXPOSE 5000
CMD ["node", "dist/index.cjs"]
