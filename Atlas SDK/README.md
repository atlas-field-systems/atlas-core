# SDK foundation

The consumer entry point exports the supported `openapi-fetch` transport, generated public Protocol types, and schema-driven validation adapters. It implements no operational helper or full synchronization mode yet. The [Slice 0 fixture](../tests/contract/README.md) uses this same adapter against separately generated test-only paths.

`responseValidation(document, context)` supplies middleware for a transport client. It checks declared response status/media type, Dataset/version headers, and the referenced JSON schema before `openapi-fetch` returns interpreted data. When a declared schema contains a success envelope, its Dataset must agree with the selected context. Error envelopes are checked too. The returned response body remains available because validation parses a clone. `ResponseValidationError` reports a typed reason and HTTP status; it makes no decision about mutation commitment or safe retry.

`contractValidator(document)` compiles references into the authored canonical document with the pinned Ajv implementation. It preserves omission/null/zero and performs no value coercion, default insertion or property removal. It supports the [qualified profile](../Atlas%20Protocol/README.md#supported-schema-profile).

Consumer exports and the SDK build include `src` and public `generated` types. Test-only routes, schemas, fixture SQL and response switches stay outside those exports. Public `paths` is intentionally empty until an operational slice authors its endpoints. No publication or release-version range is established by this package.

Run all required checks from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```
