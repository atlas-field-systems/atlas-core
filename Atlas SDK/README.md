# SDK foundation

The consumer entry point exports the supported `openapi-fetch` transport, generated public Protocol types, schema-driven validation adapters and local representative Command Catalog lookup. It implements no operational helper or full synchronization mode yet. The [Slice 0 fixture](../tests/contract/README.md) uses these same adapters against separately generated test-only paths.

`responseValidation(document, context)` supplies middleware for a transport client. It checks declared response status/media type, required headers and present header schemas, and the referenced JSON schema before `openapi-fetch` returns interpreted data. Dataset/version context must agree with the selected context wherever declared. Validated Dataset UUIDs compare by identity across canonical, uppercase and UUID URN spellings; protocol versions compare exactly. JSON envelope Dataset context is checked too, including error envelopes. JSON validation parses a clone, leaving the returned body available; declared raw JSON, binary and no-body responses retain their own representation. `ResponseValidationError` reports a typed reason, HTTP status and safe method/schema-path context; it makes no decision about mutation commitment or safe retry.

Response construction visits only HTTP method entries, so shared path parameters and other Path Item metadata are permitted. Media matching ignores token casing while JSON schema references retain the authored content key. The [response checks](../tests/contract/README-97.md) cover these adapter boundaries.

`contractValidator(document)` compiles references into the authored canonical document with the pinned Ajv implementation. It preserves omission/null/zero and performs no value coercion, default insertion or property removal. It supports the [qualified profile](../Atlas%20Protocol/README.md#supported-schema-profile).

`lookupCommand(name)` reads representative Move To/Pause metadata from the installed canonical Protocol artifact and returns its schema association and input validator, or `undefined` for an unknown name. It performs no network request. The [Catalog evidence](../tests/contract/README-99.md) records the incomplete binding and operational exclusions.

Consumer exports select compiled JavaScript and TypeScript declarations in `dist`, including the canonical Protocol artifact used by the Catalog. The `/protocol` export exposes the public generated declarations. The verifier rebuilds from absent `dist`, then loads the package by name with ordinary Node and checks consumer imports through both exports. Test-only routes, schemas, fixture SQL and response switches stay outside the consumer package. Public `paths` is intentionally empty until an operational slice authors its endpoints. No publication or release-version range is established by this package.

The required TypeScript lint command uses the pinned compiler API for handwritten SDK and contract code. It rejects explicit `any`, suppression directives, nested type assertions and functions that only assert a parameter's type. Const assertions and `satisfies` remain supported. Only `*.type-test.ts` files under SDK checks or contract tests may use `@ts-expect-error`; their required compiler checks fail when the intended error disappears. Other assertion invariants still require review under the [code conventions](../docs/agents/code-conventions.md#types-and-language-conventions).

Run all required checks from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```
