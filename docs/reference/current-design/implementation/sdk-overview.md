# Atlas SDK

> Retained current design for review. [Planning status](../../../README.md#planning-status).

SDK is the IP-specific TypeScript client for Atlas Core.
The [package guide](sdk-package.md) covers the public HTTP and Full clients, reporting, remote reads and transfers.
These contract pages define the complete SDK scope, including Full synchronization.
It consumes the browser-safe [Protocol](protocol-overview.md) package,
exchanges HTTP/JSON and WSS messages with Core, and provides ordinary handwritten
workflows over shared runtime schemas and inferred types. It imports no Core
database, private types, Node-specific storage, or internal service interfaces.
The [operating environment](../support/operating-environment.md) defines the intended
Pi 5-class-or-better computers, power, and IP connectivity.

## Two explicit read modes

| Mode                         | Behavior                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| HTTP, default                | Read on demand from Core; no maintained replica                                                     |
| Full synchronization, opt-in | Maintain all Assets, Tracks, Geofeatures, Tasks, and ready Object metadata in one in-memory picture |

Ready picture reads, queries, changed-since, and subscriptions use local state.
Loading or unavailable picture data reports its state, never an empty result or
silent HTTP fallback. Full mode has no selectable coverage or live coverage switch.
Inactive Tracks remain in the picture with source IDs and provenance.

Observation records and append-only position history use explicit HTTP reads in
both modes, including source queries by Track or recorded Asset. A
[history view](../entities/history/queries.md) retains its original Core-run
owner for continuation and release. No local history view is created.
Object bytes, operator/key administration, and activity also remain explicit HTTP.
All domain mutations go to Core. Generic Plugin discovery and Operations are
outside the initial release. Independent integrations can use public HTTP and credentials.

All picture data is in memory. SDK/application restart rebuilds it from Core.
There is no persistent cache, offline write queue, or shared cross-tab replica.
Most Asset reporting clients need only HTTP mode.

## Package boundary

Protocol supplies shared runtime schemas, inferred types, errors, Command definitions,
and [message contracts](../shared/messages.md), plus the portable OpenAPI
reference. SDK implements Core's IP binding and supplies connection setup, runtime
response validation, safe prepared requests, replayable file inputs, Asset-update
and Observation-report helpers, and optional picture synchronization. Supported
stock transport tooling is preferable to a wrapper generated for every endpoint.

Expose typed helpers for reusable components and concrete resources so consumers
can supply values without assembling or decoding raw JSON. Preserve fields,
precision, and omission/null distinctions. Reuse shared schemas at caller-input and
response boundaries before exposing typed values. Inferred types alone do not
validate runtime data. Core independently validates incoming requests, including
those made without SDK.

The installed Protocol package supplies the local Command Catalog. Asset helpers
prepare registration and section updates. Observation helpers retain continuing
Observation identity, publisher, report identity, immutable reading facts, and
original source times across retries. They expose Core's Track association rather
than creating shared Track IDs or applying client fusion. Both modes use the same
[Observation](../entities/observations/messages.md) and
[Track](../entities/tracks/messages.md) contracts.
Helpers do not execute or schedule physical work. Asset software retains its own
identity and execution evidence. Gateway firmware and radio encoding remain external.

## Connection behavior

Configure base URL, credential provider, explicit mode, timeouts, limits, and normal
TLS trust. Use authenticated discovery to learn Dataset and Core's one Protocol
version. Require an exact match before ordinary work. Validate response context
rather than accepting a different Dataset or version. No version-range negotiation
or automatic downgrade is provided.

WSS authentication precedes data, with a bounded authentication window. Transport
failures can reconnect with bounded backoff. [Authorization recovery](../support/authorization-recovery.md)
requires authenticated discovery with changed credentials. Complete downloaded
picture data remains readable as stale and authorization-required; network work pauses.
Do not calculate clock offsets or automatically replay mutations after reconnect.

[Requests](../shared/requests.md) explains write outcomes. [Picture](../shared/synchronization/client-picture.md) explains
local state and recovery. [Diagnostics](../support/sdk-diagnostics.md) explains traffic and failures.
