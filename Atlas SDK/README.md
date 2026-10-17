# Atlas SDK

**SDK is the IP-specific TypeScript client for Atlas Core.**
It consumes [Protocol](../Atlas%20Protocol/README.md), exchanges messages with Core
over HTTP/JSON and WebSocket, and provides handwritten workflows over generated declarations.
It must not import Core's database, private types, or internal service interfaces.

## Two explicit read modes

| Mode | Behavior |
| --- | --- |
| HTTP, default | Read on demand from Core; no maintained replica |
| Full synchronization, opt-in | Maintain all Entities, Tasks, and ready Object metadata in one in-memory picture |

Both modes use SDK. In Full mode, resource reads, full queries, changed-since, and
subscriptions use the local picture. No hidden HTTP fallback or per-call bypass
pretends to repair incomplete coverage. The public query semantics stay consistent.

Object bytes, Plugin Operations/discovery, operator/key administration, and movement/
activity history use explicit HTTP operations in both modes. They are outside the
picture. All mutations go to Core. There is no persistent SDK cache, offline write
queue, hybrid/selective mode, or shared cross-tab replica.

## Package boundary

Protocol supplies shared types, schemas, errors, Command definitions, and
[message contracts](../Atlas%20Protocol/messaging.md). SDK implements Core's IP binding
and supplies connection setup, runtime response validation, safe prepared
requests, replayable file inputs, Asset-update helpers, and optional picture upkeep.
Use a stock typed HTTP client before adding generated wrappers for every endpoint.

Expose typed helpers for Protocol's reusable components and concrete resources so
consumers can supply values without assembling or decoding raw JSON. Preserve the
same fields, precision, and omission/null rules. Reuse Protocol schemas for runtime
validation of caller inputs and responses before exposing typed values. Generated
types alone do not validate runtime data. Core independently validates incoming
requests, including requests made without SDK; SDK does not replace that boundary.

The Command Catalog is available locally from the installed Protocol artifact.
Asset helpers prepare registration, section updates, source identity, and reconciliation;
they do not execute or schedule physical work. Asset software must retain its own
identity and execution evidence. Gateway firmware and radio encoding remain external.

## Connection behavior

Configure base URL, credential provider, explicit mode, timeouts, limits, and normal
TLS trust. Use Protocol's authenticated discovery exchange to learn Dataset and
Core's one Protocol version. Require an exact version match before ordinary work.
Validate response context rather than silently accepting a different Dataset or
version. No compatibility-range negotiation or automatic downgrade is needed.

WebSocket authentication precedes data, with a bounded authentication window.
Transport failures can reconnect with bounded backoff; authorization failures pause
until credentials change. Do not calculate clock offsets or automatically replay
mutations after reconnect.

[Requests](requests.md) explains write outcomes. [Picture](picture.md) explains
local state and recovery. Neither is generated from Core implementation.
