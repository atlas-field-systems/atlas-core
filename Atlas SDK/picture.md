# The local operational picture

**One owner maintains the picture, applied Core cursor, local journal, and recovery.**
Only validated snapshots and complete feed commits enter it. HTTP write responses
and unrelated reads never become an alternate update path.

That owner also maintains the canonical Asset location reading collection and
minimal deletion tombstones. It resolves sync references into immutable expanded
Asset views before exposure. Public reads never require callers to join collections.
Validate reference ownership, kind, and revision under
[Protocol synchronization](../Atlas%20Protocol/synchronization.md#complete-changes).
Failure leaves the picture, cursor, and journal unchanged and starts explicit recovery.

## Readiness is explicit

Expose Dataset, picture generation, coverage, last applied Core cursor, last
synchronized time, and a safe error. States distinguish initializing, synchronized,
recovering, disconnected, resource-limited, authorization-required, and stopped.
Not ready is not an empty Dataset.

A complete picture can remain readable as explicitly stale while disconnected from
the same Dataset. Once Reset or a required rebuild is known, invalidate its coverage
immediately. Stage replacement state privately; never display a half-loaded replacement.
Follow [Protocol handoff and recovery](../Atlas%20Protocol/synchronization.md).

## Queries and subscriptions

Apply each entire commit before notifying anyone. One local journal position covers
one whole commit. Queries, changes, and subscriptions share that journal; local
cursors are not Core cursors. Prune whole batches, never partial commits.
History-only changes use this journal and notify subscribers even without an Asset
image. Current reading corrections notify ordinary Asset subscribers through the
committed Asset version. Replayed commits produce no duplicate events.

A subscription without a cursor starts atomically at the current local boundary;
it does not enumerate existing resources. A supplied cursor replays then joins live
updates without a gap. A slow subscriber whose history was pruned gets an explicit
gap and stops receiving data until recovery.

A full local query returns a coherent picture and its paired local cursor together.
Local page tokens bind instance, Dataset, generation, and query. Rebuild invalidates
them. Ordinary Core paging tokens follow their own lifetime, not the replica's.

For [location history](../Atlas%20Protocol/location-history.md#bounded-history-queries),
the picture owner freezes matching immutable reading references with the paired
local cursor at the first page. Later pages use that view without coordinate
copies or Core requests. Views retain earlier immutable revisions by reference.
The owner bounds active views and reference counts before allocation, owns finite
expiry timers and release, and returns explicit restart for invalid continuations.
Recheck token authority after waits. Ordinary sync commits leave valid views usable.

During initial loading, emit status, not thousands of synthetic create events.
Successful replacement establishes a new picture generation and journal baseline.
Old cursors become invalid; existing subscriptions observe recovery and new readiness.
Reset additionally reports Dataset change. Do not pretend a rebuild was continuous
incremental history.

## Capacity and retry

Check negotiated complete-message limits before allocating a snapshot. Account for
old picture, new staging, readings, tombstones, indexes, decoded values, query
references and retained revisions, and journal together. Before a complete commit
fails capacity, expire optional history views and release their references, then
retry the whole check. Only then enter resource-limited if the commit still cannot
fit. Never evict canonical readings or fall back to HTTP. Stop without hot rebuilds.
Explicit retry or a relevant capacity change can restart one recovery owner.

An ordinary network outage resumes from the last complete applied cursor when
Protocol permits it. Expired replay requires replacement. Incomplete captures,
complete staging, and a published picture are different recovery states; do not
restart every case from zero or reuse an expired allocation context.

Authorization failure pauses until credentials change. Closing SDK stops its owned
connections and recovery, not Core, physical work, or accepted Plugin Operations.
Reset or rebuild releases local history views. Reset clears readings and tombstones
with the Dataset. Closing SDK also stops view timers and releases their references.

This completes the SDK reading path.
