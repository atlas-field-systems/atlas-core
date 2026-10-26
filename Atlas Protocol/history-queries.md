# Position history queries

**One bounded HTTP query has one frozen result owned by Core.** Both SDK modes
use this contract. [Movement history](movement-history.md) owns retained position
facts and attribution. There is no local SDK history-view source.

## Selection and exact order

Bind the Entity type and ID, time groups, optional source-time bounds, and page
size under [Wire's limits](wire.md#lists). Reject unsupported filters, including
historical speed or altitude selection. No time bounds means all matching retained
positions. Known-time bounds include the start and exclude the end. Unknown Entity
IDs differ from known-empty results, including deleted Assets with no matching readings.

Known-time readings sort by exact source instant under [Wire](wire.md#common-representation),
then by complete [constituent identity](components/telemetry.md#constituent-reading-identity).
Within the fixed Dataset, compare the tuple of source Entity kind and ID, origin
kind and ID, quantity, and constituent ID bytewise by field. Quantity is always
`position`. A raw constituent ID alone is not globally unique. Timestamp string
order or rounded milliseconds cannot replace exact instant comparison.
Preserve original timestamp spellings.

Unknown and time-uncertain readings form a separate group ordered by that identity
tuple; keep their distinct time status visible. A query selects either group or
both, with known-time readings first. Bounds apply only to the known-time group.
Use source-time facts at the captured boundary, never receipt time or an invented
time. These rules also apply to mixed source evidence in a Track.

## Frozen pages

The first page freezes matching immutable reading references, source/association
provenance, and order at one coherent cursor. Return that cursor, original expiry,
and a release token. Later pages retain those facts despite new readings or
association changes. A fresh query sees later committed facts. An empty result
is complete, never loading.

First-page allocation binds a stable query ID and exact query facts to a finite,
owner-bound context. Exact retries recover the same view and original expiry;
changed facts conflict. Expired, released, or old-owner contexts cannot allocate
another view, even after bounded allocation receipts are pruned. If an allocation
reply is lost, recover it or await its expiry before replacing it.

Continuation and release tokens bind the view, Dataset, complete query, and original
Core-run owner; continuation also binds its position. They never trigger an invisible
replacement query or switch to local data. Recheck view validity, current authority,
and Dataset after waits under [temporary-read rules](temporary-reads.md#continuation-and-release).

## Release, expiry, and capacity

[ReleaseHistoryView](messaging.md#history-query-control) releases a view through Core
after paging or cancellation. Release is idempotent and safe after invalidation;
it never recreates a view or releases an unrelated one. Authentication and
Dataset/context refusals still apply. All views have finite monotonic expiry.
Ordinary commits do not invalidate them. Expiry, release, or owner loss makes
continuation report an explicit need to restart. Core Restart expires views.
Reset invalidates views and old Dataset context. SDK close does not prove release;
remote acknowledgment or original expiry ends the allocation.

Bound active views, matching-reference counts, frozen data, and allocation receipts
before proportional allocation. An over-limit first page reports `resource_limit`
without exposing a partial view. Charge views and retained data to aggregate capacity.
Under pressure, expire temporary views and recheck capacity before pausing otherwise
viable synchronization or refusing writes. Never evict source history or truncate
a query to fit. [Temporary contexts](temporary-reads.md) fix allocation fields,
expiry, finite counts, and release acknowledgment. Full request and page fields
are defined in [history messages](messaging/history.md).

## Independent acceptance example

Use one Entity and original source, with P1 at `2026-10-21T12:00:01Z` and P3 at
`2026-10-21T12:00:03Z`. Labels abbreviate UUIDs. Both SDK modes issue HTTP queries.

| Action | Required result |
| --- | --- |
| Open a known-time query at cursor C with page size 1 | P1; the view freezes P1 and P3 at C |
| Lose that reply and retry its exact allocation context | Same view and expiry, no extra allocation |
| Admit previously unseen P2 at `12:00:02Z` | P2 enters history; current sections follow [evidence admission](report-evidence.md) |
| Submit changed coordinates or time under P3's scoped reading ID | Reject `constituent_conflict` atomically |
| Continue the original query | Original P3, then complete; P2 is absent |
| Open a fresh query after P2 admission | P1, P2, P3 in source-time order |
| Release the original view twice, then continue it | Both releases are safe; continuation requires restart |

For exact ordering in one scope, P9 at `.0000001Z` precedes P1 at `.0000002Z`.
Equal instants `.1Z` and `.100Z` use the identity tie-break and retain both spellings.
Unknown/uncertain readings remain in their separate group. Repeat with a Track's
mixed sources sharing a constituent ID: their different scopes remain distinct.
Separately, accept P4 at Core `12:00:00Z` with source time `12:01:00Z`. At `12:02:00Z`, a new
query still groups P4 as uncertain under [time classification](reports.md#time-and-contact),
even after carry-forward, replay, or Restart. A known-only query excludes P4.
These are independent expected outcomes, not claims of executed runtime tests.

[Movement history](movement-history.md)
