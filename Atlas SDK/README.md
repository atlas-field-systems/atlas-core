# Atlas SDK

**SDK is the TypeScript way to use Atlas, not another source of server policy.**
It consumes [Protocol](../Atlas%20Protocol/README.md), communicates with Core, and
provides a small set of handwritten client workflows over generated declarations.
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

Protocol supplies shared types, schemas, errors, Command definitions, and transport
contracts. SDK supplies connection setup, runtime response validation, safe prepared
requests, replayable file inputs, Asset-report helpers, and optional picture upkeep.
Use a stock typed HTTP client before adding generated wrappers for every endpoint.

The Command Catalog is available locally from the installed Protocol artifact.
Asset helpers prepare registration, process/report identity, and reconciliation;
they do not execute or schedule physical work. Asset software must retain its own
identity and execution evidence. Gateway firmware and radio encoding remain external.

## Connection behavior

Configure base URL, credential provider, explicit mode, timeouts, limits, and normal
TLS trust. Discover Dataset and mutually supported Protocol edition. Validate actual
response context rather than silently accepting a different Dataset or edition.

WebSocket authentication precedes data, with a bounded authentication window.
Transport failures can reconnect with bounded backoff; authorization failures pause
until credentials change. Do not calculate clock offsets or automatically replay
mutations after reconnect.

[Requests](requests.md) explains write outcomes. [Picture](picture.md) explains
local state and recovery. Neither is generated from Core implementation.
