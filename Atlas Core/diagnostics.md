# Diagnostics and logging

Diagnostics explain traffic, delay, and failure. Required evidence follows
[durable storage rules](storage.md); missing logs never prove no effect or authorize reruns.

## Structured events

Core and manager use Go `slog` JSON lines with UTC time, severity, stable event name, component,
and release. Add relevant Dataset, run, action, resource, and verified Plugin context.
Preserve IDs/cursors exactly, encode 64-bit counters as decimal strings, and use monotonic durations.

HTTP records link the IDs from [Wire correlation](../Atlas%20Protocol/wire.md#http-correlation).
Record cursors after commit. Database outcome, reply delivery, client apply, and execution
stay distinct. Plugin claims do not verify runtime identity.

Allowlist before normal retention: route templates, safe codes, counts, and durations.
Exclude credentials, bodies, raw URLs, coordinates, operational/payload filenames,
SQL, configuration values, and arbitrary Plugin errors. Exports use the subset below.
Credential attribution stays separate from Asset/publisher identity. Atlas producers
and Plugins never deliberately log credentials; raw capture has the separate boundary below.

| Owner | Events and aggregate measurements |
| --- | --- |
| HTTP | Route, outcome, elapsed time, observed body bytes, validation refusal, response-write failure |
| Reporting | Accepted, duplicate, and rejected evidence; fresh contact separately from acceptance |
| SQLite | Writer wait, transaction and commit duration, rollback, busy and storage faults, checkpoint delay |
| Objects | Receive, verify, flush, install, publish, and reclaim phases; transfer bytes and staged storage |
| Synchronization | Capture build, release and expiry; replay, handoff, gaps, buffer pressure, slow-client closure |
| Plugins | Readiness, exposure, redelivery, accepted evidence, runtime-loss decision, receipt capacity, drain time |
| Host manager | Startup, observed process exit, action handoff, verified writer exit, Reset phase, cleanup failure |

## Detail and resource bounds

Default INFO records state changes, active-work summaries every 30 seconds, and one
completion per non-report mutation attempt with attempt/request IDs, route, commit/refusal,
and first execution/exact replay. Failed reply delivery stays separate. Asset/Observation
reports use INFO counts and DEBUG attempts. Summarize normal outages and repeated faults.
WARN marks actionable degradation; ERROR marks failed work or a broken invariant.
DEBUG adds rate-limited metadata.

Metrics use fixed operation, route, outcome, and reason groups, never resource IDs or
arbitrary strings. The process owns timers/queues and stops them on shutdown. Diagnostics
run outside transactions and never control readiness or retries.

Initial limits: 8 KiB/event, 1 MiB queued output/process, and 100 DEBUG events/second/process.
Bound before copying/serialization; mark omitted oversized details. Full queues drop
diagnostics, never required evidence. Local inspection exposes collection health and known
dropped/suppressed counts without recursive logging. Downstream loss may be uncounted;
diagnostics do not promise a complete record.

## Local troubleshooting

Local administration enables troubleshooting for selected process runs. It defaults off,
is separate from DEBUG, and is not inherited by later runs or Restart. Expose its status.
Atlas-owned error paths add safe context and bounded source-code frames: module-relative
files, functions, and line numbers, never absolute host paths, URL query/fragment values,
arguments, locals, or arbitrary panic values. Authentication and TLS remain unchanged.

The selected run also captures bounded raw stdout/stderr for otherwise lost fatal/runtime/
dependency evidence. These separate files are sensitive: third-party output may contain
operational data or secrets that generic redaction cannot guarantee to remove. Help/status
state this boundary. Restrict access to the service owner/host administrator. Never send raw
capture to ordinary logs, journals, SDK observers, or standard exports. No memory dumps.
Disabling switches output to discard, then drains/closes retained writers without breaking output.

## Collection and lifetime

Disable Docker logging and unmanaged crash files. Discard normal Core/manager raw output,
including `http.Server.ErrorLog`; recovered HTTP panics emit safe events. Core sends structured
events privately to the manager, which validates its own records and bounds/parses Plugin
output before normal retention. Drop malformed/prohibited records and report known omissions.
The manager owns Core/Plugin collectors; its launcher owns manager crash capture and outlives
the crashing process for a bounded drain. Select sinks before launch. Raw capture follows the
same byte/queue bounds before buffering and must not block workload writes. Drop/truncate
under pressure and report gaps. No unbounded buffers or duplicate host log sinks.

Assign source quotas before launch: normal logs, raw captures, rotation, overhead, and export
staging total at most 256 MiB. Rotate oldest records within each source's quota. Include
transient buffers in [aggregate capacity](storage.md#retention-and-capacity). Target eight hours
of default-detail history, including a four-hour mission; age is not a hard expiry and
troubleshooting can shorten retention. Expose retained ranges/gaps. Disk bounds and retention
need [qualification](qualification.md); event limits alone are not proof.

[Lifecycle](lifecycle.md#reset-recovery) owns Restart and Reset semantics.
Restart reuses containers and bounded files but disables troubleshooting.
Reset disables capture and covers
container, Plugin, manager, and launcher copies. The action owner stops/completes exports,
verifies emitters stopped, drains collectors, and switches/closes all manager and launcher
writers. Verify old writes drained before deletion; discard raw output during Reset.
Use supported installation storage/container controls, never Docker-owned file edits or
unrelated journal cleanup. Unverified cleanup leaves Reset incomplete; management authority survives.

Local administration can export a bounded bundle with versions, Dataset/run context, and
known gaps. Configuration includes only the severity threshold and numeric diagnostic limits;
paths, destinations, and other values remain excluded. Report partial/failed exports.
A separately selected sensitive export may include raw capture and identifies its sensitivity.
Neither export uploads automatically or gates Reset. User-owned exports survive Reset.

[Next: qualification](qualification.md)
