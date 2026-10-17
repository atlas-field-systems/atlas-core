# Protocol messaging

Protocol defines what a message means. Its link defines how it is carried.
Requests, results, reports, and notifications reuse Protocol's component schemas.
Core validates the contract independently of the link that delivers the message.
Message names, exact payloads, type identifiers, and reply envelopes remain
proposals. The catalog preserves the intended operation scope.

## Message contracts

Each message defines its participants, target, inputs, result, errors, and effects.
Required values, behavior for null and omitted values, bounds, and component
references belong in shared OpenAPI schemas. Bindings define how the link represents
and exchanges messages.

Expected users and purposes are proposed workflows for discussion, not permissions.
Any valid key has the same public permissions under [Identity](identity.md).
The named caller originates the request or report. A gateway may carry it on their behalf.

Dataset, exact Protocol version, authorization, and source identity follow
[Identity](identity.md), [Reports](reports.md), and [Wire](wire.md).
Each mutation identifies its original facts and retry identity. Link delivery,
Core commitment, and Asset execution evidence are distinct outcomes.
A lost result leaves uncertainty. Another link must not silently create new work.

## Resource message families

- [Asset messages](messaging/assets.md): registration, section updates, reads, and deletion.
- [Track messages](messaging/tracks.md): publisher-owned Tracks and observations.
- [Geofeature messages](messaging/geofeatures.md): authored geometry and descriptions.
- [Task messages](messaging/tasks.md): Commands, assigned work, execution, and results.
- [Object messages](messaging/objects.md): complete file publication, metadata, and content.

`RegisterAsset`, `CreateTrack`, and `CreateGeofeature` have distinct input schemas.
Each exposes only the fields and components permitted for its Entity type under
[Entities](entities.md#component-composition). Shared Entity rules still apply.
The public catalog names each Entity type explicitly.

Different public messages may share a Core API operation or internal mechanism.
That mapping does not merge their public input contracts or require one HTTP
endpoint per message. Concrete Core API mapping is outside this catalog.

## Plugin and Operation messages

[Plugin and Operation messages](messaging/plugins.md) cover capability lookup,
invocation, progress, and cancellation under [Operation rules](operations.md).

## Link bindings and scope

Core's IP binding uses HTTP/JSON and a WebSocket change feed as defined in
[Wire](wire.md). Atlas SDK implements that IP binding for application callers.
Another link defines its supported messages, encoding, packetization, correlation,
and delivery behavior. It preserves Protocol meaning, exact version, source evidence,
and retry identity. A link need not carry every message or a full synchronized picture.

Authentication and reference-data disclosure follow Wire. Message labels are not
HTTP paths; concrete IP routes belong to the authored OpenAPI binding.
The Command Catalog remains a local Protocol artifact, not a network discovery service.

Core configuration, lifecycle control, Plugin installation, updates, and runtime
configuration remain local administration. There is no generic Task deletion,
resumable-upload exchange, or remote Core-configuration message.

## Administration messages

| Proposed message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ListResources` | Administration app inspects resource usage and capacity | Bounded inspection query | Resource usage |
| `ReadActivity` | Operator app or diagnostic tool investigates recorded activity | Bounded activity query | Activity records |
| `ListApiKeys` | Administration app reviews provisioned credentials | Bounded key query | Key metadata |
| `CreateApiKey` | Provisioning tool creates a credential for an additional participant | Caller-prepared credential facts and stable creation identity | Committed creation under [Identity](identity.md#enrollment-and-credentials) |
| `RevokeApiKey` | Administration app withdraws an unneeded or compromised credential | Key identity and retry facts | Committed revocation under [Identity](identity.md#deletion-and-revocation) |
| `ListOperators` | Administration app browses operator profiles | Bounded profile query | Matching profiles |
| `GetOperator` | Operator app displays a known operator's profile | Operator identity | Operator profile |
| `CreateOperator` | Administration app records a new operator profile | Profile creation facts and retry identity | Created profile |
| `EditOperator` | Operator app maintains an operator's profile details | Operator identity and permitted profile edits | Committed profile change |
| `DeleteOperator` | Administration app removes an unneeded operator profile | Operator identity and retry facts | Committed deletion |

## Discovery messages

| Proposed message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `GetHealth` | Connecting application discovers the Dataset, exact Protocol version, and health | Authenticated health and discovery request | Dataset, exact Protocol version, and health under [Wire](wire.md) |
| `GetReadiness` | Deployment monitor checks whether Core is ready to serve requests | Authenticated readiness request | Readiness information |
| `GetReference` | Developer or documentation UI reads the contract and schema reference | Authenticated reference request | Documentation or schema information |

## Synchronization messages

| Proposed message | Expected user and purpose | Request | Result |
| --- | --- | --- | --- |
| `ReadSnapshot` | Application maintaining a synchronized picture stages its initial resource views | Snapshot capture and paging context | Captured resource views under [Synchronization](synchronization.md) |
| `ReadChanges` | Synchronizing application replays retained changes from its last complete cursor | Bounded replay context | Whole committed change batches |
| `SubscribeChanges` | Synchronizing application catches up and follows live commits | Subscription and handoff context | Ordered committed changes and synchronization replies |
| `ReleaseSnapshot` | Loading application frees its capture after paging or cancellation | Capture identity | Release acknowledgment or explicit refusal |

Core sends synchronization replies for release, handoff, replay, gaps, and recovery
as defined by [Synchronization](synchronization.md). Exact reply message names remain open.

[Next: wire conventions](wire.md)
