# Pinned Protocol toolchain proof

Research date: 3 October 2026. Executed evidence for [issue #69](https://github.com/atlas-field-systems/atlas-core/issues/69), under [ADR-0011](../../adr/0011-generate-shared-contracts-with-minimal-customization.md) and [ADR-0016](../../adr/0016-use-go-sqlite-and-openapi-tooling.md). The [isolated experiment](protocol-proof/README.md) proves a representative binding pipeline. It does not implement Core, the Atlas SDK or the remaining operational tests.

The selected tools preserve the tested wire distinctions without generator templates, edited output or TypeScript type assertions. Request and response validation still need explicit integration. Two transfer adapters are necessary because the default Go validator buffers binary bodies and the TypeScript generator represents binary request content as `string`.

## Exact pins and ownership

Official Go download metadata, GitHub release metadata, Go module versions and npm registry metadata were checked on the research date. These are the tested pins, rather than a promise that future versions behave identically.

| Dependency | Tested version | Lock owner |
| --- | --- | --- |
| Go | `1.27.1`, Linux amd64 | `toolchain.json`, archive SHA-256 |
| Node / npm | `24.21.0` / `11.19.0` | `toolchain.json`, verifier prerequisites |
| OpenAPI edition | `3.0.3` | Authored `protocol.json` |
| `oapi-codegen` | `2.8.0` | `tools/go.mod` and `tools/go.sum` |
| `oapi-codegen/runtime` | `1.7.0` | Runtime `go.mod` and `go.sum` |
| `oapi-codegen/nullable` | `1.2.0` | Runtime Go locks; supported `nullable-type` output option |
| `kin-openapi` runtime | `0.149.0` | Runtime Go locks |
| `nethttp-middleware` | `1.2.0` | Runtime Go locks |
| `sqlc` | `1.31.1` | `toolchain.json`, official archive digest |
| `modernc.org/sqlite` | `1.60.1` | Runtime Go locks |
| SQLite engine | `3.53.4` | Driver's embedded engine, confirmed with `sqlite_version()` |
| `openapi-typescript` | `7.13.0` | `package.json` and `package-lock.json` |
| `openapi-fetch` | `0.17.0` | npm locks |
| Ajv / `ajv-formats` | `8.20.0` / `3.0.1` | npm locks |
| TypeScript / `tsx` | `5.9.3` / `4.23.15` | npm locks |
| Node types | `24.10.1` | npm locks |

Protocol owns schema/generator pins and the supported schema profile. Core owns the SQLite driver, private SQL and request-validation integration. SDK owns its transport/runtime-validation dependencies. A dependency upgrade reruns the same independently authored fixtures and clean-regeneration check before adoption. The generator's locked parser is `kin-openapi 0.142.0`; Core's runtime validator has its own explicitly locked version.

The Go archive SHA-256 is `63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445`. The sqlc archive SHA-256 is `497ae4fcdfa64c5b0c311ffe4c2bd991e43991e82e5367792ed78bc2dca27354`. Both were checked before extraction. The official [Go downloads](https://go.dev/dl/?mode=json), [sqlc release](https://github.com/sqlc-dev/sqlc/releases/tag/v1.31.1), [driver documentation](https://pkg.go.dev/modernc.org/sqlite@v1.60.1) and [SQLite sqlc tutorial](https://docs.sqlc.dev/en/latest/tutorials/getting-started-sqlite.html) establish the distribution and driver paths.

## Supported schema profile

The proof uses the [OpenAPI 3.0.3 schema edition](https://spec.openapis.org/oas/v3.0.3.html). Supported here means executed by this exact pipeline, not every feature advertised by each generator.

- Named component schemas and local `$ref` reuse.
- Explicit object properties and required fields, closed request shapes, nullable scalar/array/object fields, typed dictionaries and nested partial updates.
- Arrays with typed items, single-value discriminator enums, ordinary enums, numeric bounds, UUID formats and decimal-string patterns.
- Tagged `oneOf` Entity and Command variants; simple `allOf` composition of shared response context plus typed data. Each variant's tag is required and constrained to one value.
- HTTP request/response JSON, declared headers and error statuses; `application/octet-stream` with `type: string`, `format: binary`.
- Protocol metadata extensions for the supported fixture versions and Command Catalog entries.

Specify `format: double` for latitude/longitude. An unformatted OpenAPI number generated a Go `float32` during preparation; regenerating from explicit `double` produces `float64` without a type override. Decimal strings preserve ordering values above JavaScript's exact integer range.

Use named nullable object schemas directly. This proof avoids nullable wrappers around non-nullable `$ref`/`allOf` compositions. It also does not qualify other `allOf` combinations, `anyOf`, nullable enum combinations, recursive schemas, external refs, OpenAPI 3.1/3.2 features or endpoint-specific templates. A required new feature needs a fixture and another executed check. The chosen profile deliberately uses less than [oapi-codegen's available feature set](https://github.com/oapi-codegen/oapi-codegen/tree/v2.8.0).

## Validation boundaries and permitted adapters

Core validates the selected Protocol version and Dataset before fixture dispatch, then validates JSON structure through the pinned OpenAPI middleware before the generated strict handler can mutate storage. Request schemas exclude immutable IDs and Entity type; unknown patch properties fail. Structural validation is followed by owner-specific authentication, authorization, transitions, concurrency and retry checks in the future application. This experiment does not implement those policies. The generated strict interface does not itself provide request validation, as the [generator documentation](https://github.com/oapi-codegen/oapi-codegen#strict-server) states.

The middleware, generated parameter binder and strict JSON decoder need the same typed request-error adapter. The retained-UUID fixture initially reached the generated UUID decoder and received its default plain-text error; wiring the supported handler options makes that rejection use the shared JSON error envelope. Schema middleware alone does not guarantee the complete request-error contract.

HTTP successes use the shared `{ dataset_id, data, commit_cursor? }` envelope; errors use `{ error: { code, message, request_id, details? }, dataset_id? }`. The response context is authored once and reused through supported `allOf` composition. A mutation context requires its inherited `commit_cursor`; read responses allow omission. Common required Dataset/version headers are authored once and referenced by success and error responses. Mutation fixture responses include a representative cursor; synchronization and real replay cursors remain excluded. SDK treats successful and error JSON as untrusted. Its `openapi-fetch` response middleware checks Dataset in both headers and the JSON envelope, selected Protocol version, declared status and media type, parses a clone, and validates the operation's response schema before the generated client returns data. Malformed JSON, invalid successful shapes/enums and incorrect response headers or media types fail. Parsing a clone preserves the client's normal response handling. [openapi-fetch middleware](https://openapi-ts.dev/openapi-fetch/middleware-auth) supplies the supported hook; [Ajv's OpenAPI nullable support](https://ajv.js.org/json-schema.html#nullable) supplies the structural validator.

The Ajv adapter registers Protocol's `components`/`paths` containers and metadata keywords, then compiles references directly into the same authored document. It does not maintain another set of field definitions. The adapter ignores discriminator metadata because `oneOf` plus each required single-value enum already enforce variant selection. Ajv's optimized discriminator path has restrictions, so no generator extension is needed for it. It keeps strict schema checks, adds pinned formats and performs no coercion, default insertion or deletion of unknown request fields.

Binary transfer uses the generated Go `io.Reader` input/output bindings. The ordinary kin-openapi [FileBodyDecoder](https://pkg.go.dev/github.com/getkin/kin-openapi@v0.149.0/openapi3filter#FileBodyDecoder) reads the body in full. The proof therefore excludes body validation only for the binary route, retains header/path validation, checks the incoming media type against that operation's Protocol content map, and bounds the body before streaming it to a private file. The production Objects owner must add its own quota, digest/length, staging, cancellation and safe-publication rules. Buffering a 1 GB upload in the general JSON validator is not a permitted default.

The TypeScript binary body type is `string`, so the experiment uses the supported `bodySerializer` to turn a byte string into exact octets. This adapter preserves the fixture's NUL and non-UTF-8 bytes without assertions or a patched binding. A public Object helper can accept byte/stream inputs and keep this transport choice private. The seven-byte experiment does not qualify large-file capacity or streaming memory bounds for the complete SDK. [openapi-fetch's API](https://openapi-ts.dev/openapi-fetch/api) documents body serialization and alternate response parsing.

Business behavior, errors, byte transfer and runtime validation are ordinary handwritten adapters. Generated types and bindings remain disposable. No duplicate operation-wrapper API, custom template or generated-output patch was introduced.

## Shared facts outside HTTP

`ChangeEvent` references the canonical `Entity` union. `PluginDispatch` references the canonical `Position`. The report route references one representative `ReportContext` with the structural fields from the [Asset report specification](../../topics/asset-reporting.md#shared-report-context), including nullable `evidence_origin`, nullable `retained_evidence_id` and optional `observation_times`. Current reports, historical reports with original ordering and historical reports with a retained UUID round-trip through the actual wire; decimal tokens beyond JavaScript's exact integer range remain strings. Separate structural fixtures check known/null observation timing and malformed timing records.

This context qualifies binding fidelity, not complete report validation. The sample signature is opaque fixture data. Ed25519 verification, unsigned 64-bit range enforcement, process transfer, principal binding, current/historical cross-field rules, issued-generation checks, quantity/payload correspondence, evidence deduplication and freshness decisions are excluded. Those remain the application owners' checks. `skip-prune: true` emits otherwise unreferenced message schemas into the same Go and TypeScript bindings. Go validates non-HTTP fixtures through the embedded Protocol schemas; TypeScript validates them through references into the authored Protocol document. No second message schema is maintained in a feed or Plugin adapter.

The existing WebSocket transport remains a separate binding. This experiment validates representative message payloads; it does not implement a WebSocket feed, private Plugin dispatch, replay or synchronization. The selected transport does not change schema ownership.

Command metadata is authored once as `x-atlas-command` on each Command schema. The local Catalog selects these entries and pairs them with their schema reference. Its consumers validate examples through those references, rather than authoring another command-input schema. Go or TypeScript consumers may read the same versioned Protocol artifact or generate a mechanical metadata projection from it. This proof executes the TypeScript projection; it does not implement Catalog discovery or all Atlas Commands.

## Executed evidence

Run `python3 verify.py --bootstrap` in [the fixture directory](protocol-proof/README.md). On the final source state, the verifier passed:

| Check | Evidence |
| --- | --- |
| Locked installation | `npm ci --ignore-scripts`; Go module verification |
| Clean regeneration | Delete all outputs, generate twice, compare six files byte for byte |
| Type/build checks | `tsc --noEmit` with strict, exact optional properties and checked indexed access; Go formatting, `go test ./...`, `go vet ./...`, `go build` |
| Runtime | 49 named checks, including generated TypeScript transport calls through the actual generated Go HTTP handler and canonical-schema checks; real temporary SQLite in WAL mode and real private files |
| Non-HTTP | Go canonical-schema checks accept two valid message fixtures and reject two invalid ones; generated message serialization preserves the large decimal token |

The workflow corpus checks omitted fields, explicit null, empty/replaced arrays, nested partial/empty updates and clearing a whole component. Nested update examples use an explicitly illustrative `fixture_component` with independently editable `left`/`right` members. It is not an Atlas component proposal. Actual Position remains a complete coordinate pair; the experiment does not authorize partial latitude-only telemetry. For every valid patch, direct Protocol and generated-client paths start from equivalent isolated fixture state, match the hand-authored expected value and read the persisted value back. Invalid immutable-input, enum, variant, array, nested-shape, incomplete evidence-origin and retained-UUID cases reject before a write and preserve the stored Asset. Malformed request JSON is rejected. Valid Move To/Pause payloads and the representative shared report context round-trip. Binary upload metadata and download bytes agree with independent fixtures; an undeclared upload media type fails.

Compatibility uses artificial `0.1.0`/`0.2.0` fixture versions, not released Atlas editions. The independently authored older-client fixture has no battery field and permits unknown response fields. Its separately generated client successfully reads the newer optional field, while the current schema also accepts a response omitting that field. Unsupported versions and a different Dataset reject mutation without effects. These cases prove the compatibility mechanism for this optional addition. They do not establish any future release's supported range or tolerate new enum/Command meanings automatically.

Malformed successful responses are injected over real HTTP for missing/wrong fields, invalid JSON, an invalid enum, wrong media type, wrong Dataset in either headers or the JSON envelope, and wrong Protocol. Each fails at the SDK response boundary. All four mutation fixture routes reject a response without its required commit cursor; JSON errors missing either required context header also fail. A cleared illustrative component rejects incomplete recreation with a typed 400 and no partial edits; complete recreation, including a zero value, succeeds through both request paths and persists in SQLite.

The final verifier also passes with Python optimization enabled. Separate negative checks reject an incorrect archive checksum before extraction and a wrong tool version in that mode. Suppressing the real server's readiness output makes the client time out, terminate the server and remove its temporary SQLite/content directory. Normal shutdown also removes its task-owned data.

## Limits and conclusion

Issue #69's representative toolchain proof is executable and passes. It establishes a small supported schema profile, exact locks, independent fixtures and the required validation/transfer seams. It makes no throughput, durability-after-power-loss, field-readiness, Task-transition, authentication, full public API parity or maintenance-productivity claim. Those belong to the [testing strategy](../../testing-strategy.md) and the later implemented workflow slices.
