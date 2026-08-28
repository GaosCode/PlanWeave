FROM node:22-bookworm-slim

ARG PLANWEAVE_SERVER_BUILD_REVISION=development
LABEL org.opencontainers.image.revision="${PLANWEAVE_SERVER_BUILD_REVISION}"

WORKDIR /app
COPY app/ ./
COPY docker-entrypoint.sh /usr/local/bin/planweave-server-entrypoint
RUN mkdir -p /run/planweave/input/config /run/planweave/input/tls /run/planweave/runtime /var/lib/planweave/projects \
  && chmod 755 /usr/local/bin/planweave-server-entrypoint

ENV PLANWEAVE_SERVER_CONFIG=/run/planweave/runtime/server.json
ENV PLANWEAVE_SERVER_BUILD_REVISION=${PLANWEAVE_SERVER_BUILD_REVISION}
EXPOSE 443
ENTRYPOINT ["/usr/local/bin/planweave-server-entrypoint"]
