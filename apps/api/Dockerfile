# API image. Build context is the repository root (pnpm workspace).
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile

# Prisma's CLI needs a datasource URL to generate; it never connects during generate.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN pnpm --filter @abhyas/shared run build && pnpm --filter @abhyas/api run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo /repo

EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
