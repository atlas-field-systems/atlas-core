# Append-only position history

**Movement history retains accepted position readings with immutable facts.**
It is separate from latest Telemetry and general activity. Speed and altitude
remain in [latest Telemetry](components/telemetry.md), without historical queries.
[Reports](reports.md#movement-and-recovery) owns admission and retention;
[Telemetry](components/telemetry.md#constituent-reading-identity) owns reading identity.

## HTTP reads in both modes

Asset, Observation, and Track history queries return retained positions. A Track
query preserves original source evidence and association provenance. The default
policy does not create a second measurement identity for the same position.
Inactive records, current-section changes, and Asset deletion do not erase history.

Both SDK modes use explicit HTTP reads. History is absent from snapshots and the
change feed. Core keeps the known-Entity and deletion facts needed to distinguish
unknown IDs from known Entities with no matching positions, including deleted Assets.
The [history query contract](history-queries.md) defines exact ordering, frozen
pages, source-bound continuation, and finite release/expiry. Queries have no implicit
history window. Capacity failure is explicit, never a truncated successful result.

## Admission and immutable facts

Append only newly accepted positions, including late history-only admission that
leaves current Entity images unchanged. Commit history and eligible current effects
together. Preserve original source context and measurement time.

Carrying a position forward in complete Telemetry does not append it again.
An exact retry has no repeated effect. Changed facts under an existing scoped
reading ID reject the submission atomically. New readings use new IDs, even when
coordinates and source times equal an earlier reading. No historical correction,
reading tombstone, or automatic history expiry exists in the initial Dataset.
Never reconstruct history by sampling current-state images.

For example, accepting P2 and then a previously unseen earlier P1 retains both
positions while P2 stays current. Replaying either report adds nothing. A report
reusing P1's ID with changed coordinates fails without modifying either reading.
The full [admission example](report-evidence.md#independent-acceptance-example)
applies to both SDK modes' HTTP reads.

Each new position increases retained volume. Bound query references, pages, decoded
data, and aggregate storage before allocation. Do not evict retained history to
make a query appear complete. Runtime capacity remains unqualified.

## Reading representation

A history `reading` requires `source_entity_kind`, `source_entity_id`, `quantity`,
`value`, `observed_at`, `source_evidence`, `time_status`, and `track_ids`.
Source kind is `asset` or `observation`; quantity is exactly `position`.
Value uses the shared Position type or null. `source_evidence` is exactly the
constituent metadata from [report format](report-format.md), retaining original
origin and reading ID. It is not another report envelope.
`observed_at` is the effective original position time after the section's timestamp
override, retaining its spelling or null. `time_status` is `known`, `unknown`, or
`uncertain`; unknown requires null, while known and uncertain require a timestamp.
`track_ids` is a unique UUID array of associated Tracks at the captured boundary,
empty for Asset readings. The default policy shares the original Observation reading
with its Track, without a second measurement identity.

The full identity tuple in [history queries](history-queries.md#selection-and-exact-order)
identifies a reading. Frozen pages retain its facts and captured provenance.
Independent acceptance and recovery fixtures remain unexecuted implementation work.

[Next: tasks](tasks.md)
