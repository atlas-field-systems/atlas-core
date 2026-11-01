# Fusion ownership

**Core ships with the one-to-one policy defined by [Protocol](../Atlas%20Protocol/tracks.md).**
Keep that policy behind a small internal interface. Core owns persistence and
publication. The policy owns association decisions and derived Track state.
The initial implementation needs no separate process or generic pipeline.

`fuseOneToOne` returns source attribution and mirrored reported sections.
The Entities owner assembles Track identity, versions, and authored metadata.
The policy receives neither Track edit state nor persistence access.

## The default commit path

The Entities/reporting owner validates the publisher, Observation, report evidence,
complete sections, ordering, and current Dataset. It deduplicates evidence before
asking the policy for changes. Descriptive edits remain separate from derived state.

Supply the policy with the candidate Observation state, existing association, and
required source evidence. The built-in implementation returns the bounded Track
changes for that Observation. It performs no network calls or external work.
Core bounds candidate allocation and validates resulting resources and the combined
change batch before commit.

The Entities/reporting owner commits the accepted Observation facts, Track state,
association, retry result, required history, and complete public change together.
Core assigns the Track ID on first creation and retains its association. Private
storage constraints and the transaction prevent racing creates from allocating
two Tracks for one Observation. Rollback publishes neither side.

Reconstruct current views from committed state after Restart. Retain associations,
original report identities, immutable reading facts, and source times with their Dataset.
Startup and retries reuse existing identities rather than regenerating Tracks.
The same owner retains inactive records until Reset. No deletion timer is needed.

## The replacement boundary

Fusion is replaceable without changing the public Observation and Track meanings.
A specialized implementation can live in its own project once a replacement
contract exists. Independent integrations already use public HTTP with credentials,
without Core's SQL or files. Core remains the sole database writer and publisher.

A replacement determines associations and derived values. Core owns Track IDs,
validates provenance and current authority, and commits accepted decisions.
Check the active authority again at commit after any external wait. A credential
alone does not select the active fusion authority.

The external input/output messages, processing lifetime, admission when unavailable,
activation and handover, and recovery require a separate design before replacement
is supported. No initial private execution or generic dispatch contract is provided.
Keep the built-in policy active initially. A replacement fault must not silently
start a competing policy or manufacture new one-to-one associations.

## Storage and capacity

Keep Observation reports separate from derived Track results. Record which source
evidence produced Track state. Historical associations remain queryable when no
source is active. Recomputing state must not append the same movement evidence again.

Account for both Entity images, association data, retained report and reading identities,
history, indexes, and replay. Check the entire default commit, not just the incoming
Observation size. Storage exhaustion refuses new effects; it does not evict records.

[Next: diagnostics](diagnostics.md)
