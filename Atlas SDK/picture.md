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

A local query captures one complete picture boundary and its paired local cursor.
Every page uses that frozen selection and ordering, including images later changed
or deleted. Each page returns the same cursor and capture time, with current
readiness status. Live commits keep advancing the picture independently.

Retain immutable selected images for a finite configured monotonic lifetime. Charge
all retained query data to the shared picture budget before allocating or copying;
refuse a new query explicitly when it cannot fit. Release or expiry frees its data.
Tokens bind instance, Dataset, generation, original query and captured boundary.
Rebuild, Reset and SDK close invalidate them; authorization loss alone does not.
An expired or invalid token fails explicitly. It never switches to a newer boundary
or starts another query. Callers deliberately open a new query when needed.

A frozen query does not pin journal retention. If its cursor is too old for a later
subscription or changed-since read, report the normal gap. Ordinary Core tokens
retain their own lifetime, independent of these local query tokens.

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
Duplicate-commit fingerprints have the journal's count and byte limits. An older
unverifiable frame requires recovery; it cannot overwrite the current boundary.

Stop with explicit capacity state rather than evicting resources or repeatedly
rebuilding. A capacity failure cannot expose partially applied changes as current.
Report affected subscription gaps. Explicit retry or a relevant capacity change
restarts one recovery owner. No silent HTTP fallback substitutes for picture reads.

An ordinary network outage resumes from the last complete applied cursor when
Protocol permits it. Expired replay requires replacement. Incomplete captures,
complete staging, and a published picture are different recovery states; do not
restart every case from zero or reuse an expired allocation context.
Transient feed-queue pressure drains the bounded admitted prefix before reconnecting
from its last complete cursor. It preserves the published picture and generation;
exhausting the shared picture budget still requires explicit retry.
An individual frame that cannot fit the ingress queue also pauses maintenance
until explicit retry.
Fetch a fresh Core allocation context immediately before each new remote allocation.
Exact allocation retries retain their original context and identity.

Recovery retains one retiring socket until physical closure is confirmed before
opening another. Feed end and a close deadline do not confirm transport closure.
Closing or authorization supersession interrupts recovery's wait. Bounded shutdown
reports unconfirmed closure as a cleanup failure; later closure does not erase it.
Shutdown cancels queued recovery before it acquires transport ownership; cancelling
that pending start is not a cleanup failure.

Closing SDK invalidates local tokens and releases remote captures/views while authority
permits. Without acknowledgment, retain bounded facts that respect original expiry.
Close cannot prove remote release. Core and physical work continue under their owners.

[Next: diagnostics](diagnostics.md)
