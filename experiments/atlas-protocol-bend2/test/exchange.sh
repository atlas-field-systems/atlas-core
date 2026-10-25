#!/bin/sh
set -eu
experiment_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$experiment_dir"
bend_bin=${BEND:-/tmp/atlas-bend2-toolchain/bin/bend}
export BEND_NO_TELEMETRY=1
test "$("$bend_bin" version)" = 'bend 2.0.39'
mkdir -p artifacts/exchange
"$bend_bin" test/exchange-driver.bend --check-only
"$bend_bin" test/exchange-driver.bend -o artifacts/exchange/driver.mjs
"$bend_bin" schemas.bend -o artifacts/exchange/schemas.mjs
if [ ! -d artifacts/exchange/node_modules/ajv ]; then
  npm install --prefix artifacts/exchange --no-save --ignore-scripts --package-lock=false --no-audit --no-fund ajv@8.20.0
fi
node test/exchange.mjs artifacts/exchange/driver.mjs
"$bend_bin" test/exchange-native.bend -o artifacts/exchange/native
artifacts/exchange/native
