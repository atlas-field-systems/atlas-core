# Movement history

**Movement history retains accepted measurements and their corrections.**
It is separate from the latest Entity section and from general activity records.
[Reports](reports.md#movement-and-recovery) owns measurement admission and retention;
[Telemetry](components/telemetry.md#constituent-reading-identity) owns reading
identity, original source times, and correction revisions.

## Query coverage

Asset, Observation, and Track movement queries include their retained position,
speed, and altitude evidence. A Track query preserves its source evidence and
association provenance. The default policy does not create a second measurement
identity for the same reading. Source evidence remains attributable when an Entity
is inactive or its current section changes, and Asset deletion does not erase history.

HTTP mode requests history on demand. Full synchronization can independently enable
all retained movement history under the [coverage contract](synchronization.md).
This includes history attributable to retained or deleted Assets and retained
Observations and Tracks, including inactive records. It does not require enabling
the Observation-record cache. History carries the source and association facts
needed to answer its queries without dereferencing uncached Observation records.
Include the known-Entity and deletion facts needed to distinguish an unknown ID
from a known Entity with no matching readings, even when its current record is absent.

Disabled history coverage uses explicit on-demand requests by Asset, Observation,
or Track. Enabled, ready coverage answers the same bounded queries locally;
loading or incomplete coverage is not a successful empty result.
The synchronized history includes the correction facts exposed by those queries;
it must not silently narrow their meaning to only newly received readings.
The shared [history query contract](history-queries.md) defines exact ordering,
frozen pages, source-bound continuation, and bounded release/expiry for both modes.

## Snapshot and incremental changes

An initial history capture contains the retained readings and correction facts at
its baseline. Subsequent commits carry newly accepted readings and corrections,
including history-only admission that leaves current Entity images unchanged.
Commit their history and eligible current-state effects together and apply all
selected effects atomically. Preserve source context and original measurement time.

Carrying a reading forward in a complete Telemetry section does not append it again.
An exact retry has no repeated effect. A higher accepted correction revision updates
the same reading and retains its correction provenance; it does not become a new
sample or a fresh current measurement. Never reconstruct history by sampling the
current-state feed or copying each complete Entity image.

For example, accepting position P2 and then a previously unseen earlier P1 adds both
readings to history while P2 stays current. Correcting P1 changes its retained
history without replacing P2. Replaying either submission adds nothing. The full
[admission example](report-evidence.md#independent-acceptance-example) applies to
both HTTP history reads and synchronized history.

If the history snapshot contains P2 and P1 arrives during loading, catch-up must
include P1 before the cache becomes ready. A correction to P1 before the cutover
must also be present: two readings, P1 at its accepted correction revision, P2 still
current. Activating history must not add duplicate P2 or omit the late P1.

Past readings usually remain unchanged, but each new accepted reading increases
retained volume. Bound snapshots, whole change batches, decoded data, and total
client storage before allocation. No implicit eviction or history window may make
an enabled cache claim complete coverage. Unsupported capacity is explicit.

## Reading representation

A history `reading` requires `source_entity_kind`, `source_entity_id`, `quantity`,
`value`, `observed_at`, `source_evidence`, `time_status`, and `track_ids`. Source kind is `asset`
or `observation`; quantity is `position`, `altitude`, `ground_speed`, or `airspeed`.
Value uses that quantity's shared component type and permitted nulls. `source_evidence`
is exactly the constituent metadata from [report format](report-format.md), retaining
its original origin, identity, and correction revision. It is not another report envelope.
`observed_at` is the effective original quantity time after the section's timestamp
override, retaining its spelling or null. `time_status` is `known`, `unknown`, or
`uncertain`; unknown requires null, while known and uncertain require a timestamp.
`track_ids` is a unique UUID array of associated Tracks at the captured boundary,
empty for Asset readings. The default policy shares the original Observation reading
with its Track, without a second measurement identity. Corrections replace that
reading's retained revision and keep the original time.

The full identity tuple in [history queries](history-queries.md#selection-and-exact-order)
identifies a reading. Pages and synchronization carry its complete retained revision.
A `history_entity` marker supplies kind, ID, version, and deletion status for known
Entities, including those with no readings. It is coverage metadata, not a measurement.
Snapshots include these markers; commits maintain them atomically with Entity changes.
No reading tombstone or automatic history expiry exists in the initial Dataset.
HTTP/Full equivalence and recovery fixtures remain unexecuted implementation work.

[Next: tasks](tasks.md)
