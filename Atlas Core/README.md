# Core foundation

This folder contains the Core deliverable's generated public models, runtime dependency locks and structural HTTP validation adapter. It is not an operational Core server. The [Slice 0 evidence](../tests/contract/README.md) and [Protocol ownership](../Atlas%20Protocol/README.md) describe the boundary.

`httpcontract.ValidateRequests` applies the pinned OpenAPI request validator and complete JSON framing before the generated strict handler. Importing the adapter registers the supported UUID format for HTTP and non-HTTP canonical schema consumers. `RequestError` is the shared hook for middleware, parameter binding and strict JSON decoding. `WriteError` emits Protocol's typed JSON error envelope with a diagnostic UUID and known Dataset context from the owner-set response header. Owning modules still supply authorization, complete-result validation, Dataset admission and commit decisions. The [request/patch checks](../tests/contract/README-96.md) exercise rejection before fixture effects and persisted read-back.

`generated/protocol` comes only from the public Protocol baseline. Everything under `tests/contractfixture` is test tooling, including its generated strict interface, storage bindings and executable. Its loopback routes and SQLite tables implement no production business capability.

Use the repository's single verification entry point:

```sh
python3 scripts/verify.py --bootstrap
```
