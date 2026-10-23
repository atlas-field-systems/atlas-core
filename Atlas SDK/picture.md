# The local operational picture

**One owner maintains the picture, applied Core cursor, local journal, and recovery.**
Only validated snapshots and complete feed commits enter it. HTTP write responses
and unrelated reads never become an alternate update path. The fixed picture
contains all Assets, Tracks, Geofeatures, Tasks, and ready Object metadata, including
inactive Tracks and provenance. Observations and position history use explicit HTTP.

## Readiness is explicit

Expose Dataset, generation, last applied Core cursor, last synchronized time, and
a safe error. States distinguish initializing, synchronized, recovering, disconnected,
resource-limited, authorization-required, and stopped. Not ready is not an empty Dataset.

A complete picture remains readable as explicitly stale during same-Dataset outages
and [known authorization failure](authorization.md). Known Reset or required rebuild
invalidates the picture immediately. Stage replacement privately; never display a
half-loaded replacement. Follow [Protocol handoff and recovery](../Atlas%20Protocol/synchronization.md).
SDK/application restart discards picture data and rebuilds from Core. No disk cache exists.

## Queries and subscriptions

Apply each entire commit before notifying anyone. One local journal position covers
one whole commit. Queries, changes, and subscriptions share that journal; local
cursors are not Core cursors. Prune whole batches, never partial commits. Track
reads retain source IDs and evidence without expanded Observation records. Clients
must not synthesize missing Tracks, rematch sources, or expire inactive records.
Observation reports can change Track images; their source records and positions
do not become cached feed items.

A subscription without a cursor starts atomically at the current local boundary;
it does not enumerate existing resources. A supplied cursor replays then joins live
updates without a gap. A slow subscriber whose history was pruned gets an explicit
gap and stops receiving data until recovery.

A full local query returns a coherent picture and its paired local cursor together.
Local page tokens bind instance, Dataset, generation, and query. Rebuild invalidates
them and affected local cursors. Ordinary Core tokens retain their own lifetime,
not the picture's.

During initial loading, emit status, not thousands of synthetic create events.
Successful replacement establishes a new picture generation and journal baseline.
Old cursors become invalid; subscriptions observe recovery and new readiness.
Reset additionally reports Dataset change. Do not present a rebuild as continuous
incremental history.

## Explicit history reads

[History queries](../Atlas%20Protocol/history-queries.md) always allocate frozen
HTTP views in Core, in either SDK mode. Continuation and release retain that Core-run
owner, original query facts, and finite expiry. SDK does not freeze local history
references or reconstruct positions from current images. A token never switches
source or silently allocates a replacement to hide expiry. Recheck authority and
view validity after waits. Downloaded application copies do not refresh a remote view.

## Capacity and retry

Initial configurable defaults are 512 MiB and 100,000 picture images, plus a
16 MiB/10,000-commit journal. All picture allocations share the 512 MiB budget,
including reserved updates. Check negotiated complete-message limits before allocation.
Account for the old picture, new staging, indexes, decoded values, journal, and local
query data together. Bound explicit HTTP history pages under ordinary response limits;
Core owns their separate finite view/reference budgets. No retained history cache
or local history-view budget exists.

Stop with explicit capacity state rather than evicting resources or repeatedly
rebuilding. A capacity failure cannot expose partially applied changes as current.
Report affected subscription gaps. Explicit retry or a relevant capacity change
restarts one recovery owner. No silent HTTP fallback substitutes for picture reads.

An ordinary network outage resumes from the last complete applied cursor when
Protocol permits it. Expired replay requires replacement. Incomplete captures,
complete staging, and a published picture are different recovery states; do not
restart every case from zero or reuse an expired allocation context.
Fetch a fresh Core allocation context immediately before each new remote allocation.
Exact allocation retries retain their original context and identity.

Closing SDK stops its connections and recovery and invalidates its local tokens.
Release remote captures/views while authority permits; absent acknowledgment, retain
only bounded facts needed to respect original expiry. Close cannot prove remote
release. Core and physical work continue under their own owners.

[Next: diagnostics](diagnostics.md)
