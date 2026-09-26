#!/bin/sh
# Fails if regenerating from Protocol and module queries changes any output.
set -eu
cd "$(dirname "$0")/.."
(cd core && ./generate.sh)
(cd sdk && pnpm run generate)
git diff --exit-code -- core/internal/api core/internal/*/internal/db core/internal/entities/command-catalog.generated.json sdk/src/generated
test -z "$(git status --porcelain -- core/internal/api core/internal/*/internal/db core/internal/entities/command-catalog.generated.json sdk/src/generated)"
