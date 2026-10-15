# The local operational picture

**One owner maintains the picture, applied Core cursor, local journal, and recovery.**
Only validated snapshots and complete feed commits enter it. HTTP write responses
and unrelated reads never become an alternate update path.

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

A subscription without a cursor starts atomically at the current local boundary;
it does not enumerate existing resources. A supplied cursor replays then joins live
updates without a gap. A slow subscriber whose history was pruned gets an explicit
gap and stops receiving data until recovery.

A full local query returns a coherent picture and its paired local cursor together.
Local page tokens bind instance, Dataset, generation, and query. Rebuild invalidates
them. Ordinary Core paging tokens follow their own lifetime, not the replica's.

During initial loading, emit status, not thousands of synthetic create events.
Successful replacement establishes a new picture generation and journal baseline.
Old cursors become invalid; existing subscriptions observe recovery and new readiness.
Reset additionally reports Dataset change. Do not pretend a rebuild was continuous
incremental history.

## Capacity and retry

Check negotiated complete-message limits before allocating a snapshot. Account for
old picture, new staging, indexes, decoded values, and journal together. Stop with
an explicit capacity state rather than evicting resources or repeatedly rebuilding.
Explicit retry or a relevant capacity change can restart one recovery owner.

An ordinary network outage resumes from the last complete applied cursor when
Protocol permits it. Expired replay requires replacement. Incomplete captures,
complete staging, and a published picture are different recovery states; do not
restart every case from zero or reuse an expired allocation context.

Authorization failure pauses until credentials change. Closing SDK stops its owned
connections and recovery, not Core, physical work, or accepted Plugin Operations.

This completes the SDK reading path.
