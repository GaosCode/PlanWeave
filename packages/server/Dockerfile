FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=planweave-server-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile --filter @planweave-ai/server... \
  && pnpm --filter @planweave-ai/agent-host-protocol build \
  && pnpm --filter @planweave-ai/collaboration-protocol build \
  && pnpm --filter @planweave-ai/runtime build \
  && pnpm --filter @planweave-ai/server build \
  && pnpm --filter @planweave-ai/server --prod deploy --legacy /out

FROM node:22-bookworm-slim

ARG PLANWEAVE_SERVER_BUILD_REVISION=development
LABEL org.opencontainers.image.revision="${PLANWEAVE_SERVER_BUILD_REVISION}"

WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
COPY packages/server/docker-entrypoint.sh /usr/local/bin/planweave-server-entrypoint
RUN mkdir -p /run/planweave/input/config /run/planweave/input/tls /run/planweave/runtime /var/lib/planweave/projects \
  && chmod 755 /usr/local/bin/planweave-server-entrypoint

ENV PLANWEAVE_SERVER_CONFIG=/run/planweave/runtime/server.json
ENV PLANWEAVE_SERVER_BUILD_REVISION=${PLANWEAVE_SERVER_BUILD_REVISION}
EXPOSE 443
ENTRYPOINT ["/usr/local/bin/planweave-server-entrypoint"]
