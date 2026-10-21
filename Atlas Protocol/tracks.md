# Tracks and fusion

**A Track is Atlas's shared identity and current state for a target.**
The active fusion policy builds Tracks from [Observations](observations.md).
Assets publish Observation reports. They do not choose a shared Track identity or
overwrite its derived state directly.

## Ownership

Fusion decides which Observations belong to which Tracks and what derived state
each Track exposes. Core records Track IDs, associations, derived state, and source
provenance. Track descriptions remain authored metadata with their own edit revision.
Evidence updates do not overwrite those descriptions.

An association is distinct from an Observation's reported facts. Reassociating
evidence must not rewrite the publisher, original measurements, or source times.
Use the same Track contract for every policy. Clients do not run their own fusion.
The baseline has one active fusion authority for the Dataset.

## Default policy

Core includes a policy that creates one Track for each new Observation immediately.
It requires no separately installed fusion service. The Observation and Track have
separate IDs, with a retained association between them.

Creating the Observation, its Track, the association, retry result, and public
change batch is atomic. If the complete change cannot commit, reject creation.
A lost reply is an unknown outcome. An exact retry recovers the existing pair.
Concurrent retries cannot allocate another Track for that Observation.

Commit admitted evidence and any current Observation/Track changes together.
The Track mirrors its Observation's applicable section results, including errors,
withdrawals, unknown values, classification, and original quantity times. It retains
[Telemetry constituent identities and revisions](components/telemetry.md#constituent-observation-identity)
under their original source scope. Follow [evidence admission](report-evidence.md)
for history-only reports, historical corrections, and replays. Their retained history
does not replace current Observation or Track sections.

Two publishers reporting the same vehicle initially produce two Observations and
two Tracks. This policy does not match targets across publishers, average positions,
or infer motion between reports. It leaves that work to a later policy.

## Evidence and lifetime

Track state identifies its contributing Observations and original evidence. Fusion
processing time and Core receipt time cannot stand in for source measurement time.
Keep derived results distinguishable from source facts. A derived update alone must
not fabricate a new movement sample from an unchanged reported measurement.

Tracks are retained data records with no individual deletion or automatic expiry.
A Track with no active Observations keeps its ID, last-known state, history, and
historical associations. Unknown or time-uncertain evidence stays so. Command-specific
age rules still apply when using a Track. Silence does not prove the target disappeared.

Tasks reference the shared Track ID. Policy changes must not silently retarget
accepted Tasks. Object associations and original source evidence remain attributable
even when Track state is derived from them. Retain these records until a deliberate
Reset ends the Dataset.

## Replacement policies

More capable fusion can be developed as a separate project. It can associate
multiple Observations with one Track while using the same public resource model.
It can match a new Observation to a retained Track that has no active Observations.
The default policy does not perform that match for a newly created Observation.
The built-in policy and a replacement must not compete over the same associations.
Changing authority is explicit. Failure does not authorize automatic fallback.

External policy messages, activation and handover, association revisions, conflict
resolution, merge and split behavior, and recovery require a later contract.
Those capabilities are not promised by the initial one-to-one implementation.

[Next: identity](identity.md)
