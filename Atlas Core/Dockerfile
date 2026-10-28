ARG ATLAS_NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${ATLAS_NODE_IMAGE} AS toolchain
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/prepare-build.mjs scripts/prepare-build.mjs
COPY artifacts/npm-11.19.0.tgz artifacts/npm-11.19.0.tgz
RUN node scripts/prepare-build.mjs --verify && npm install --global --offline --ignore-scripts --no-audit --no-fund /app/artifacts/npm-11.19.0.tgz && test "$(npm --version)" = "11.19.0"

FROM toolchain AS build
COPY artifacts/atlas-protocol-0.2.0.tgz artifacts/atlas-protocol-0.2.0.tgz
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/verify-inputs.mjs scripts/verify-inputs.mjs
COPY src src
ARG ATLAS_SOURCE_REVISION
ARG ATLAS_SOURCE_TREE
ARG ATLAS_SOURCE_DIRTY
ENV ATLAS_SOURCE_REVISION=${ATLAS_SOURCE_REVISION} ATLAS_SOURCE_TREE=${ATLAS_SOURCE_TREE} ATLAS_SOURCE_DIRTY=${ATLAS_SOURCE_DIRTY}
RUN npm run build

FROM toolchain AS runtime
ARG ATLAS_SOURCE_REVISION
LABEL org.opencontainers.image.revision=${ATLAS_SOURCE_REVISION} org.opencontainers.image.version=0.2.0
COPY artifacts/atlas-protocol-0.2.0.tgz artifacts/atlas-protocol-0.2.0.tgz
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist dist
COPY --from=build /app/artifacts/build-inputs.json artifacts/build-inputs.json
USER node
EXPOSE 7443
STOPSIGNAL SIGTERM
CMD ["node", "dist/runtime.js", "serve", "/atlas"]
