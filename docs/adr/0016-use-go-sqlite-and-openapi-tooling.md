---
status: accepted
---

# Use Go, SQLite and OpenAPI tooling

Use this stack for the first Atlas implementation. It combines a Go server, embedded SQL storage and supported generators so the one-server installation needs fewer services and Atlas maintains less API and query boilerplate. The user accepted this choice on 21 September 2026, following the [technology reassessment](../research/atlas-reassessment/README.md).

| Responsibility | Selected technology |
| --- | --- |
| Core | Go with standard `net/http` facilities |
| Operational database | SQLite in WAL mode, accessed only by Core |
| Object content | Private local files, with metadata in SQLite |
| Public API contract | Directly authored OpenAPI |
| Go API bindings | `oapi-codegen` types and strict server interfaces for standard HTTP handlers |
| Private database access | `sqlc`, generating typed Go query code from authored SQL |
| Initial SDK | TypeScript, using `openapi-typescript` contract types and `openapi-fetch`, with Atlas helpers separate from generated output |

Protocol owns the public HTTP contract. Private SQL schemas and queries own storage representation. These are separate sources of truth: generate API bindings from OpenAPI and database access from SQL. Do not derive database tables from public resource models. Handwritten implementations own transitions, transactions, Object readiness, Plugin lifecycle and SDK conveniences under [ADR-0011](0011-generate-shared-contracts-with-minimal-customization.md).

`oapi-codegen` supports generated server interfaces; request validation and authentication still require explicit integration. `openapi-typescript` supplies types, not proof of runtime response validity. Use the independent wire and behavior checks in the [system design](../architecture/system-design.md#generation-and-testing). See the primary documentation for [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen), its [HTTP validation middleware](https://github.com/oapi-codegen/nethttp-middleware), [sqlc with SQLite](https://docs.sqlc.dev/en/latest/tutorials/getting-started-sqlite.html), and [openapi-fetch](https://openapi-ts.dev/openapi-fetch/).

## Tradeoffs and implementation checks

SQLite removes a separate database server but permits only one writer at a time. Keep transactions short and bulk Object transfers outside them. Commit resource mutations and change records together. The expected resource counts are not a capacity benchmark; validate write contention and latency with the first workflow. [SQLite's deployment guidance](https://sqlite.org/whentouse.html) and [WAL documentation](https://sqlite.org/wal.html) describe this tradeoff.

Local files remove the object-service dependency, but file publication and SQL commit remain separate operations. The Objects implementation must handle staging, interrupted writes and missing content without exposing an unusable Object. Storage follows [ADR-0015](0015-separate-start-stop-restart-and-reset.md), including retained same-release restarts and explicit release-update Reset.

PostgreSQL remains a reconsideration option if measured workload requires it. A TypeScript/Fastify server was considered for language consolidation; Go was chosen with its generated server interfaces and the existing Core experience. TypeSpec is deferred: start by authoring OpenAPI directly. These alternatives are not additional supported deployment profiles.

Pin tool versions, the supported OpenAPI version and the SQLite driver during the first implementation slice. Prove a nullable update, Task transition, binary upload and change event without patched generator output. Generation does not implement synchronization or resumable-transfer behavior by itself. SDK languages beyond the initial TypeScript SDK and the transfer/streaming mechanisms remain open. This decision selects a stack; no implementation or benchmark result is claimed.
