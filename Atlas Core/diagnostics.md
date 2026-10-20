# Diagnostics and logging

Diagnostics explain traffic, delay, and failure without becoming recovery evidence.
Required activity, retry facts, Operation evidence, and management authority retain
their [durable storage rules](storage.md). Missing logs never prove no effect occurred.

## Events and fields

Core and the host manager use Go `slog` with line-delimited JSON. Each record has
UTC time, severity, a stable event name, component, and release. Add Dataset, Core
run, management action, resource, or verified Plugin runtime identity when relevant.
Preserve identifiers and opaque cursors exactly. Encode 64-bit counters as decimal
strings. Measure elapsed phases with monotonic clocks.

HTTP records link the IDs from [Wire correlation](../Atlas%20Protocol/wire.md#http-correlation).
Record a committed cursor only after commit. Keep database outcome, response
delivery, client application, and physical execution distinct. Plugin-supplied
identities do not establish verified runtime identity.

Allowlist fields at each producer before any retained copy. Use route templates,
safe error codes, counts, and phase durations. Exclude credentials, request and
response bodies, raw URLs, coordinates, filenames, SQL text, and arbitrary Plugin
error text. Exclude configuration values from logs. Exports permit only the subset
defined below. Keep credential attribution separate from the reported Asset or
publisher. Plugins apply the same exclusions to their own output.

## Coverage by owner

Each existing owner records its decisions and measures its work.

| Owner | Events and aggregate measurements |
| --- | --- |
| HTTP | Route, outcome, elapsed time, observed body bytes, validation refusal, response-write failure |
| Reporting | Accepted, duplicate, and rejected evidence; fresh contact separately from acceptance |
| SQLite | Writer wait, transaction and commit duration, rollback, busy and storage faults, checkpoint delay |
| Objects | Receive, verify, flush, install, publish, and reclaim phases; transfer bytes and staged storage |
| Synchronization | Capture build, release and expiry; replay, handoff, gaps, buffer pressure, slow-client closure |
| Plugins | Readiness, exposure, redelivery, accepted evidence, runtime-loss decision, receipt capacity, drain time |
| Host manager | Startup, observed process exit, action handoff, verified writer exit, Reset phase, cleanup failure |

The manager records observed crashes that Core cannot report itself. Records
describe observations, not inferred execution or automatic permission to rerun work.

## Detail and resource bounds

Default INFO output contains state transitions, active-work summaries every
30 seconds, and one correlated completion record per non-report mutation attempt.
Include attempt and Core request IDs, route, committed or refused outcome, and
first execution or exact replay disposition. Failed response delivery is separate.
Observation-only Asset and Track reports use counts at INFO and attempt detail at
DEBUG. Lost-reply correlation for those reports therefore needs DEBUG capture.
Normal field outages produce disconnect and recovery summaries. WARN marks an
actionable degraded condition; ERROR marks failed work or a broken invariant.
Coalesce repeated faults with counts. DEBUG adds rate-limited attempt details.

Counters and timing buckets use fixed operation, route, outcome, and reason
categories. Resource IDs and arbitrary strings are not metric grouping keys.
The process owns summary timers and its output queue; shutdown stops both.
Diagnostics run outside database transactions and do not control readiness or retries.

Initial limits are 8 KiB per event, 1 MiB queued output per process, and 100 DEBUG
events per second per process. Apply limits before copying or serializing values.
Oversized details are omitted with an explicit marker. Full queues drop diagnostics,
never required durable evidence. Expose collection health and known dropped or
suppressed counts through local inspection, without recursive logging on failure.
Downstream loss may be uncounted, so diagnostics never promise a complete record.

## Collection and lifetime

The host manager disables Docker logging for Core and Plugin containers. Before either
Go process starts, its launcher directs raw stdout/stderr to `/dev/null`, including
manager output under systemd. Disable additional crash-output files and dumps.
Fatal runtime output and dependency writes therefore have no persistent sink.
Set `http.Server.ErrorLog` to discard raw messages, including recovered-panic text.
HTTP recovery may emit a fixed safe event, without formatting the panic value or stack.

Core sends `slog` events over a private local diagnostic channel to a manager-owned
collector. The manager validates its own structured events before writing. A separate
manager collector bounds Plugin stdout/stderr before buffering or parsing. Every writer
uses the event and queue limits above and retains only validated, allowlisted records
in installation-owned rotated files. Drop unsafe or malformed output before storage.
Report known omissions. The manager records observed container exits using safe status
or signal metadata, never crash text. There is no journal, syslog, or raw-output mirror.
Restart reuses containers and retained events. No cloud collector is required.

Before launch, assign byte quotas to each container and the manager. Their sum,
including rotated copies, storage overhead, and export staging, is at most 256 MiB.
Rotate oldest records within each source's quota. Account for transient buffers
under [aggregate capacity](storage.md#retention-and-capacity). Target eight hours of
default-detail history, including a four-hour mission; age is not a hard expiry.
Expose retained ranges and known gaps. Actual retention and disk bounds require
[qualification](qualification.md); event limits alone are not disk proof.

[Lifecycle](lifecycle.md#reset-recovery) owns Restart and Reset semantics.
Reset cleanup covers managed container, Plugin, and manager diagnostic copies.
The action owner stops or completes exports, verifies container emitters have stopped,
and stops and drains collectors. It switches or closes every manager diagnostic writer
and verifies pending writes to old storage have drained before clearing old logs.
Raw stdout/stderr remain discarded throughout Reset.
Use supported per-installation storage or container lifecycle controls. Never edit
Docker-owned files or vacuum unrelated host logs. Failure to verify cleanup leaves
Reset incomplete. Durable management authority stays outside this cleanup.

Local administration can explicitly export a bounded diagnostic bundle before Reset.
Include versions, Dataset and run context, and known gaps. For configuration, include
only the diagnostic severity threshold and numeric diagnostic limits. Paths,
destinations, and all other configuration values remain excluded.
Report partial or failed exports. No upload or export is a Reset prerequisite.
A user-selected export is user-owned and is not erased by Atlas Reset.

[Next: qualification](qualification.md)
