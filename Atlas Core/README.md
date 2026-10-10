# Core

This folder contains Atlas Core: the S1 operational server from [spec #122](https://github.com/atlas-field-systems/atlas-core/issues/122), its host-side management, the generated public models and the structural HTTP validation adapter. The [S1 coverage record](../tests/s1/README.md) maps the implemented requirements to executed evidence; the [Slice 0 evidence](../tests/contract/README.md) and [Protocol ownership](../Atlas%20Protocol/README.md) describe the foundation.

| Path | Responsibility |
| --- | --- |
| `system/` | Installation setup, Dataset opening and Reset establishment, write commits with change and activity records, retry identity, page tokens, local activity journal import and private pre-commit fault injection |
| `identity/` | Principals, credential verifiers, deployment enrollment verification, Asset bindings with recovery keys, and revocation |
| `entities/` | Asset registration, shared Asset report acceptance and process authority, Contact challenges and derived communication state, reports, descriptive edits, deletion and movement history |
| `tasks/` | Queued Move To admission, the pure transition module, cancellation, Asset lifecycle reports and the per-Asset queue aggregate |
| `api/` | The public HTTPS boundary: routing, authentication, edition and Dataset checks, gzip content coding, protected documentation and the generated strict handlers |
| `corerun/`, `cmd/atlas-core/` | The Core container process: owned mounts, the private Unix-socket management protocol (peer UID checked), Dataset opening and HTTP/1.1 TLS serving |
| `manager/`, `cmd/atlas-manage/` | Host-side local management: setup, inspection, Start/Stop/Restart, ordinary Reset with durable action records, enrollment authorization, activity and test faults. Docker control stays on the host; Core never receives the Docker socket |

Setup refuses an installation root whose private socket path would exceed the Unix socket address limit. Core is the sole accessor of its SQLite database. Each module owns its private tables and sqlc queries; collaborators use module interfaces inside one `system.Store` commit. Build the CLI and load the `FROM scratch` image, then follow the [documented demonstration](../tests/simulator/README.md):

```sh
python3 scripts/build_core.py
.artifacts/atlas-manage setup --root DIR --recovery DIR --admin-key-file FILE --enrollment-authority-file FILE
```

The [focused Plugin bookkeeping component](plugins/README.md) implements the Core-module/private-Plugin-process seam from [spec #117](https://github.com/atlas-field-systems/atlas-core/issues/117), with its own real-storage workflows and explicit remaining integration requirements.

`httpcontract.ValidateRequests(spec, next, maxJSONBytes)` requires a positive body bound and installs it before ordinary request reads. It checks the [JSON request representation](../Atlas%20Protocol/README.md#json-request-representation) on the original bytes before the pinned OpenAPI validator and generated strict handler decode them. Importing the adapter registers the supported UUID format for HTTP and non-HTTP canonical schema consumers. `RequestError` is the shared hook for middleware, parameter binding and strict JSON decoding. `WriteError` emits Protocol's typed JSON error envelope with a diagnostic UUID and known Dataset context from the owner-set response header. Owning modules still supply authorization, complete-result validation, Dataset admission and commit decisions. The [request/patch checks](../tests/contract/README-96.md) exercise rejection before fixture effects and persisted read-back. `httpcontract.ValidateAuthenticatedRequests` applies this validation to the operational contract and leaves its declared security to Core's boundary, which authenticates before validation.

`httpcontract.ValidateBinaryRequests(spec, next, operationID, maxBytes, maxJSONBytes)` selects one binary operation from the loaded contract, validates its header/path/media metadata, and bounds its body stream without the general buffering decoder. Other operations retain ordinary request validation with their separate body bound. Required binary bodies are checked using HTTP framing before wrapping the stream, even when an outer wrapper hides `http.NoBody`; an absent body is distinct from an explicitly empty stream. The handler owns translation of size-limit errors and private attempt cleanup. The [binary checks](../tests/contract/README-100.md) qualify the adapter through generated/direct HTTP and real files at a 1,024-byte fixture limit.

`generated/protocol` comes only from the public Protocol baseline. Everything under `tests/contractfixture` is test tooling, including its generated strict interface, storage bindings and executable. Its loopback routes and SQLite tables implement no production business capability.

Use the repository's single verification entry point:

```sh
python3 scripts/verify.py --bootstrap
```

The verifier executes Go tests freshly on every run, including the message checks whose shared corpus is outside this module. Go compilation and dependency caches remain available. The [verification evidence](../tests/contract/README.md) describes the required real-toolchain regression and passing-report lifecycle.
