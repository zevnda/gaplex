# --- build: compile TypeScript ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- runtime ---
#
# IMPORTANT — this image's yt-dlp/Deno install covers Gaplex's OWN metadata
# resolution only (duration/title lookups). Gaplex no longer hands Liquidsoap
# a direct stream URL: it pushes a `process:` request that tells Liquidsoap to
# run yt-dlp itself, as a subprocess, at play time (see
# src/liquidsoap/telnet-client.ts for why). That means the Liquidsoap
# container/image — which lives in a separate deployment repo, not here —
# ALSO needs yt-dlp and Deno installed, or every track will fail to play with
# no clear error pointing back here. See AGENTS.md "Installation".
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# yt-dlp needs Python, and reliable extraction against YouTube's current
# anti-bot measures needs a JS runtime (Deno) for signature/nsig solving.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip curl ca-certificates unzip \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && apt-get purge -y curl unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# No runtime npm dependencies — dist/ is plain compiled JS run by Node itself.
COPY --from=build /app/dist ./dist
COPY config ./config

ENV NODE_ENV=production
EXPOSE 4242
ENTRYPOINT ["node", "dist/index.js"]