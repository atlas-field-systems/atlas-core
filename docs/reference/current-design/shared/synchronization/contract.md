# Synchronization contract

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

**Synchronize whole committed changes to one fixed picture.** It contains all
Assets, Tracks, Geofeatures, Tasks, and ready Object metadata, including inactive
Tracks. Observations and append-only [position history](../../entities/history/positions.md) use
explicit HTTP reads in both SDK modes. Object bytes, activity, and administration
also remain direct requests. No selectable coverage or live coverage change exists.

Concrete [envelopes](messages.md) and
[temporary allocation rules](../temporary-reads.md) define wire fields and bounds.

## Complete changes

A Core cursor is opaque and bound to Dataset and durable commit order. One data
message contains every picture effect of one commit: final resource images and
versioned deletions. Apply it atomically before advancing the cursor. Transport
segmentation does not authorize application-level fragments.
All picture data shares one applied cursor. Track images retain their current
values, source IDs, and provenance without local Observation records.

Commits with no picture effects may be skipped only with explicit ordered progress
through the same durable log. Progress does not fabricate resource changes.
History-only position admission can therefore advance progress without changing
an Entity image. Never reconstruct history by sampling this feed.

Versions prevent stale overwrites and resurrection. Identical duplicates are harmless;
conflicting copies are errors. Replay uses the same durable change log, fixed replay
boundary, and whole-commit pagination. Page continuation is not applied progress.
Prune only whole commits and expose the earliest recoverable cursor.

## Initial load and handoff

Capture an immutable, finitely lived snapshot at baseline N. Page it into private
staging, never a partly readable picture. Subscribe from N; Core acknowledges a
fixed handoff H, delivers ordered catch-up through H, then live commits. Do not run
an independent client replay stream that races the live feed.

Publish the picture only after complete staging and catch-up through H. New writes
do not move H. A subscription acknowledgment is not progress. A complete staged
picture can resume from its last complete cursor after disconnection; an incomplete
snapshot needs the same valid capture or a fresh rebuild.

## Lost replies and release

Snapshot allocation binds a stable load ID under the exact
[allocation context](../temporary-reads.md). Exact retries recover the same capture
and original expiry. Ended contexts cannot resurrect it.

`ReleaseSnapshot` and `snapshot_released` are authenticated and work before data
subscription. Release after paging or cancellation. Await acknowledgment or expiry
before allocating a replacement. A complete picture can become usable before release
acknowledgment. Captures do not pin replay or block ordinary writes indefinitely.

## Capacity and recovery

Negotiate [effective message limits](../message-limits.md) before loading. Core accounts for
future allowed commits and the largest retained picture batch. Reserve complete
batches. Increased requirements force recovery without partial application.

A slow client gets an explicit gap or connection closure and resumes from its last
complete cursor. Expired replay requires rebuilding; do not silently skip changes.
Capacity failure pauses picture maintenance until explicit retry or a relevant
capacity change. Never evict resources, split an atomic domain change, or allocate
replacement snapshots in a hot loop. Explicit HTTP Observation and history reads
remain separate requests, subject to their own authority and capacity checks.

Same-release Restart preserves complete cursors and retained replay but expires
temporary captures. Reset invalidates the Dataset, old pictures, pending submissions,
and cursors. A fresh Dataset must not inherit old requests or apparent freshness.
