# Request and patch qualification, #96

[Ticket #96](https://github.com/atlas-field-systems/atlas-core/issues/96) implements the request/patch part of [Slice 0 #94](https://github.com/atlas-field-systems/atlas-core/issues/94). The seam is generated TypeScript transport and independently authored direct HTTP requests to generated Go handlers, with real temporary SQLite in WAL mode and supported HTTP reads after writes or rejections.

`requests.contract.json` contains only illustrative fixture routes and components. It references Protocol-owned Identifier, decimal counters, Position, response context and Error definitions. The contract assembler reuses those definitions before disposable bindings are generated. Fixture Entity/Command variants are independent of the local Catalog and do not claim production resource or Command coverage. The nested `fixture_component` has no movement semantics. Position always supplies both named coordinates.

The fixture seeds a private keyed SQLite value from `patch.fixtures.json`. Patch merging preserves omitted fields, replaces scalars and arrays, and merges only the illustrative component. Before saving, the complete candidate is validated against the assembled `FixturePatchResource` schema. Cleared components therefore cannot acquire fabricated zero values from Go decoding. A rejected candidate leaves every field unchanged.

Core's reusable `httpcontract` adapter enables the supported UUID format using the existing Protocol binding decoder and the canonical/URN spellings accepted by pinned Ajv. Registration runs when the package is imported, including by non-HTTP schema consumers. The JSON boundary also rejects a second document or trailing malformed data, which the pinned structural and generated decoders otherwise accept. This extra framing check reads JSON only; it adds no binary-body buffering. The fixture bounds JSON bodies to 4096 bytes. Validation never inserts defaults, coerces values or deletes unknown fields.

Schema middleware, generated parameter-binding hooks and generated strict-decoder hooks all use the shared Protocol error writer. Error messages name a safe method, validation stage and registered route template when available. They omit submitted body, query, header and path values. Each rejection allocates a diagnostic UUID, which is not a submission identity, replay token or commit proof.

The fixture's `request_hooks` startup mode bypasses structural middleware solely to reach the actual generated binding and decoding failure hooks. Its two negative HTTP cases use real SQLite and read-back. Normal fixture mode keeps structural validation active. This mode qualifies error integration, not schema acceptance without middleware.

## Requirement evidence

| Requirement | Implementation | Executed workflow evidence |
| --- | --- | --- |
| Omission, null and empty values | Generated nullable bindings and fixture candidate merge | `patch.test.ts`: `{}`, alias empty/null, labels empty/null, exact array order and duplicates; both transport paths and persisted GET after every update |
| Nested partial updates and atomic recreation | Illustrative partial schema plus complete-result validation in `patch.go` | `patch.test.ts`: left zero, nested `{}`, full clearing, rejected left-only/right-only/empty recreation with an accompanying alias, complete recreation including zero; read-back after each rejection |
| Required component protection | Nonnullable required-component schema | `requests.test.ts`: null removal rejected with unchanged persisted resource; `patch.test.ts`: false survives replacement |
| Complete Position and double precision | Protocol Position reference and replacement rather than coordinate merge | `requests.test.ts`: missing each coordinate, out-of-range, unknown coordinate property, null and nonfinite JSON token rejected; `patch.test.ts`: zero, boundaries and precision-sensitive complete position retained |
| Immutable and unknown inputs | Closed fixture request schemas, immutable ID/type excluded from patch | `requests.test.ts`: top/nested unknown fields, ID/type changes, scalar/array/item/nested shape failures; a valid accompanying alias never commits |
| UUID, decimal and positive counters | Supported UUID format callback and canonical Protocol counter references | `requests.test.ts`: malformed body/header/path UUID, noncanonical decimal strings, newline, numeric counter and positive zero rejected; representable failures also use generated transport; `patch.test.ts`: zero and `9007199254740993` retained |
| Tagged variants | Independent illustrative Entity/Command unions with required enum tags | `requests.test.ts`: wrong tags, enum and variant fields rejected; `patch.test.ts`: valid Track and fixture movement Command replacements persist |
| Shared typed error boundary | `httpcontract.RequestError`, shared writer and generated hook wiring | `requests.test.ts`, `patch.test.ts`, `request-hooks.test.ts`: expected status/code, canonical Error shape, nonzero diagnostic UUID, safe method/template context and no rejected secret-like values; unchanged GET after every failure |
| Malformed and bounded JSON | Structural validation, generated decoder hooks and exact JSON-frame check | `requests.test.ts`: truncated JSON, multiple documents, trailing data, missing body, top-level array/null and body beyond 4096 bytes; `request-hooks.test.ts`: actual generated strict-decoder failure |
| Fixed Dataset/edition representation | Fixture-only context gate in `request.go` | `requests.test.ts`: missing/malformed/wrong Dataset and missing/unsupported edition rejected before effects; `request-editions.test.ts`: artificial `0.1.0`/`0.2.0` echoed for generated/direct write and persisted read, including a bodyless read with a JSON media header |
| Repeatability and isolation | Existing shared generator, verifier, runner and CI discovery | `python3 scripts/verify.py --bootstrap`: two clean generations, Go format/build/test/vet, strict TypeScript/SDK build, consumer artifact isolation, generated/direct workflows and fixture cleanup |

The accepted scope excludes actual Dataset discovery/negotiation/admission, commit-time Reset protection, principals/signatures/process authority, report acceptance, descriptive concurrency, Contact and operational transitions. HTTP mutation fixtures demonstrate persisted patch behavior only. Unknown operational mutation outcomes and safe retry remain with their owning workflows. The separately generated older-client compatibility evidence belongs to #97.

## Reproduction and source revision

Run from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```

The shared runner discovers every `*.test.ts`; assembly discovers every `*.contract.json`. No per-ticket generator/CI configuration is needed. Generated outputs remain ignored build artifacts and are never edited by hand.

The initial foundation is #95 commit `8c9e203a896b56e7c2a4a48f2b977d73307bf5ca`. The final committed source revision, working-tree state, exact tool locks, generated hashes and required-check result are recorded by the verifier in `.artifacts/verification.json`. Preserve that report with the full verifier log when recording completion. A report from a failed or dirty verification cannot establish final-revision completion.

The locked qualification uses Go `1.27.1`, Node `24.21.0`, npm `11.19.0`, sqlc `1.31.1`, oapi-codegen `2.8.0`, OpenAPI `3.0.3`, kin-openapi `0.149.0`, nethttp-middleware `1.2.0`, nullable `1.2.0`, runtime `1.7.0`, modernc SQLite driver `1.60.1` with SQLite `3.53.4`, TypeScript `5.9.3`, openapi-typescript `7.13.0`, openapi-fetch `0.17.0`, Ajv `8.20.0` and ajv-formats `3.0.1`. Tool/dependency authority remains in the Protocol tool lock, Go modules and SDK package lock rather than this evidence note.
