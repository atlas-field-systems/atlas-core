# Synchronization contract

**Synchronize committed facts, not delivery guesses.** The picture contains all
Entities, Tasks, and ready Object metadata. Object bytes, history, Plugin Operations,
and administration use direct requests instead.

## Complete changes

A Core cursor is opaque and bound to Dataset and durable commit order. One data
message contains one complete commit: final resource images or versioned deletions.
Validate and apply the entire message atomically before advancing the cursor.
Transport segmentation does not authorize application-level fragments.

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

## Lost replies and release

Snapshot allocation has a stable load ID within a Dataset/Core-run context with
finite monotonic expiry. Exact retries recover the same capture and original expiry,
not another allocation. Changed facts conflict. Expired, released, or old-run
contexts cannot resurrect a capture, even after their retry records are pruned.

Explicit `release_snapshot` and `snapshot_released` controls are authenticated and
work before a data subscription. Release after all pages arrive or loading is
cancelled. Await acknowledgment or expiry before allocating a replacement; an
otherwise complete picture need not wait for release acknowledgment to become usable.

Captures do not pin replay forever. Bound captures, allocation receipts, and buffers.
Reject excess allocation without blocking ordinary operational writes.

## Capacity and recovery

Negotiate batch byte and change-count limits before loading. Core must account for
both future allowed commits and the largest retained replay message. Reserve room
for a whole batch. Increased requirements during a stream force explicit recovery,
not partial application. Control messages remain usable when data cannot fit.

A slow client gets an explicit gap or connection closure and resumes from its last
complete cursor. Expired replay requires rebuilding; do not silently skip changes.
Capacity failure pauses recovery until explicit retry or a relevant capacity change,
rather than allocating snapshots in a hot loop. Never evict part of the picture or
split an atomic domain change to fit a client limit.

Same-release Restart preserves complete cursors and retained replay but expires
temporary captures. Reset invalidates the Dataset, old pictures, pending submissions,
and cursors. A fresh Dataset must not inherit old requests or apparent freshness.

This completes the Protocol reading path.
