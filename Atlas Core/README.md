# Core foundation

This folder contains the Core deliverable's generated public models, runtime dependency locks and structural HTTP validation adapter. It is not an operational Core server. The [Slice 0 evidence](../tests/contract/README.md) and [Protocol ownership](../Atlas%20Protocol/README.md) describe the boundary.

`httpcontract.ValidateRequests(spec, next, maxJSONBytes)` requires a positive body bound and installs it before ordinary request reads. It checks the [JSON request representation](../Atlas%20Protocol/README.md#json-request-representation) on the original bytes before the pinned OpenAPI validator and generated strict handler decode them. Importing the adapter registers the supported UUID format for HTTP and non-HTTP canonical schema consumers. `RequestError` is the shared hook for middleware, parameter binding and strict JSON decoding. `WriteError` emits Protocol's typed JSON error envelope with a diagnostic UUID and known Dataset context from the owner-set response header. Owning modules still supply authorization, complete-result validation, Dataset admission and commit decisions. The [request/patch checks](../tests/contract/README-96.md) exercise rejection before fixture effects and persisted read-back.

`httpcontract.ValidateBinaryRequests(spec, next, operationID, maxBytes, maxJSONBytes)` selects one binary operation from the loaded contract, validates its header/path/media metadata, and bounds its body stream without the general buffering decoder. Other operations retain ordinary request validation with their separate body bound. Required binary bodies are checked using HTTP framing before wrapping the stream, even when an outer wrapper hides `http.NoBody`; an absent body is distinct from an explicitly empty stream. The handler owns translation of size-limit errors and private attempt cleanup. The [binary checks](../tests/contract/README-100.md) qualify the adapter through generated/direct HTTP and real files at a 1,024-byte fixture limit.

`generated/protocol` comes only from the public Protocol baseline. Everything under `tests/contractfixture` is test tooling, including its generated strict interface, storage bindings and executable. Its loopback routes and SQLite tables implement no production business capability.

Use the repository's single verification entry point:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier executes Go tests freshly on every run, including the message checks whose shared corpus is outside this module. Go compilation and dependency caches remain available. The [verification evidence](../tests/contract/README.md) describes the required real-toolchain regression and passing-report lifecycle.
