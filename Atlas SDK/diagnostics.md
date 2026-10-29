# SDK diagnostics

SDK diagnostics explain client traffic and recovery without changing request
outcomes or the local picture. Applications choose where diagnostics go; SDK
provides no log server, persistent log store, or automatic upload to Core.

## One optional observer

Configure one typed diagnostic observer when creating the SDK instance.
Events form a small discriminated union of request, connection, synchronization,
and summary records. This is SDK behavior, not a Protocol event schema.

| Mode | Behavior |
| --- | --- |
| Disabled, default | No diagnostic records, queue, serialization, or summary timer |
| Summary | State transitions, failed attempts, non-report mutation completions, counts and timing buckets |
| Debug | Summary plus rate-limited attempt metadata, safe error context, and code-location frames |

Atlas applications can explicitly enable Summary and connect the observer to
their logger or local support export. Applications own retention and asynchronous
export failures. Core Reset cannot erase copies retained by another application.
[HTTP correlation](../Atlas%20Protocol/wire.md#http-correlation) remains transport
behavior even when the diagnostic observer is disabled.

## What the SDK observes

Events include UTC time, stable kind, SDK release, instance, read mode, detail, and
relevant Dataset/picture generation. Use monotonic durations. Preserve available attempt,
Core request, and prepared mutation retry IDs; keep read sources/outcomes explicit.
Summary retains IDs for failures (including `unknown_outcome`) and non-report mutation
completions. Successful observation-only reports and reads use counts.

| Area | Events and aggregate measurements |
| --- | --- |
| Reads | Operation family, HTTP or picture source, explicitly stale reads |
| Requests | Attempt number, outcome, elapsed phases, intentional retry, later resolution |
| Connection | Disconnect, selected backoff, reconnect, authorization pause, recovery duration |
| Synchronization | Capture reuse, pages, handoff, replay, rebuild reason, capacity pause, subscriber gap |
| Local work | Validation and atomic apply duration, received and applied complete commits |
| Transfers | Observed application bytes per attempt, repeated upload and snapshot volume |

Use the [request outcome definitions](requests.md#prepare-before-sending) unchanged.
Group retries by prepared identity without counting them as new effects. A late
validated reply can resolve uncertainty; cancelling a wait is not a failed write.
Emit picture events only after complete transitions, never for partial staging.

A rebuild reason distinguishes expired replay, expired capture, Dataset change,
changed capacity requirements, and invalid input. WebSocket diagnostics use
connection-local context plus existing Dataset, load, and complete-commit context.
No additional log messages travel on the synchronization feed.

## Honest measurements and safe fields

Upload bytes read from a source are not proof of bytes transmitted. Browser
transport measurements may be unavailable; unknown is not zero. Name whether a
count describes supplied, received, or observed transport bytes. Never clone or
buffer a complete upload or response solely to measure it.

Time since the last update is not synchronization lag on an idle Dataset. Do not
subtract opaque cursors or infer network latency from client and server clock
differences. Record phase durations and known handoff progress instead.

Events allowlist typed metadata. Exclude credentials, payload values, geometry,
operational/payload filenames, raw URLs, arbitrary response details, and validation input.
Debug adds operation, phase, safe error code/category, and bounded source-code frames:
module-relative files, functions, and line/column numbers; unavailable frames are explicit.
Exclude absolute host paths, URL query/fragment values, arguments, and locals. Never forward
raw exceptions, messages, causes, headers, or stack strings. Debug is per SDK instance,
needs no server capture, and changes no TLS, authentication, retry, or read behavior.

## Bounds and observer failure

Summary uses fixed operation and reason categories, not per-resource identity maps.
Each variant has a fixed shape and bounded collections, with no arbitrary nesting.
Initial limits are 128 queued records per instance, 16 code-location frames per
error, and 256 UTF-16 code units per string field. Omit oversized fields with a marker;
never truncate identifiers.
Check lengths before copying. Debug emits at most 100 events per second. Summary
flushes active counters every 30 seconds; idle intervals produce no event.
Drop excess diagnostic records and expose known omissions in the next summary.
If a summary cannot enter the queue, retain its counters for the next interval.
These initial limits need qualification with the planned workload.

The SDK owns its queue and timer. Deliver events outside request and picture commit
work, after recording any accepted result. The synchronous observer must return
promptly and own any asynchronous export. Catch observer exceptions without
changing calls, state, retries, or subscriptions. Do not await exports. SDK cannot
preempt a callback that blocks its JavaScript thread.

Close stops diagnostic delivery and timers and releases observer references.
Queued records and unflushed counters are discarded; close does not flush or export.
No diagnostic failure authorizes a retry, snapshot rebuild, or new domain request.

For example, a mutation can commit while its reply disappears. The SDK records
`unknown_outcome`; a deliberate retry has another attempt ID and the same prepared
identity. Core's retained result resolves it without another effect. Logging loss
leaves that [recovery behavior](requests.md#retry-deliberately) unchanged.

This completes the SDK reading path.
