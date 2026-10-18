# Storage and commits

**An accepted change must survive, and its related facts must agree.**
One SQLite database holds operational and installation-lifetime tables. Core is
its exclusive writer; the host manager does not edit live SQL behind its back.
Entities/reporting stores accepted sections with source and ordering facts.
It owns admission and [current selection](../Atlas%20Protocol/location-history.md#current-location).

## One commit boundary

Under one transaction, recheck authorization, Dataset, revisions, retry identity,
and reference guards. Commit resource changes, retry facts, required Asset readings,
Track movement, activity, and the complete public batch together. A rollback publishes nothing.
Return success after commit, not after a client receives the change feed.

A retry distinguishes first execution, exact replay, conflicting facts, and an ended
identity. Compare original submitted facts, not the resource's later edited state.
Preserve Dataset-scoped records across Restart and clear them on Reset.

Bound the complete resulting resource images and combined batch before accepting
growth. Leave room for later cancellation and terminal reports. Small individual
requests must not accumulate into an unrepresentable Task or queue. Do not solve
capacity by dropping accepted declarations or splitting atomic effects.

## Snapshot captures

Core's synchronization owner materializes immutable public resource images and
their baseline cursor into temporary SQLite-backed captures from one consistent
database view. Expose only complete captures and end the source read transaction
before serving pages. The owner handles allocation, release, expiry, and failed-build
cleanup under the [synchronization contract](../Atlas%20Protocol/synchronization.md).

Sync captures include readings, Asset tombstones, and current images at the same N.
HTTP history uses this owner's existing immutable
capture mechanism for bounded matching reading revisions and its coherent cursor.
The owner binds tokens to the capture/query, enforces finite leases and allocation
limits, and releases its revision references on expiry, release, or Reset. Reuse the
existing capture retry and cleanup discipline, not a second history service.

## Location storage

Entities/reporting owns one private reading collection with fixed kind, Asset,
original evidence binding, and accepted revision. A unique original-evidence key
deduplicates relayed and direct reports independently of section delivery.
Persist current references alongside other section values. Admission, corrections,
affected Asset versions, retry facts, and the final public batch share the transaction.
Historical-only writes still produce that batch. HTTP reads expand values from
one consistent database view.
Index history by Asset, time group, exact source instant, and reading ID. Preserve
original timestamp text separately from the exact comparison value.
Deletion stores a minimal versioned tombstone and keeps readings. Reset clears both.

## Publishing files

Core's Object owner gives each upload attempt distinct private staging and installed
paths. A retry never overwrites an earlier attempt's file.
Stream into an attempt-owned private staging file without holding a SQL transaction.
Verify length and digest; flush bytes, install without overwrite, and flush the
parent directory. Then take a short transaction, recheck current authority and
Dataset, and commit ready metadata, retry result, and public change together.
Only then acknowledge publication.

The initial durability target is healthy local Linux storage with same-filesystem
staging, supported flush semantics, and SQLite WAL with `synchronous=FULL` on every
writer. Power-loss durability requires an actual qualification test.

After interruption, Core's Object owner cleans only proven-owned abandoned attempts
after verifying their writers have exited. Missing SQL references alone do not prove
abandonment. Never delete a committed, active, or ambiguously owned file. File presence
alone is not publication. Allow a fresh attempt without restarting Core. Metadata/file
disagreement is an explicit per-Object fault, not permission to fabricate bytes or
erase evidence.

## Retention and capacity

Object holds, accepted report identities, correction bindings, Asset readings,
Track movement, tombstones, and terminal work accumulate until Reset.
Bounded replay is not a bound on the entire Dataset.
Charge uploads, active downloads awaiting reclamation, Plugin work, logs, database
and indexes, capture/query references and retained revisions, and snapshot staging
against real aggregate storage budgets. Expire optional history captures under
pressure and recheck admission before refusing ordinary writes.

Reserve headroom for required commits and failure reporting. Object quota alone
cannot isolate a Plugin that fills the disk. Refuse admission honestly; never
silently evict protected facts. Disk isolation is a qualification gate, not an
already implemented guarantee.

## Activity

Activity records selected Task, Asset deletion, Plugin, credential, and configuration
actions with credential attribution. It is not a log of every packet or read and
must not contain secrets. Same-effect retries do not duplicate activity.

Stopped-state local actions need a durable journal imported once by Core before
serving. Keep its event identity and outcomes separate from destructive management
authority. Reset clears pre-boundary activity; a damaged journal is not an empty
successful import. Its exact durability format remains unspecified.

[Next: lifecycle](lifecycle.md)
