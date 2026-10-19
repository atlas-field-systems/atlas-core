#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export GOTOOLCHAIN=local
[[ "$(go version)" == 'go version go1.27.2 '* ]]
[[ "$(node --version)" == 'v24.21.0' ]]
[[ "$(npm --version)" == '11.19.0' ]]
npm ci --ignore-scripts --no-audit --no-fund
go mod download
go mod tidy -diff
bash scripts/generate.sh --check
npm run build
./node_modules/.bin/tsc -p tsconfig.test.json
node scripts/type-negatives.mjs
go vet ./...
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
if ! go test -race -count=1 -json ./... > "$scratch/go-tests.log"; then
 cat "$scratch/go-tests.log"
 exit 1
fi
node scripts/check-results.mjs go "$scratch/go-tests.log"
printf 'Go consumer fixtures and HTTP/WS bindings passed.\n'
if ! node --test --test-reporter=tap dist-test/test/protocol.test.js > "$scratch/ts-tests.log" 2>&1; then
  cat "$scratch/ts-tests.log"
  exit 1
fi
node scripts/check-results.mjs ts "$scratch/ts-tests.log"
printf 'TypeScript consumer fixtures and HTTP/WS bindings passed.\n'
for composition in oneOf anyOf allOf; do
  node scripts/semantic-composition.mjs "$composition"
done
for composition in oneOf anyOf allOf not arrays properties rollback duplicate wide; do
  node scripts/numeric-composition.mjs "$composition"
done
node scripts/canaries.mjs
bash scripts/consume.sh
printf 'Atlas Protocol verification passed.\n'
