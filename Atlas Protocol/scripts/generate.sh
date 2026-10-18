#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tools
if [[ ! -x .tools/oapi-codegen ]]; then
  GOBIN="$PWD/.tools" go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0
fi
[[ "$(.tools/oapi-codegen -version)" == *v2.8.0* ]]
.tools/oapi-codegen --config oapi-codegen.yaml openapi.json
./node_modules/.bin/openapi-typescript openapi.json --array-length -o ts/wire.gen.ts
