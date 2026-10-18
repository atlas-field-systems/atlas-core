# Asset location history

Full synchronization includes every retained Asset location reading in the existing
picture and feed. HTTP and Full modes expose one bounded `GetAssetMovementHistory`
operation. Full mode reads locally, with no HTTP fallback. Activity stays explicit
HTTP in both modes. Other Asset telemetry, including speed, is current-only.
[Track movement history](messaging/tracks.md#movement-history) remains HTTP-only.

## Reading collection

One authoritative collection has two fixed variants. Each image contains these fields.

| Field | Contract |
| --- | --- |
| `id` | Stable Dataset-scoped reading UUID, bound to one original evidence identity |
| `asset_id` | Owning Asset UUID, retained after deletion |
| `kind` | Exactly `position` or `altitude` |
| `revision` | Positive exact correction counter under [Wire](wire.md#common-representation) |
| `original_evidence` | Original process, evidence ID, and source sequence from [Reports](reports.md#quantity-sources) |
| `observed_at` | Original source UTC timestamp spelling, or null |
| `time_usability` | Core-assigned `known`, `unknown`, or `uncertain` at acceptance |
| `value` | [Position](components/telemetry.md#position) or null for `position`; [Altitude](components/telemetry.md#altitude) or null for `altitude` |

`unknown` means null source time. A non-null accepted source time is `known` unless
Core classifies it as `uncertain` at first acceptance under [time rules](reports.md#time-and-contact).
SDK preserves this classification and original spelling. It never invents a
source time.
Create readings only from original quantity evidence, never whole Entity copies.

Each identity has one accepted revision. A correction preserves original evidence,
Asset, kind, source time, and time usability. It replaces the value at a newer revision.
Exact repeats have no effect. Conflicting reuse of an identity or revision is an
error. Older transport images follow existing replay/version rules.
Frozen queries may retain earlier immutable revisions until release or expiry.

## Current location

Core admits readings and selects current references under source authority,
source ordering, and report role, never timestamp or arrival order. Historical
evidence adds history without selecting older readings as current. SDK never
selects current from the last history row.

A `ReadingRef` contains exactly `id` and `revision`. Successful Asset telemetry
sync images require non-null `position_ref` and `altitude_ref`. Each resolves to
the same Asset and its respective kind at that exact revision. Explicit unknown
position or altitude uses a null-valued reading and a non-null reference.
An error replaces the entire telemetry result and has no usable references or
prior good values. Omitted sections retain their accepted result.

Correcting a reading selected by current telemetry advances the Asset public
version and that reference revision in the same commit. A historical-only
correction need not change the current Asset. [Synchronization](synchronization.md)
owns atomic transport and reference validation. HTTP Asset responses and public
SDK current values expand Position and Altitude with each selected reading's
identity, revision, original source time, and time usability. Callers never join.

## Bounded history queries

Queries bind Asset ID, selected kinds, time group, optional source-time bounds,
and page size under [Wire's page bounds](wire.md#lists). Unsupported filters fail
explicitly. Known-time bounds include the start and exclude the end.
No bounds means all retained matching evidence.

Known-time readings sort by parsed source instant at all Protocol-accepted
fractional precision, then exact sample ID bytewise. Timestamp string order and
rounded milliseconds are invalid substitutes. Equal instants retain their
original spellings. Unknown and uncertain readings form a separate labelled group
ordered by exact sample ID. A query selects either group or both. When both are
selected, the known-time group comes first. Time bounds apply only to known times.

The first page freezes the finite set of matching immutable reading references
at one coherent cursor. Its result includes that cursor and the time group of
each reading. Later pages retain the same membership, order, and revisions despite
inserts or corrections. An empty result is complete.

Tokens bind the view, Dataset, complete query, and continuation; HTTP tokens also
bind Core run, and Full tokens bind SDK instance and picture generation.
The first page includes `release_token`. [ReleaseAssetHistoryView](messaging/assets.md#messages)
acknowledges idempotent release without recreating the view. Full mode releases locally.
Views have finite expiry. Ordinary commits do not invalidate them. Expiry, release,
owner loss, rebuild, or Reset makes continuation return explicit restart.
Changed query or context cannot reuse a token.

Bound active views and reference counts before allocation. An over-limit first page
returns `resource_limit` without allocating a partial view or invalidating the picture.
Charge views and their retained revisions to aggregate capacity. Live synchronization takes
priority. Under pressure, expire optional history views and release their
references, then retry whole-commit capacity checking before pausing the picture.
Canonical readings are never evicted to make room.

## Deletion and lifetime

Asset deletion removes the current Asset and preserves its readings. Minimal
versioned Asset tombstones distinguish known deleted IDs with zero matching
readings from unknown IDs. Captures retain those tombstones, including after
rebuild. Reset clears Assets, readings, tombstones, and query views together.

[Acceptance examples](location-history-examples.md) give independent expected results.
