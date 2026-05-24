# Build context: repository root
# docker build -f packages/tracing/Dockerfile -t ghcr.io/pascal-lohscheidt/m4trix-tracing-sidecar .

FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/tracing/package.json packages/tracing/
RUN pnpm install --filter @m4trix/tracing --frozen-lockfile
COPY packages/tracing packages/tracing
RUN pnpm --filter @m4trix/tracing build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/packages/tracing/dist ./dist
COPY --from=build /app/packages/tracing/package.json ./package.json
RUN npm install --omit=dev --no-package-lock \
  @aws-sdk/client-dynamodb@^3.1053.0 \
  @aws-sdk/client-s3@^3.1053.0 \
  @aws-sdk/lib-dynamodb@^3.1053.0
ENV TRACE_ROOT=/traces
VOLUME ["/traces"]
ENTRYPOINT ["node", "dist/trace-shipper-cli.js"]
CMD ["--root", "/traces", "--interval", "2s"]
