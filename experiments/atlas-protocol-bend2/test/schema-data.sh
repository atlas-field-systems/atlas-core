#!/bin/sh
set -eu

experiment_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$experiment_dir"
bend_bin=${BEND:-/tmp/atlas-bend2-toolchain/bin/bend}
export BEND_NO_TELEMETRY=1
test "$("$bend_bin" version)" = 'bend 2.0.39'
mkdir -p artifacts/schema-data
"$bend_bin" schemas.bend --check-only
"$bend_bin" schemas.bend -o artifacts/schema-data/schemas.mjs
if [ ! -d artifacts/schema-data/node_modules/ajv ]; then
  npm install --prefix artifacts/schema-data --no-save --ignore-scripts --package-lock=false --no-audit --no-fund ajv@8.20.0
fi
node test/schema-data.mjs artifacts/schema-data/schemas.mjs
