# Protocol messaging

Protocol defines what a message means. Its link defines how it is carried.
Requests, results, reports, and notifications reuse Protocol's component schemas.
Core validates the contract independently of the link that delivers the message.
The linked contracts select message names, control fields, and reply envelopes.
The static HTTP binding map in `src/exchanges.ts` encodes 66 HTTP operations.
`src/synchronization.ts` owns the complete WSS control and event schemas.
The separate reference entry exports their OpenAPI document with stock tooling.

## Message contracts

Each message defines its participants, target, inputs, result, errors, and effects.
Required values, behavior for null and omitted values, bounds, and component
references belong in shared runtime schemas and their OpenAPI export. Bindings
define how the link represents and exchanges messages.

Expected users describe callers and purposes, not permissions.
Any valid key has the same public permissions under [Identity](identity.md).
The named caller originates the request or report. A gateway may carry it on their behalf.

Dataset, exact Protocol version, authorization, and source identity follow
[Identity](identity.md), [Reports](reports.md), and [Wire](wire.md).
Each mutation identifies its original facts and retry identity. Link delivery,
Core commitment, and Asset execution evidence are distinct outcomes.
A lost result leaves uncertainty. Another link must not silently create new work.

## Resource message families

- [Asset messages](messaging/assets.md): registration, section updates, reads, and deletion.
- [Observation messages](messaging/observations.md): publisher-owned detections and successive reports.
- [Track messages](messaging/tracks.md): shared targets, source associations, and evidence reads.
- [Geofeature messages](messaging/geofeatures.md): authored geometry and descriptions.
- [Task messages](messaging/tasks.md): Commands, assigned work, execution, and results.
- [Object messages](messaging/objects.md): complete file publication, metadata, and content.

`RegisterAsset`, `CreateObservation`, and `CreateGeofeature` have distinct input schemas.
Each exposes only the fields and components permitted for its Entity type under
[Entities](entities.md#component-composition). Tracks are created by the active
[fusion policy](tracks.md), not by an Asset creation message.

Shared internal mechanisms do not merge public message contracts. The initial
[static IP mapping](wire.md#deterministic-ip-mapping) assigns each message its binding.

## Link bindings and scope

Core's IP binding uses HTTP/JSON and a WebSocket change feed as defined in
[Wire](wire.md). Atlas SDK implements that IP binding for application callers.
Compact and constrained-radio bindings are unsupported initially. External gateway
translation must preserve Protocol meaning, exact version, evidence, and retry identity.

Authentication and reference-data disclosure follow Wire. Wire selects a deterministic
route mapping; the implementation records it in OpenAPI.
The Command Catalog remains a local Protocol artifact, not a network discovery service.

Core configuration, lifecycle control, and updates remain local administration.
There is no generic Task deletion, resumable-upload exchange, or remote
Core-configuration message.

## Administration messages

[Administration and discovery](messaging/administration.md) defines key and
operator-profile messages, health, readiness, reference, activity, and resource reads.
Operator lifecycle and atomic key revocation follow [Identity](identity.md#operator-profiles).

## Discovery messages

Authenticated discovery returns Dataset, exact version, current Core run, effective
limits, and a temporary allocation context under [Wire](wire.md#common-representation).

## Synchronization messages

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ReadSnapshot` | Application stages the fixed operational picture | Snapshot capture and paging context | Captured data under [Synchronization](synchronization.md) |
| `ReadChanges` | Synchronizing application replays retained changes from its last complete cursor | Bounded replay context | Complete picture effects and ordered progress |
| `SubscribeChanges` | Synchronizing application catches up and follows live commits | Subscription and handoff context | Ordered committed effects, progress, and synchronization replies |
| `ReleaseSnapshot` | Loading application frees its capture after paging or cancellation | Capture identity | Release acknowledgment or explicit refusal |

[Synchronization envelopes](synchronization-messages.md) fix concrete requests and
replies for the single fixed picture.

## History query control

| Message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ReleaseHistoryView` | Query caller frees an Asset, Observation, or Track history view after paging or cancellation | The view's source-bound release token | Idempotent release acknowledgment or explicit refusal under [history query rules](history-queries.md#release-expiry-and-capacity) |

[History messages](messaging/history.md) define exact allocation, query, page, and
release fields. Continuation and release keep the original Core-run owner.
Release frees a temporary view without deleting retained history.

[Next: wire conventions](wire.md)
