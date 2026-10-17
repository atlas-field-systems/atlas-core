# Storage and commits

**An accepted change must survive, and its related facts must agree.**
One SQLite database holds operational and installation-lifetime tables. Core is
its exclusive writer; the host manager does not edit live SQL behind its back.
Core stores accepted Asset sections with their source and ordering facts. It
builds the public Asset JSON from those values.

## One commit boundary

Under one transaction, recheck authorization, Dataset, revisions, retry identity,
and reference guards. Commit resource changes, original retry facts, required
history/activity, and the complete public change batch together. A rollback publishes
nothing. Return success after commit, not after a client receives the change feed.

A retry distinguishes first execution, exact replay, conflicting facts, and an ended
identity. Compare original submitted facts, not the resource's later edited state.
Preserve Dataset-scoped records across Restart and clear them on Reset.

Bound the complete resulting resource images and combined batch before accepting
growth. Leave room for later cancellation and terminal reports. Small individual
requests must not accumulate into an unrepresentable Task or queue. Do not solve
capacity by dropping accepted declarations or splitting atomic effects.

## Publishing files

Stream into an attempt-owned private staging file without holding a SQL transaction.
Verify length and digest; flush bytes, install without overwrite, and flush the
parent directory. Then take a short transaction, recheck current authority and
Dataset, and commit ready metadata, retry result, and public change together.
Only then acknowledge publication.

The initial durability target is healthy local Linux storage with same-filesystem
staging, supported flush semantics, and SQLite WAL with `synchronous=FULL` on every
writer. Power-loss durability requires an actual qualification test.

After interruption, clean only proven-owned abandoned attempts. Never delete a
committed, active, or ambiguously owned file. File presence alone is not publication.
Allow a fresh attempt without restarting Core. Metadata/file disagreement is an
explicit per-Object fault, not permission to fabricate bytes or erase evidence.

## Retention and capacity

Object holds, accepted report identities, correction bindings, movement, and terminal
work accumulate until Reset. Bounded replay is not a bound on the entire Dataset.
Charge uploads, active downloads awaiting reclamation, Plugin work, logs, database
and indexes, and snapshot staging against real aggregate storage budgets.

Reserve headroom for required commits and failure reporting. Object quota alone
cannot isolate a Plugin that fills the disk. Refuse admission honestly; never
silently evict protected facts. Disk isolation is a qualification gate, not an
already implemented guarantee.

## History and activity

Movement is sparse accepted evidence, not a sampled copy of the current picture.
Activity records selected Task, Asset deletion, Plugin, credential, and configuration
actions with credential attribution. It is not a log of every packet or read and
must not contain secrets. Same-effect retries do not duplicate activity.

Stopped-state local actions need a durable journal imported once by Core before
serving. Keep its event identity and outcomes separate from destructive management
authority. Reset clears pre-boundary activity; a damaged journal is not an empty
successful import. Its exact durability format remains unspecified.

[Next: lifecycle](lifecycle.md)
