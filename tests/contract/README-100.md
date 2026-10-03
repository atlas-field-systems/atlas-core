# Bounded binary binding qualification, #100

[Ticket #100](https://github.com/atlas-field-systems/atlas-core/issues/100) supplies the binary part of [Slice 0 #94](https://github.com/atlas-field-systems/atlas-core/issues/94). The seam is generated TypeScript transport to generated Go strict handlers over real HTTP and private temporary files, alongside direct Protocol requests in an equivalent isolated fixture.

`binary.contract.json` authors test-only upload/download routes. It references the canonical Identifier, decimal counter, Dataset/version headers, mutation context and Error definitions. Assembly and generation reuse those facts mechanically. The public Protocol has no fixture route, and the SDK consumer package excludes these scenarios and fixture bindings.

Core's `httpcontract.ValidateBinaryRequests` selects one explicit operation from the loaded contract. Configuration refuses a missing, duplicate or nonbinary operation. The pinned Go generator normalizes embedded operation IDs to exported Go names, so this fixture selects `PutFixtureContent`. The adapter preserves the supported structural header/path validator, checks media against that operation's authored content map and wraps the request in `http.MaxBytesReader`. It skips the buffering body decoder only for that operation. Every other operation uses the existing ordinary validator and JSON framing check. Structural and media failures use the shared typed JSON error writer.

The fixture limit is 1,024 bytes. The upload handler streams to an attempt-owned `0600` file inside the runner's private `0700` content directory. It checks copy and close errors, removes failed attempts and selects a complete file only after the bounded copy succeeds. A failed replacement preserves the previously selected fixture bytes. This replacement rule belongs to the test fixture; real Object content is immutable. Downloads read the selected file and return generated binary responses with content type, canonical decimal length, SHA-256 digest and Dataset/version headers. A narrow response adapter retains file-close ownership and reports close failures.

The TypeScript binary body remains the supported generated `string` type. `bodySerializer` converts its octets to `Uint8Array`; `parseAs: "arrayBuffer"` retrieves exact bytes. The common SDK response validator checks declared media and header schemas without parsing the binary body as JSON. No operation wrapper, cast, handwritten `any` or generated-output modification is added.

## Requirement evidence

| Requirement | Implementation | Executed workflow evidence |
| --- | --- | --- |
| Canonical context and metadata reuse | Fixture references plus generated Go/TypeScript bindings | `binary.test.ts`: upload receipt and download Dataset/version metadata validated through both paths |
| Exact binary fidelity | Generated `io.Reader` binding, real private files and supported TypeScript serialization/parsing | Independent `[0,255,65,0,13,10,128]`, length `7` and SHA-256 `a44fcac77b411ed8447cf90172d7921a45758033e504400b2a2ac4699746559b` match uploaded receipt, downloaded octets and response headers |
| Finite streaming body bound | Narrow binary adapter and `http.MaxBytesReader` | Independently authored `binary-limit.bin` contains 1,024 octets of `0xa5`; exact bytes, length and literal fixture digest succeed in both paths. A 1,025-byte replacement returns declared `413 content_too_large` |
| Header/path/media validation retained | Same supported parameter validator, canonical refs and operation content map | Malformed UUID path/header, missing/wrong Dataset, missing/unsupported artificial edition, and undeclared/malformed/missing media return declared typed errors through actual HTTP |
| Typed binary errors | Shared error adapter and declared error responses | Both paths check canonical Error shape, expected status/code, current Dataset, allocated diagnostic UUID and omission of submitted secret-like values. Generated transport validates each error before returning it |
| Failed attempt cleanup and unchanged content | Attempt-owned temporary files, checked close/removal and selection after successful copy | After every rejection, supported GET returns the prior seven octets, length and digest. Actual private-directory inspection shows only the previously selected file remains |
| Runner cleanup with actual content | Existing runner owns process and temporary directory | Both workflows finish with a populated content directory; after runner completion, the entire owned directory is absent |
| Determinism, checks and fixture isolation | Existing automatic fragment/scenario discovery | Shared verifier regenerates twice from absent outputs, runs Go format/build/test/vet and strict TypeScript/SDK checks, verifies consumer package isolation, then executes the complete HTTP and lifetime corpus |

The first direct HTTP tracer failed against the pre-binary fixture with `400 !== 200`, then passed after the route, generated binding and streaming adapter were implemented. The generated and direct workflows subsequently passed the independent metadata, boundary and rejection corpus.

Run from the repository root:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier records the final checked source revision, working-tree state, exact tool versions, generated digests and required-check results in `.artifacts/verification.json`. Preserve that report with the verifier log. Final completion requires a passing report at the committed clean revision. Tool and dependency authority remains the [Protocol toolchain lock](../../Atlas%20Protocol/toolchain.json), Go modules and SDK npm lock; this ticket changes no pins.

This qualifies bounded binary binding adapters only. It implements no Object helper, operational Object endpoint, ready-state publication, transfer identity/retry/deduplication, deletion/result protection, large-file producer replay, SDK streaming-memory guarantee, quota reserve, power-loss durability, production filesystem recovery or cancellation behavior. Artificial fixture editions provide no Atlas release compatibility promise.
