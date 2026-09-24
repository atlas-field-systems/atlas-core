#!/bin/sh
# Runs the end-to-end scenarios and compares their transcripts with the
# committed artifacts. Pass --docker to include the Docker Compose scenarios.
# Set ATLAS_E2E_UPDATE=1 to rewrite the artifacts instead.
set -eu
cd "$(dirname "$0")/.."
(cd sdk && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
(cd plugins/elevation && pnpm install --frozen-lockfile >/dev/null)
# Build Core once for every test file instead of once per file.
ATLAS_E2E_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$ATLAS_E2E_BIN_DIR"' EXIT
export ATLAS_E2E_BIN_DIR
(cd core && go build -o "$ATLAS_E2E_BIN_DIR/atlas-core" ./cmd/atlas-core && go build -o "$ATLAS_E2E_BIN_DIR/atlasctl" ./cmd/atlasctl)
if [ "${1:-}" = "--docker" ]; then
  node --test tests/e2e/*.test.mjs tests/e2e/docker/*.test.mjs
else
  node --test tests/e2e/*.test.mjs
fi
