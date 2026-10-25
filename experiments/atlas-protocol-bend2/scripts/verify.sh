#!/bin/sh
set -eu

experiment_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$experiment_dir"
BEND=${BEND:-"$experiment_dir/.tools/bend-2.0.39/bin/bend"}
export BEND BEND_NO_TELEMETRY=1

sh scripts/build.sh
node test/numbers.test.mjs
node test/json.mjs
node test/schema-core.mjs
node test/admission.mjs
node test/runtime.mjs
sh test/schema-data.sh
sh test/exchange.sh
node --test test/geometry.test.mjs test/rules.test.mjs
node test/verify.mjs
node test/native.mjs
node scripts/export-reference.mjs
"../../Atlas Protocol/node_modules/.bin/redocly" bundle artifacts/reference-source.json \
  --output artifacts/openapi.json --ext json
"../../Atlas Protocol/node_modules/.bin/redocly" lint artifacts/openapi.json --extends minimal
