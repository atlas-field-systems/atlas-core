# Diagnostics and logging

Diagnostics explain traffic, delay, and failure. Required evidence follows
[durable storage rules](storage.md); missing logs never prove no effect or authorize reruns.

## Structured events

Core and local commands emit structured JSON lines with UTC time, severity, stable event
name, component, and release. Add relevant Dataset, run, action, and resource context.
Preserve IDs/cursors exactly, encode 64-bit counters as decimal strings, and use monotonic durations.

HTTP records link the IDs from [Wire correlation](../Atlas%20Protocol/wire.md#http-correlation).
Record cursors after commit. Database outcome, reply delivery, client apply, and execution
stay distinct. An open channel does not verify process identity.

Allowlist before normal retention: route templates, safe codes, counts, and durations.
Exclude credentials, bodies, raw URLs, coordinates, operational/payload filenames,
SQL, configuration values, and arbitrary error text. Exports use the subset below.
Credential attribution stays separate from Asset/publisher identity. Apply the same
allowlist to local command output; raw exception text is not a diagnostic field.

| Owner | Events and aggregate measurements |
| --- | --- |
| HTTP | Route, outcome, elapsed time, observed body bytes, validation refusal, response-write failure |
| Reporting | Accepted, duplicate, and rejected evidence; fresh contact separately from acceptance |
| SQLite | Writer wait, transaction and commit duration, rollback, busy and storage faults, checkpoint delay |
| Objects | Receive, verify, flush, install, publish, and reclaim phases; transfer bytes and staged storage |
| Synchronization | Capture build, release and expiry; replay, handoff, gaps, buffer pressure, slow-client closure |
| Local command | Startup, observed process exit, verified writer exit, Reset phase, explicit recovery, cleanup failure |

## Detail and resource bounds

Default INFO records each non-report HTTP completion, including reads, with available
attempt/request IDs, route, status, and elapsed time. Mutations also record first
execution/exact replay and the committed cursor when present. State changes and
30-second summaries are separate. Asset updates and Observation reports use INFO counts and
DEBUG attempts. Failed reply delivery stays separate.

`diagnosticLevel` in the complete Settings JSON selects the minimum severity.
Keep `INFO` for individual reads and mutations; use `WARN` or `ERROR` to suppress
routine records, or `DEBUG` for rate-limited detail. Save with
`settings save --expected-revision N --file FILE`, then `settings apply --restart`
under [local administration](lifecycle.md#commands). WARN marks actionable degradation;
ERROR marks failed work or a broken invariant.

Metrics use fixed operation, route, outcome, and reason groups, never resource IDs.
The process owns and stops timers/queues. Diagnostics run outside transactions
and never control readiness or retries.

Initial limits: 8 KiB/event, 1 MiB queued output/process, and 100 DEBUG events/second/process.
Bound before copying/serialization; mark omitted oversized details. Full queues drop
diagnostics, never required evidence. Local inspection exposes collection health and known
dropped/suppressed counts without recursive logging. Downstream loss may be uncounted;
diagnostics do not promise a complete record.

## Safe fault context

Atlas-owned error paths add safe codes and bounded source-code frames: module-relative
files, functions, and line numbers, never absolute host paths, URL query/fragment values,
arguments, locals, or arbitrary exception values. Authentication and TLS remain unchanged.
Keep this context within event and queue bounds. If a fatal error cannot emit a safe
event, expose that the evidence is unavailable. Do not infer successful work from silence.
Unstructured stdout/stderr, runtime/dependency output, and memory dumps are not retained.
There is no raw-capture mode or sensitive export path. Some fatal failures may have no details.
Worker cleanup failures carry only validated public errors for the primary and cleanup
causes. HTTP and WSS keep the primary Protocol error and record both safe codes in
Core's owned sink.

## Collection and lifetime

Core writes allowlisted structured events directly to its owned rotating files.
It owns its queue, timers, file handles, and shutdown drain. Disable Docker logging
and unmanaged crash files; discard unstructured output at launch. No collector or
launcher process retains another copy. Local commands send safe progress and failure
output to the caller, without a retained stopped-state log or later import into Core.

Normal logs use eight rotating files within half the configured diagnostic budget.
The database worker reserves each log write and the potential export size against
aggregate ordinary capacity before writing. Writers release reservations after their
files close or writes finish. A refused release remains owned, with bounded retries
under worker queue pressure and another attempt before later writes or shutdown.
Shutdown reports any unresolved release while the worker is still owned.
Refused log reservations drop events without rejecting domain work or readiness.
Export refusal creates no output. An interrupted live export keeps its reservation
until Restart; the installation lock prevents concurrent exports.
The remaining half bounds a concurrent export. `diagnosticBytes` caps their total at 256 MiB. Include
transient buffers in [aggregate capacity](storage.md#retention-and-capacity). Target eight hours
of default-detail history, including a four-hour mission; age is not a hard expiry.
Expose retained ranges/gaps. Disk bounds and retention
need [qualification](qualification.md); event limits alone are not proof.

[Lifecycle](lifecycle.md#reset-recovery) owns Restart, Reset, and interrupted-command recovery.
Restart retains bounded files. Each export command owns staging and holds the installation lock.
Reset verifies Core and export writers stopped before clearing Atlas-owned logs and staging.
Unverified cleanup leaves Reset incomplete and preserves its recovery record.
No detached cleanup, Docker-owned file edits, or unrelated host-log removal is permitted.

Local administration exports a bounded bundle with versions, Dataset/run context, and known gaps.
Configuration includes only the severity threshold and numeric diagnostic limits;
paths, destinations, and other values remain excluded. Report partial/failed exports.
Exports never upload automatically. User-owned exports survive Reset.

[Next: qualification](qualification.md)
