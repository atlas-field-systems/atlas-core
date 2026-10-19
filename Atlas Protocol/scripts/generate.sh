#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tools
if [[ ! -x .tools/oapi-codegen ]]; then
  GOBIN="$PWD/.tools" go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
fi
[[ "$(.tools/oapi-codegen -version)" == *v2.8.0* ]]
node scripts/contract.mjs
output="$PWD"
compare=""
if [[ "${1:-}" == --check ]]; then
  compare="${2:-$PWD}"
  output="$(mktemp -d)"
  trap 'rm -rf "$output"' EXIT
fi
mkdir -p "$output/ts"
.tools/oapi-codegen --config oapi-codegen.yaml -o "$output/wire.gen.go" openapi.json
./node_modules/.bin/openapi-typescript openapi.json --array-length -o "$output/ts/wire.gen.ts"
node scripts/registry.mjs "$output"
gofmt -w "$output/types.gen.go" "$output/consumers.gen_test.go"
if [[ -n "$compare" ]]; then
  for file in wire.gen.go types.gen.go consumers.gen_test.go ts/wire.gen.ts ts/metadata.gen.ts; do
    diff -u "$compare/$file" "$output/$file"
  done
  printf 'Deterministic generation passed.\n'
fi
