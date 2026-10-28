# Storage and commits

**An accepted change must survive, and its related facts must agree.**
One SQLite database holds operational and installation-lifetime tables. Core is
its exclusive writer; local administration commands never edit live SQL.
The [database worker](database.md) owns connections, exact SQL encodings, and durability settings.
Core stores accepted Asset and Observation sections with their source and ordering
facts. Track results and associations remain distinct from that source evidence.
Public resource images are built from these committed facts.

## One commit boundary

Under one transaction, recheck authorization, Dataset, revisions, retry identity,
and reference guards. Commit resource changes, original retry facts, required
history/activity, and the complete public picture effects together. Newly admitted
positions commit even when current Entity state is unchanged; those commits carry
ordered log progress when they have no synchronized picture effects.
A rollback publishes nothing. Return success after commit, not after feed delivery.
The [default fusion commit](fusion.md#the-default-commit-path) includes both the
Observation and Track. Unique associations and retry records prevent a second pair.

A retry distinguishes first execution, exact replay, conflicting facts, and an ended
identity. Compare original submitted facts, not the resource's later edited state.
Preserve Dataset-scoped records across Restart and clear them on Reset.
An UpdateAsset wrapper around duplicate source evidence still binds its request ID
to the original facts. Charge its private receipt before commit; storage refusal
leaves that ID unbound. The receipt adds no picture or progress event, contact
refresh, position, or activity. Source report identity remains independent.

Bound the complete resulting resource images and combined batch before accepting
growth. Leave room for later cancellation and terminal reports. Small individual
requests must not accumulate into an unrepresentable Task or queue. Do not solve
capacity by dropping accepted declarations or splitting atomic effects.

## Snapshot captures

Core's synchronization owner materializes the fixed picture with its baseline
cursor into temporary SQLite-backed captures from one consistent database view.
Expose only complete captures. Observations and position history are absent from
picture captures. End the source read transaction before serving saved pages.
The same owner handles allocation, release, expiry, and failed-build cleanup under
the [synchronization contract](../Atlas%20Protocol/synchronization.md).
The same owner publishes complete picture effects from the durable commit log.
Captures never extend replay retention indefinitely.

HTTP [history queries](../Atlas%20Protocol/history-queries.md) reuse this capture owner
and its allocation/retry/cleanup discipline. Freeze immutable position references and
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

Staging and installed paths share a local filesystem with supported flush semantics.
Database durability and actual power-loss qualification follow the [worker contract](database.md#driver-and-durability).

After interruption, Core's Object owner cleans only proven-owned abandoned attempts
after verifying their writers have exited. Missing SQL references alone do not prove
abandonment. Never delete a committed, active, or ambiguously owned file. File presence
alone is not publication. Allow a fresh attempt without restarting Core. Metadata/file
disagreement is an explicit per-Object fault, not permission to fabricate bytes or
erase evidence.

## Retention and capacity

Object holds, accepted report identities, immutable positions, and terminal
work accumulate until Reset, as do compact [assigned-read receipts](task-reads.md).
Bounded replay is not a bound on the entire Dataset.
Observations, Tracks, and their historical associations are retained records with
no individual delete or automatic eviction. Inactivity does not release their storage.
Charge uploads, active downloads awaiting reclamation, logs, database and indexes,
snapshot staging, history-query references, and frozen data against
real aggregate storage budgets. Under pressure, expire temporary history views and
recheck ordinary write admission before refusing it. Release only view allocations,
never retained source evidence.

Reserve headroom for required commits and failure reporting. Object quota alone
does not bound aggregate disk use. Refuse admission honestly; never silently evict
protected facts. After permit or expiry waits, recheck authority and the current
byte delta, inspect capacity, and record the reservation in one synchronous step.
Upload descriptors and bounded SQLite/WAL overhead pass admission before persistence,
even without new binary bytes. Metadata then counts as actual disk use; unwritten
binary bytes stay reserved until written.

## History and activity

Position history is accepted source evidence, not a sampled current picture.
Activity records selected Task, Asset deletion, and credential actions with credential
attribution. Core records configuration it applies with explicit local-administrator
attribution. Activity is not a log of every packet or read and contains no secrets.
Same-effect retries do not duplicate activity. Reset clears pre-boundary activity.

Stopped-state local commands are outside public activity history. Their safe output
goes to the local caller. The [destructive recovery record](lifecycle.md#reset-recovery)
authorizes only the recorded maintenance work; it is not an activity journal.

[Next: database worker](database.md)
