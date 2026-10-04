# Build context: repository root
# docker build -f packages/tracing/Dockerfile -t ghcr.io/pascal-lohscheidt/m4trix-tracing-sidecar .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Workspace manifests pnpm needs to resolve the tracing package's links.
COPY packages/core/package.json packages/core/
COPY packages/tracing/package.json packages/tracing/
# --ignore-scripts: the package's `prepare` build would run before the sources are copied.
RUN pnpm install --filter @m4trix/tracing --frozen-lockfile --ignore-scripts
COPY packages/tracing packages/tracing
RUN pnpm --filter @m4trix/tracing run build:sidecar

# The CLI is a single self-contained file (AWS SDK bundled), so the runtime image needs no install.
FROM node:24-slim
WORKDIR /app
COPY --from=build /app/packages/tracing/dist/trace-shipper-cli.mjs ./
RUN mkdir /traces && chown node:node /traces
USER node
ENV NODE_ENV=production \
    TRACE_ROOT=/traces
VOLUME ["/traces"]
ENTRYPOINT ["node", "trace-shipper-cli.mjs"]
CMD ["--root", "/traces", "--interval", "2s"]
