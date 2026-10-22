# Fusion ownership

**Core ships with the one-to-one policy defined by [Protocol](../Atlas%20Protocol/tracks.md).**
Keep that policy behind a small internal interface. Core owns persistence and
publication. The policy owns association decisions and derived Track state.
The initial implementation needs no Plugin, separate process, or generic pipeline.

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
original report identities, source times, and corrections with their Dataset.
Startup and retries reuse existing identities rather than regenerating Tracks.
The same owner retains inactive records until Reset. No deletion timer is needed.

## The replacement boundary

Fusion is replaceable without changing the public Observation and Track meanings.
A specialized implementation can live in its own project, potentially as a
[Plugin](plugins.md). It uses supported contracts rather than Core's SQL or files.
Core remains the only database writer and public change publisher.

A replacement determines associations and derived values. Core owns Track IDs,
validates provenance and current authority, and commits accepted decisions.
Check the active authority again at commit after any external wait. A credential
or Plugin installation alone does not select the active fusion authority.

The external input/output messages, processing lifetime, admission when unavailable,
activation and handover, and recovery require a separate design before replacement
is supported. Do not stretch finite Plugin Operations into an implicit stream owner.
Keep the built-in policy active initially. A replacement fault must not silently
start a competing policy or manufacture new one-to-one associations.

## Storage and capacity

Keep Observation reports separate from derived Track results. Record which source
evidence produced Track state. Historical associations remain queryable when no
source is active. Recomputing state must not append the same movement evidence again.

Account for both Entity images, association data, retained report/correction identity,
history, indexes, and replay. Check the entire default commit, not just the incoming
Observation size. Storage exhaustion refuses new effects; it does not evict records.

[Next: diagnostics](diagnostics.md)
