# Atlas Core

This folder contains the operational S1 server, generated Protocol bindings and structural validation adapters. `cmd/atlas-core` serves the 19 S1 routes over TLS with real SQLite. `cmd/atlas-manager` owns local container lifecycle outside Core; `cmd/atlas` is its Unix-socket client. See [deployment](../deployment/README.md) for setup and the [S1 qualification map](../tests/s1/README.md) for workflows and faults.

`systemoperations` composes the HTTP handlers. `identity` owns enrollment, principals and process proofs; `entities` owns Asset reports, sparse telemetry and movement; `tasks` owns issuance and transitions. `writecommit` alone opens the database and commits module effects, retry/report acceptance, changes and attributed activity together. Each module's private SQL is generated through sqlc. The host manager uses Core's private maintenance socket and never opens SQLite.

Identity-authorized reads capture their data and Core boundary in one transaction. Entity Alias comparison uses one stored Unicode simple-fold key with a unique constraint; resource JSON preserves the original text. Paging tokens bind validated filters through a SHA-256 digest, keeping supported large selections within Protocol's cursor bound.

The [focused Plugin bookkeeping component](plugins/README.md) implements the Core-module/private-Plugin-process seam from [spec #117](https://github.com/atlas-field-systems/atlas-core/issues/117), with its own real-storage workflows and explicit remaining integration requirements.

`httpcontract.ValidateRequests(spec, next, maxJSONBytes)` requires a positive body bound and installs it before ordinary request reads. It checks the [JSON request representation](../Atlas%20Protocol/README.md#json-request-representation) on the original bytes before the pinned OpenAPI validator and generated strict handler decode them. Importing the adapter registers the supported UUID format for HTTP and non-HTTP canonical schema consumers. `RequestError` is the shared hook for middleware, parameter binding and strict JSON decoding. `WriteError` emits Protocol's typed JSON error envelope with a diagnostic UUID and known Dataset context from the owner-set response header. Owning modules still supply authorization, complete-result validation, Dataset admission and commit decisions. The [request/patch checks](../tests/contract/README-96.md) exercise rejection before fixture effects and persisted read-back.

`httpcontract.HTTPEncoding` adds bounded single-member gzip around the original JSON bytes. It advertises supported request coding and compresses eligible responses only when the complete HTTP/1.1 message is smaller. Core disables HTTP/2 for this qualified transport. The [operational contract](../Atlas%20Protocol/operational-contract.md) defines proof bytes, report provenance and transport limits.

`httpcontract.ValidateBinaryRequests(spec, next, operationID, maxBytes, maxJSONBytes)` selects one binary operation from the loaded contract, validates its header/path/media metadata, and bounds its body stream without the general buffering decoder. Other operations retain ordinary request validation with their separate body bound. Required binary bodies are checked using HTTP framing before wrapping the stream, even when an outer wrapper hides `http.NoBody`; an absent body is distinct from an explicitly empty stream. The handler owns translation of size-limit errors and private attempt cleanup. The [binary checks](../tests/contract/README-100.md) qualify the adapter through generated/direct HTTP and real files at a 1,024-byte fixture limit.

`generated/protocol` comes only from the public Protocol baseline. Everything under `tests/contractfixture` is test tooling, including its generated strict interface, storage bindings and executable. Its loopback routes and SQLite tables implement no production business capability.

Use the repository's single verification entry point:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier executes Go tests freshly on every run, including the message checks whose shared corpus is outside this module. Go compilation and dependency caches remain available. The [verification evidence](../tests/contract/README.md) describes the required real-toolchain regression and passing-report lifecycle.
