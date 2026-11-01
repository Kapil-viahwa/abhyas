# Worker image. Build context is the repository root (pnpm workspace).
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @abhyas/shared run build && pnpm --filter @abhyas/worker run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo /repo

CMD ["node", "apps/worker/dist/main.js"]
