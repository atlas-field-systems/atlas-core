# Build from the repository root: docker build -f plugins/elevation/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app/sdk
COPY sdk/package.json sdk/pnpm-lock.yaml sdk/tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY sdk/src ./src
RUN pnpm exec tsc
WORKDIR /app/plugins/elevation
COPY plugins/elevation/package.json plugins/elevation/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY plugins/elevation ./
ENTRYPOINT ["node", "server.mjs"]
HEALTHCHECK --interval=2s --timeout=3s --start-period=1s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.ATLAS_PLUGIN_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
