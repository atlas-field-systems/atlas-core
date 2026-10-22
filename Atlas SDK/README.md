# Atlas SDK

SDK is the IP-specific TypeScript client for Atlas Core.
It consumes [Protocol](../Atlas%20Protocol/README.md), exchanges messages with Core
over HTTP/JSON and WebSocket, and provides handwritten workflows that use generated
declarations.
It must not import Core's database, private types, or internal service interfaces.
The [operating environment](../operating-environment.md) defines the intended
Pi 5-class-or-better computers, power, and IP connectivity.

## Two explicit read modes

| Mode | Behavior |
| --- | --- |
| HTTP, default | Read on demand from Core; no maintained replica |
| Full synchronization, opt-in | Maintain Assets, Tracks, Geofeatures, Tasks, and ready Object metadata in one in-memory picture, with optional Observation and movement-history coverage |

Full mode has two independent switches, both off by default: maintain retained
Observations, and maintain retained movement history for Assets, Observations, and
Tracks. Each covers the whole Dataset, including inactive records and retained
history for deleted Assets. These are fixed coverage options, not per-Entity replication.

Reads, queries, changed-since, and subscriptions for ready coverage use local state.
When an option is off, its reads use explicit HTTP operations, including Observation
queries by Track or recorded source Asset and per-Entity movement history. When it
is enabled but loading or unavailable, report that state; never silently fall back
to HTTP or present missing data as an empty result. Query meanings stay consistent.
An already opened [history query](../Atlas%20Protocol/history-queries.md) keeps its
original HTTP or local source for continuation and release across option changes.

Object bytes, Plugin Operations/discovery, operator/key administration, and activity
history remain explicit HTTP operations in both modes. All domain mutations go to Core.
All synchronized data is in memory: SDK/application restart rebuilds the selected
coverage from Core. There is no persistent SDK cache, offline write queue, or shared
cross-tab replica. Most Asset reporting clients need only HTTP mode.

## Package boundary

Protocol supplies shared types, schemas, errors, Command definitions, and
[message contracts](../Atlas%20Protocol/messaging.md). SDK implements Core's IP binding
and supplies connection setup, runtime response validation, safe prepared
requests, replayable file inputs, Asset-update and Observation-report helpers, and optional picture synchronization.
Use a stock typed HTTP client before adding generated wrappers for every endpoint.

Expose typed helpers for Protocol's reusable components and concrete resources so
consumers can supply values without assembling or decoding raw JSON. Preserve the
same fields, precision, and omission/null rules. Reuse Protocol schemas for runtime
validation of caller inputs and responses before exposing typed values. Generated
types alone do not validate runtime data. Core independently validates incoming
requests, including requests made without SDK; SDK does not replace that boundary.

The Command Catalog is available locally from the installed Protocol artifact.
Asset helpers prepare registration and section updates. Observation helpers retain
the continuing Observation identity, publisher, individual report evidence, and
correction facts across retries. They expose Core's Track association rather than
creating shared Track IDs or applying client fusion. Both read modes use the same
[Observation](../Atlas%20Protocol/messaging/observations.md) and
[Track](../Atlas%20Protocol/messaging/tracks.md) contracts.
They do not execute or schedule physical work. Asset software must retain its own
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
local state and recovery. [Diagnostics](diagnostics.md) explains observation of
traffic and failures. These workflows are handwritten.
