# Movement history queries

**One bounded query has one frozen result, whether served by Core or a ready local cache.**
Asset, Observation, and Track queries use the existing evidence, correction, and
optional-coverage rules in [Movement history](movement-history.md).

## Selection and exact order

Bind the Entity type and ID, selected quantities, time groups, optional source-time
bounds, and page size under [Wire's limits](wire.md#lists). Reject unsupported filters.
No time bounds means all retained matching evidence. Known-time bounds include the
start and exclude the end. Unknown Entity IDs differ from known-empty results,
including deleted Assets whose retained history has no matching readings.

Known-time readings sort by exact source instant under [Wire](wire.md#common-representation),
then by complete [constituent identity](components/telemetry.md#constituent-observation-identity).
Within the fixed Dataset, compare the tuple of source Entity kind and ID, origin
kind and ID, quantity, and constituent ID bytewise by field. A raw constituent ID
alone is not globally unique. Timestamp string order or rounded milliseconds cannot
replace exact instant comparison. Preserve original timestamp spellings.

Unknown and time-uncertain readings form a separate group ordered by that identity
tuple; keep their distinct time status visible. A query selects either group or
both, with known-time readings first. Bounds apply only to the known-time group.
Use the source-time facts at the captured boundary, never receipt time or a newly
invented time. These rules also apply to mixed source evidence in a Track.

## Frozen pages

The first page freezes matching reading identities, their accepted revisions,
correction facts, source/association provenance, and order at one coherent cursor.
Return that cursor, the original expiry, and a release token. Later pages retain
those facts despite new readings, corrections, or association changes. A fresh
query sees the later committed facts. An empty result is complete, never loading.

First-page allocation binds a stable query ID and exact query facts to a finite,
owner-bound context. Exact retries recover the same view and original expiry;
changed facts conflict. Expired, released, or old-owner contexts cannot allocate
another view, even after bounded allocation receipts are pruned. If an allocation
reply is lost, recover that allocation or await its expiry before replacing it.

Continuation and release tokens bind the view, Dataset, complete query, and original
source; continuation also binds its position. HTTP views bind the Core run. Local
views bind the SDK instance, picture generation, and required history coverage.
Continuation and release always use that original owner, including an HTTP query
opened before local history was enabled. Options never redirect an existing token
or trigger an invisible replacement query. Recheck validity and authorization after waits.

## Release, expiry, and capacity

[ReleaseHistoryView](messaging.md#history-query-control) releases a view after paging
or cancellation. Local views release locally; HTTP views release through Core.
Release is idempotent and safe after invalidation; it never recreates a view or
releases an unrelated one. Authentication and Dataset/context refusals still apply.
All views have finite monotonic expiry. Ordinary commits do not invalidate them.
Expiry, release, or owner loss makes continuation report an explicit need to restart.

Core Restart expires HTTP views. A local view may survive that Restart while its
complete same-Dataset picture can resume; required rebuild invalidates it. SDK or
application restart, close, or disabling/losing required local history coverage
invalidates local views. Re-enabling coverage cannot revive them. Reset invalidates
both sources' views and old Dataset context. Unrelated coverage changes do not
invalidate a history view. Release remains bound to the original source throughout.

Bound active views, matching-reference counts, retained revisions, and allocation
receipts before proportional allocation. An over-limit first page reports
`resource_limit` without exposing a partial view or invalidating ready coverage.
Charge views and their retained data to aggregate capacity. Under pressure, expire
temporary history views and recheck whole-commit capacity before pausing otherwise
viable synchronization or refusing writes. Never evict retained source history or
silently truncate a query to fit. Exact schemas and error envelopes remain to be authored.

## Independent acceptance example

Use one Entity and original source, with position readings P1 and P3 at revision 0,
observed at `2026-10-21T12:00:01Z` and `2026-10-21T12:00:03Z`. Labels abbreviate
UUIDs. Both HTTP and ready local queries at the same baseline must yield these results.

| Action | Required result |
| --- | --- |
| Open a known-time query at cursor C with page size 1 | P1 revision 0; view freezes P1 and P3 revision 0 at C |
| Lose that reply and retry its exact allocation context | Same view and expiry, not another allocation |
| Admit historical P2 at `12:00:02Z`, then correct P3 to revision 1 | New history changes; current sections still follow [evidence admission](report-evidence.md) |
| Continue the original query | P3 revision 0, then complete; P2 is absent |
| Open a fresh query after both changes | P1 revision 0, P2 revision 0, P3 revision 1 |
| Release the original view twice, then continue it | Both releases are safe; continuation requires restart |

For exact ordering in one scope, P9 at `.0000001Z` precedes P1 at `.0000002Z`.
Equal instants `.1Z` and `.100Z` use the identity tie-break and retain both spellings.
Unknown/uncertain readings remain in their separate group. Repeat with a Track's
mixed sources sharing a constituent ID: their different scopes remain distinct.
These are independent expected outcomes, not claims of executed runtime tests.

[Movement history](movement-history.md)
