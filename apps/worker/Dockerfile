# Worker image. Build context is the repository root (pnpm workspace).
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# The worker talks to Postgres through Prisma (the OTP purge job), so this stage needs
# OpenSSL for the same reason the API image does: Prisma picks the query-engine variant
# by inspecting the system OpenSSL, and without it the client is generated against
# openssl-1.1.x, which bookworm cannot load at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile

# Prisma's CLI needs a datasource URL to generate; it never connects during generate.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN pnpm --filter @abhyas/shared run build && pnpm --filter @abhyas/worker run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

# libssl3 must be present for the Prisma query engine to load.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo /repo

CMD ["node", "apps/worker/dist/main.js"]
