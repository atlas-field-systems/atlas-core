# The local operational picture

**One owner maintains the picture, applied Core cursor, local journal, and recovery.**
Only validated snapshots and complete feed commits enter it. HTTP write responses
and unrelated reads never become an alternate update path.
The base picture includes retained Tracks and source provenance, including inactive
records. Observation records and movement history are independent optional coverage
defined by [Protocol](../Atlas%20Protocol/synchronization.md).

## Readiness is explicit

Expose Dataset, generation, requested and ready coverage, last applied Core cursor,
last synchronized time, and a safe error. States distinguish initializing, synchronized,
recovering, disconnected, resource-limited, authorization-required, and stopped.
Each optional coverage also distinguishes disabled. Not ready is not an empty Dataset.

A complete picture can remain readable as explicitly stale while disconnected from
the same Dataset. Once Reset or a required rebuild is known, invalidate its coverage
immediately. Stage replacement state privately; never display a half-loaded replacement.
Follow [Protocol handoff and recovery](../Atlas%20Protocol/synchronization.md).

## Optional coverage

Enabling an option backfills all its retained records, then catches up and joins
the ready picture at a common complete commit boundary. The synchronization owner
stages this privately while existing ready coverage continues serving reads and
updates. Expose the option's progress and failure independently of base readiness.
Never roll back ready state or expose a partially loaded option. A failed addition
leaves previously ready coverage usable; explicit retry can try the addition again.

Disabling an option cancels its pending load, stops maintenance, invalidates its
coverage and query tokens, and releases its local data. Core retains the records.
Late pages or callbacks from the old load cannot repopulate disabled coverage.
Disabling Observations does not disable history, and neither changes Track results.

Both options start off unless configured. SDK/application restart discards all
cache data and rebuilds the selected coverage from Core; no disk cache is created.
The base picture can become ready before enabled optional coverage finishes loading.

## Queries and subscriptions

Apply each entire commit before notifying anyone. One local journal position covers
one whole commit. Queries, changes, and subscriptions share that journal; local
cursors are not Core cursors. Prune whole batches, never partial commits.
Apply every ready coverage's effects together: an enabled Observation, its default
Track, and enabled movement changes share the same committed boundary. Track reads
remain usable without locally expanded Observation records when that option is off.
Clients must not synthesize missing Tracks, rematch sources, or expire inactive records.

A subscription without a cursor starts atomically at the current local boundary;
it does not enumerate existing resources. A supplied cursor replays then joins live
updates without a gap. A slow subscriber whose history was pruned gets an explicit
gap and stops receiving data until recovery.

A full local query returns a coherent picture and its paired local cursor together.
Local page tokens bind instance, Dataset, generation, query, and required coverage.
Rebuild or a change to required coverage invalidates them and affected local cursors.
Ordinary Core paging tokens follow their own lifetime, not the replica's.

During initial loading, emit status, not thousands of synthetic create events.
Successful replacement establishes a new picture generation and journal baseline.
Old cursors become invalid; affected subscriptions observe recovery and new readiness.
Reset additionally reports Dataset change. Do not pretend a rebuild was continuous
incremental history.
An optional backfill likewise emits status and readiness, not synthetic create events.

## Capacity and retry

Check negotiated complete-message limits before allocating a snapshot. Account for
base and optional records, old picture, new staging, indexes, decoded values, and
journal together. Count history readings as well as Entity images. An optional load
must fit without consuming memory reserved for the ready picture's bounded updates.
Stop with an explicit capacity state rather than evicting resources or repeatedly rebuilding.
Explicit retry or a relevant capacity change can restart one recovery owner.
If an enabled option cannot continue within its bounds, mark that coverage unavailable
and stop serving it as current; release its allocations and let base coverage continue
when its own limits permit. Report affected subscription gaps. Never silently change
the requested options, truncate retained history, or switch those reads to HTTP.

An ordinary network outage resumes from the last complete applied cursor when
Protocol permits it. Expired replay requires replacement. Incomplete captures,
complete staging, and a published picture are different recovery states; do not
restart every case from zero or reuse an expired allocation context.

Authorization failure pauses until credentials change. Closing SDK stops its owned
connections and recovery, not Core, physical work, or accepted Plugin Operations.

[Next: diagnostics](diagnostics.md)
