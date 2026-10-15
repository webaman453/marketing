# syntax=docker/dockerfile:1
# One image for the whole product. docker-compose.yml runs it as the web app,
# the API, the background worker and the one-off migration job.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# Prisma reads DATABASE_URL even to generate the client; the real one is given at runtime.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
# The web app proxies /api/* to this address; it's fixed at build time.
ARG API_URL=http://api:4100
ENV API_URL=$API_URL
RUN pnpm --filter @ashniva/db run generate && pnpm turbo run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# Uploaded creatives and logos (mount a volume here).
RUN mkdir -p /data/uploads
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3100 4100
# docker-compose.yml sets the command for each service.
CMD ["node", "apps/api/dist/index.js"]
