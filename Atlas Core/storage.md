# Storage and commits

**An accepted change must survive, and its related facts must agree.**
One SQLite database holds operational and installation-lifetime tables. Core is
its exclusive writer; the host manager does not edit live SQL behind its back.
Core stores accepted Asset and Observation sections with their source and ordering
facts. Track results and associations remain distinct from that source evidence.
Public resource images are built from these committed facts.

## One commit boundary

Under one transaction, recheck authorization, Dataset, revisions, retry identity,
and reference guards. Commit resource changes, original retry facts, required
history/activity, and the complete public change batch together. Movement additions
and corrections enter that batch even when current Entity state is unchanged.
A rollback publishes nothing. Return success after commit, not after feed delivery.
The [default fusion commit](fusion.md#the-default-commit-path) includes both the
Observation and Track. Unique associations and retry records prevent a second pair.

A retry distinguishes first execution, exact replay, conflicting facts, and an ended
identity. Compare original submitted facts, not the resource's later edited state.
Preserve Dataset-scoped records across Restart and clear them on Reset.

Bound the complete resulting resource images and combined batch before accepting
growth. Leave room for later cancellation and terminal reports. Small individual
requests must not accumulate into an unrepresentable Task or queue. Do not solve
capacity by dropping accepted declarations or splitting atomic effects.

## Snapshot captures

Core's synchronization owner materializes the requested current-resource and optional
movement-history coverage, with its baseline cursor, into temporary SQLite-backed
captures from one consistent database view. Expose only complete captures for their
declared coverage. End the source read transaction before serving saved pages.
The same owner handles allocation, release, expiry, and failed-build cleanup under
the [synchronization contract](../Atlas%20Protocol/synchronization.md).
The same owner projects committed batches to each client's coverage. A coverage
change never creates another source of truth or extends replay retention indefinitely.

HTTP [history queries](../Atlas%20Protocol/history-queries.md) reuse this capture owner
and its allocation/retry/cleanup discipline. Freeze matching reading revisions and
provenance from one consistent view; end the read transaction before serving pages.
The owner bounds active views and membership references before allocation, owns
finite expiry and explicit release, and invalidates Core-run views on Restart.

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

Object holds, accepted report identities, correction bindings, movement, and terminal
work accumulate until Reset. Bounded replay is not a bound on the entire Dataset.
Observations, Tracks, and their historical associations are retained records with
no individual delete or automatic eviction. Inactivity does not release their storage.
Charge uploads, active downloads awaiting reclamation, Plugin work, logs, database
and indexes, snapshot staging, history-query references, and frozen revisions against
real aggregate storage budgets. Under pressure, expire temporary history views and
recheck ordinary write admission before refusing it. Release only view allocations,
never retained source evidence or corrections.

Reserve headroom for required commits and failure reporting. Object quota alone
cannot isolate a Plugin that fills the disk. Refuse admission honestly; never
silently evict protected facts. Disk isolation is a qualification gate, not an
already implemented guarantee.

## History and activity

Movement is sparse accepted evidence, not a sampled copy of the current picture.
Activity records selected Task, Asset deletion, Plugin, credential, and configuration
actions with credential attribution. It is not a log of every packet or read and
must not contain secrets. Same-effect retries do not duplicate activity.

Stopped-state local actions use the [manager activity journal](manager-recovery.md#local-activity-journal).
Core imports before serving and through private maintenance calls while running.
Event identity and outcomes stay separate from
destructive authority. Reset clears pre-boundary activity; damage blocks import.

[Next: lifecycle](lifecycle.md)
