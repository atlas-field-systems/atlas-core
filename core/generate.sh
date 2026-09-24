#!/bin/sh
# Regenerates every Core binding from Protocol and the module queries.
set -eu
cd "$(dirname "$0")"
go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate
go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.8.0 -config oapi-codegen.yaml ../protocol/openapi.yaml
