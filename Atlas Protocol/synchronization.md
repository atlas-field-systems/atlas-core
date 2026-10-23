# Synchronization contract

**Synchronize committed facts, not delivery guesses.** The base picture contains
all Assets, Tracks, Geofeatures, Tasks, and ready Object metadata, including retained
inactive Tracks. Observation records and [movement history](movement-history.md)
are independent, opt-in additions, disabled by default. Each enabled addition covers
all retained data of that kind in the Dataset; it has no implicit time window or
per-Entity selection. Object bytes, activity, Plugin Operations, and administration
remain direct requests.

Concrete [envelopes](synchronization-messages.md), [coverage controls](coverage-changes.md),
and [temporary allocation rules](temporary-reads.md) define the wire fields and bounds.

## Complete changes

A Core cursor is opaque and bound to Dataset and durable commit order. Snapshots,
replay, and subscriptions bind their declared coverage. One data message contains
all effects of one commit within that coverage: final resource images, versioned
deletions, and selected history changes. Apply it atomically before advancing the cursor.
Transport segmentation does not authorize application-level fragments.
All ready coverage shares one applied cursor. When Observations are enabled, their
changes and default Track changes arrive together. When disabled, Track images
still contain their current values, source IDs, and provenance without requiring
local Observation records. Omitting unselected data never splits a selected effect.

Commits with no selected effects may be skipped only with explicit ordered progress
through the same durable log. Progress does not fabricate resource changes. Expanding
coverage requires loading it; a cursor for narrower coverage cannot prove it complete.

Versions prevent stale overwrites and resurrection. Identical duplicates are harmless;
conflicting copies are errors. Replay uses the same durable change log, fixed replay
boundary, and whole-commit pagination. Page continuation is not applied progress.
Prune only whole commits and expose the earliest recoverable cursor.

## Initial load and handoff

Capture an immutable, finitely lived snapshot at baseline N. Page it into private
staging, never a partly readable picture. Subscribe from N; Core acknowledges a
fixed handoff H, delivers ordered catch-up through H, then live commits. Do not run
a competing client replay stream that races the live feed.

Publish the picture only after complete staging and catch-up through H. New writes
do not move H. A subscription acknowledgment is not progress. A complete staged
picture can resume from its last complete cursor after disconnection; an incomplete
snapshot needs the same valid capture or a fresh rebuild.

## Changing coverage

Load an optional addition with the same snapshot and replay rules while the existing
ready picture remains usable and continues updating. At the
[coverage-change barrier](coverage-changes.md), finish catch-up and atomically join
it to the active projection.
Bound buffering and any cutover wait. If alignment cannot finish within those bounds,
leave existing coverage running and report the addition's failure. Do not publish
an addition at a different cursor or silently miss changes during the switch.
Initial base readiness also does not wait for optional additions to finish loading.

Expose readiness separately for base, Observations, and movement history. Loading,
disabled, and failed coverage are not empty results. Reads of an enabled but unready
addition report unavailable coverage; they do not silently fall back to HTTP.
With the addition disabled, explicit on-demand requests remain available.

Disabling an addition stops its maintenance and releases its local data at a complete
boundary. Cancel or release its pending load and invalidate its local query cursors;
late replies cannot re-enable it. Core retention and other coverage are unaffected.
Re-enabling performs a fresh load. SDK persistence and local cursor lifetimes belong
to the SDK contract, not the Core cursor.

## Lost replies and release

Snapshot allocation binds coverage and a stable load ID under the exact
[allocation context](temporary-reads.md). Exact retries recover the same capture
and original expiry. Ended contexts cannot resurrect it.

`ReleaseSnapshot` and `snapshot_released` are authenticated and work before data
subscription. Release after paging or cancellation. Await acknowledgment or expiry
before allocating a replacement. A complete picture can become usable before release
acknowledgment. Captures do not pin replay or block ordinary writes indefinitely.

## Capacity and recovery

Negotiate coverage and [effective message limits](limits.md) before loading.
Core accounts for future allowed commits and the largest retained projected batch.
Reserve complete batches. Increased requirements force recovery without partial application.

A slow client gets an explicit gap or connection closure and resumes from its last
complete cursor. Expired replay requires rebuilding; do not silently skip changes.
Capacity failure pauses affected coverage until explicit retry or a relevant capacity
change. If an active optional addition fails, withdraw its ready coverage at the last
complete applied boundary and resume the narrower projection from that cursor.
Never advance past unapplied effects still selected by the narrower projection.
Keep the addition requested but unavailable; do not silently disable it or use HTTP.
Optional loading reserves capacity without consuming the running base picture's
budget. Never evict part of declared coverage, split an atomic domain change, or
allocate replacement snapshots in a hot loop.

Same-release Restart preserves complete cursors and retained replay but expires
temporary captures. Reset invalidates the Dataset, old pictures, pending submissions,
and cursors. A fresh Dataset must not inherit old requests or apparent freshness.
