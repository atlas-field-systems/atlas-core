# Tracks and fusion

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

A Track is Atlas's shared identity and current state for a target.
The active policy builds Tracks from [Observations](../observations/observations.md). Publishers
cannot select a shared Track ID or directly overwrite its derived state.

## Ownership

Fusion owns Observation associations and derived Track sections. Core owns Track
IDs, persistence, provenance, and publication. Authored Description and alias have
a separate edit revision. Evidence updates do not overwrite them.
Reassociation cannot rewrite a publisher, measurement, or original source time.
The Dataset initially has one built-in active fusion authority.

## Default policy

Create exactly one Track for each new Observation immediately, with distinct IDs
and a retained association. [Entity composition](../structure.md#component-composition)
defines all allowed fields. The Track's `sources` contains exactly the recorded
Observation ID, publisher ID, and source Asset attribution if supplied. It has no
independent Asset status, contact, power, camera, capabilities, or sensor metadata.

Mirror the Observation's `type` and every present `telemetry`, `attitude`, and
`geometry` result, including classifications, errors, withdrawals, unknown values,
and original quantity times. Initially absent optional sections stay absent.
A source-free unknown Type remains source-free. Description and alias are not copied.
Each sourced result's `evidence` references the original Observation report and section.
Telemetry constituent identities retain the original Dataset, Observation, publisher,
and quantity scope. Never substitute the Track ID or a fusion-processing identity.

Creating the Observation, Track, association, retry result, and public change batch
is one atomic commit. Failure rejects creation without allocating a visible pair.
An exact retry recovers the existing pair. Racing retries cannot create another Track.

[Evidence admission](../reporting/evidence.md) precedes mirroring. Commit newly admitted
positions and eligible current replacements with both Entity effects atomically.
A history-only report changes neither current image, section evidence reference,
nor association. It still appears in Track history
through the original scope. Exact replay adds no reading or repeated public effect.
Mirror each eligible current replacement as a complete result.

Two publishers reporting the same vehicle produce two Observations and two Tracks.
The initial policy performs no cross-publisher matching, averaging, extrapolation,
merging, splitting, or interpolation.

## Evidence and lifetime

Track reads expose source IDs and evidence even without expanded Observation
records. Position queries retain immutable reading facts and association provenance. They do not manufacture a second measurement identity.
Fusion time and receipt time never replace source measurement time.
Unchanged derived state cannot create a fresh movement sample.

Tracks have no individual deletion or automatic expiry. Silence preserves ID,
last-known state, history, and associations until Reset. There is no activity flag
or timeout. Unknown source age remains unknown. Silence does not prove disappearance.
Source Asset deletion preserves attribution, the Observation, and its Track.
Continued valid publisher reports update that same Track under [Observation rules](../observations/observations.md).

Tasks reference the shared Track ID. A later policy must not silently retarget
accepted Tasks. Source Objects remain associated with their Observations. Fusion
neither duplicates content nor rewrites Object metadata.

## Replacement policies

More capable fusion is a later project using the same public resource meanings.
External publication, activation, handover, association revisions, conflict resolution,
merge, split, and recovery contracts are unsupported initially. The built-in policy
remains the sole authority. Failure does not authorize a competing fallback.

[Next: identity](../../support/identity.md)
