# Database worker

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**One bounded Node.js worker owns Core's SQLite connections, transactions, and
checkpoints.** HTTP and WSS handling stay on the server thread. Domain modules
keep their private SQL and run complete stateful operations through this owner.
The same supported-format constant gates ordinary Store opening and the target
image's read-only update check. That check opens no Engine or writable connection.

## Operations and shutdown

Dispatch a complete domain operation with validated original facts, not individual
SQL statements from concurrent callers. Related owners share the operation's
[commit boundary](../shared/storage.md#one-commit-boundary). Do not hold a write transaction
across network or file waits. Recheck authority, Dataset, and revisions before commit.

Bound queued operation counts and bytes before copying arguments. Exhaustion refuses
unadmitted work with `resource_limit`. Reserve admission for required terminal/control
effects and keep inspection and stop reachable. A cancelled or lost caller wait does
not undo a commit or establish that an operation failed. Reconcile original retry facts.
Charge request copies separately from response permits. Reserve complete page bounds
before allocation, then charge actual reply bytes and copies until receipt acknowledgment.
Counts are bounded by the operation queue. The response budget is at least four pages,
with one page and required operation slots kept free from ordinary replies.
Tiny internal replies reserve 4 KiB rather than a page. Capture construction, cleanup,
and storage expiry waits hold no response permit and do not block reporting.

Worker failure stops new database admission and makes Core unavailable under
[readiness rules](../support/readiness.md). Do not automatically replay in-flight operations
or restart the worker. Local administration owns explicit Core recovery.
Stop admission, finish or cancel owned work, close connections, and await verified
worker exit before deleting storage. Unverified exit blocks destructive cleanup.

## Driver and durability

Use `better-sqlite3` with prepared SQL. Select and lock a supported driver version,
its embedded SQLite build, and the release container during implementation.
Record the actual engine version, source ID, and compile options. Require a build
with the [WAL-reset fix](https://sqlite.org/wal.html#walreset); check withdrawn releases
too. The host's sqlite3 executable does not identify the embedded engine.

Set and read back WAL mode and `synchronous=FULL` on every writer. The driver's
[WAL default is NORMAL](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md#a-note-about-durability),
which does not meet this durability target. Qualify file and directory flushes
on healthy local Linux storage. Process-kill tests do not establish power-loss durability.

## Exact private encodings

Preserve Protocol's complete uint64 domain, exact nanosecond ordering, and original
timestamp spellings. SQLite INTEGER is signed 64-bit; native JavaScript numbers
and Date are not lossless storage for those domains. Use explicit exact encodings
and sortable keys. Preserve original retry facts separately from current images.

Use Protocol's pinned Unicode alias comparison with a database uniqueness constraint.
SQLite NOCASE is insufficient. Validate private row mappings without leaking SQL
or storage types into Protocol. Ordinary prepared queries are the initial access layer.

## Reads, captures, and checkpoints

The synchronization owner requests snapshot/history materialization through this
worker. Capture one consistent source view, bound its construction and read lifetime,
and end the source transaction before serving saved pages. Capture work yields in
bounded batches outside main write transactions so reporting can proceed. Disposable
capture files use batched SQLite transactions without durable per-row journals.
Reserve concurrent bytes and references before writing each batch. Charge source reads,
temporary files, captures, WAL, indexes, and unreclaimed files to aggregate budgets.

Fresh capture admission covers receipt facts, ownership, bounded saved outcomes,
and SQLite/WAL overhead before any insert. Metadata counts as disk use after commit;
Reads keeps pending file and outcome headroom across waits until the builder ends.
Durable file charges survive failed cleanup.
Failed outcome writes never skip iterator return, connection closure, or owned-file
cleanup. Maintenance reclaims expired receipts only after their builders finish,
including builders that failed before acquiring a file. Original, bookkeeping,
and cleanup failures remain visible together.
Each batch admits its new bytes and metadata write before charging quotas or writing.
Exact ready and failed retries bypass fresh storage admission. Maintenance prunes
expired receipts separately, so a refused allocation performs no cleanup writes.

The worker owns checkpoint scheduling and observes WAL bytes and checkpoint progress.
It keeps an exact replay-byte total in SQLite, updated with each append, whole-commit
prune, and Reset in the same transaction. Rollback restores the total and log together.
Startup reconstructs this derived total once from retained rows before serving,
including stores last written by a version without the total. Ordinary commits
inspect the oldest rows only until the byte and age bounds are satisfied.
Start with ordinary automatic/PASSIVE checkpoints; qualify concurrent capture work.
Long overlapping readers can prevent WAL reuse. `journal_size_limit` is not a hard
active-WAL ceiling. Keep blocking truncation off ordinary request paths.

Verify the real worker/driver/container with exact-domain values, retry races,
interrupted captures, disk pressure, shutdown, and the [retained workload](qualification/workload.md).
These are implementation gates, not claims of measured capacity.

[Next: lifecycle](../support/lifecycle.md)
