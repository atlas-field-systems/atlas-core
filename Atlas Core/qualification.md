# Qualification and acceptance

**A design is not evidence. Test observable behavior through real boundaries.**
Use real SDK/Core HTTP, SQLite, files, containers, and local administration commands.
Use independent expected values, not a client and server agreeing on the same
mistake. Run direct Protocol and SDK cases from equivalent isolated states.

## Compact acceptance checklist

| Workflow | Essential failure evidence |
| --- | --- |
| Shared components | Independent valid/invalid examples; allowed Entity compositions; runtime-schema/OpenAPI export equivalence; SDK input/response validation and direct-HTTP refusal of malformed input |
| Wire and identity | Absent/null, exact counters and identifiers; authenticated discovery and exact-version refusal; equal API permissions across keys; wrong Dataset; lost enrollment reply; revoked-key rejection |
| Database worker | [Worker ownership](database.md); bounded queues, exact SQL encodings, effective WAL/FULL, commit/reply separation, checkpoint pressure, and verified exit before cleanup |
| Service health/readiness | [State table](readiness.md); startup, draining, storage pressure, isolated Object faults, and worker failure preserve the specified request paths |
| Asset updates | Unified description/status/section updates; whole-section replacement and mixed-update atomicity; API-key-only direct/relayed evidence; direct/relayed deduplication, section ordering, immutable reading facts and age, and append-only positions; contact expiry without new packets; competing process replacement; obsolete-generation rejection |
| Observations and default fusion | Stable publisher; continuing Observation versus report and constituent measurement identities; direct/relayed deduplication; whole-section ordering, late positions, and preserved source age; atomic Observation/Track creation and updates; lost replies and racing retries; errors, withdrawals, and unknowns remain visible |
| Retained Tracks and evidence | Independent publishers initially yield separate Tracks; inactivity and Restart preserve identities, history, source provenance, and Object associations; no individual Observation or Track deletion; Reset clears all retained records |
| Field reconnection | Drops lasting seconds or about 30 seconds; an Asset returning after five minutes; retained evidence without repeating uncertain work |
| Tasks | Lost reply, terminal immutability, queue revisions, Pause/Resume ordering, edited Geofeature references, late results, Asset deletion without invented outcomes or transferred Tasks |
| Task cancellation | Offline request, Asset-confirmed cancellation, refusal restores execution state and queue slot, delayed completion supersedes the request |
| Objects | Streaming bounds, exact digest/bytes, crash around file/SQL publication, same-ID retry without overwriting prior attempt files, cleanup preserves live precommit writers and ambiguous files, holds versus deletion, disk-full and integrity faults |
| Lifecycle | Retained Restart; command interruption before/after Dataset establishment and proof; explicit recovery under the installation lock; verified writer exit; reused process identities; missing/corrupt recovery state; Hard Reset and settings failure |
| Full synchronization | Fixed Assets, Tracks, Geofeatures, Tasks, ready Object metadata; explicit HTTP Observations/history in both modes; whole-message interruption, capture cleanup, fixed handoff, replay expiry, slow clients, restart rebuild, Reset, and explicit capacity failure |
| History query views | [Frozen-page examples](../Atlas%20Protocol/history-queries.md#independent-acceptance-example); exact-time/scoped-identity order; late positions during paging; changed reading facts refused; HTTP in both modes; lost allocation replies; release, expiry, Restart/Reset; original Core-run continuation; view expiry before capacity refusal |

For example, create O17 and record its assigned T42. Move O17 with R2 and verify
both IDs remain. Replay creation and R2 through another gateway with no new Track,
movement sample, or public change. Force rollback and verify neither side publishes.
Make O17 silent, resume it, and verify T42 remains the same retained Track.
Include a churn case with new Observations alongside accumulated inactive records.
Neither silence nor picture capacity permits eviction of the retained records.
Use the [history-only evidence example](../Atlas%20Protocol/report-evidence.md#independent-acceptance-example)
and [retained-Dataset requirements](workload-qualification.md).

For schema export, follow the [build gates](build-profile.md), delete outputs,
and export again with exact locked tools. Qualify independent boundary examples,
runtime/OpenAPI equivalence, browser-safe package consumption, and binary adapters.
Do not buffer large files in a JSON validator. An inferred type check is not a
request/response-validation test.

`npm test` exercises all 66 HTTP exchanges, real WSS handoff, immutable evidence,
Tasks, streams, revocation, capacity refusal, worker loss, and offline establishment.
The `Core build and tests` GitHub Actions job runs it on pull requests and pushes
to main with Node 24.22.1 and npm 11.19.0. It prepares the hash-pinned Protocol
artifact before frozen-installing Core with native-driver install scripts enabled.
The job also builds the pinned image, runs the actual CLI/container suite, and runs
the bounded retention fixture. The build verifies dependencies and SQLite identity.
Set `ATLAS_TEST_ROOT` to an absolute directory outside the managed workspace.
The harness rejects source-local roots. Keep the entire installation there, including
SQLite sidecars, captures, Object files, TLS files, and diagnostic logs. Redirect
command output there too, for example `npm test >"$ATLAS_TEST_ROOT/suite.log" 2>&1`.
This isolates mutable files from workspace tooling; moving only `core.sqlite` does not.
Build artifacts remain separate from test installations. CI uses the runner's temporary directory.
On a source iterator's `SQLITE_CORRUPT`, tests retain DB/WAL/SHM files before cleanup
under `$ATLAS_TEST_ROOT/capture-failures`, with active-reader and fresh-reader checks.
Four test-only bundles are capped at 32 MiB each; failed CI runs retain them for seven days.
`npm run test:container` exercises the pinned image and CLI on fresh installations,
including command interruption, explicit recovery, settings failures and Hard Reset.
Protocol boundary cases remain in [protocol-qualification.md](protocol-qualification.md).

A test must fail when its required assertion cannot run. Observe the promised
path, not just an eventual value that a hidden fallback could produce. Test the
actual failure boundary, including cleanup after owner interruption. Preserve both
primary and cleanup failures. Extend existing workflows before creating another suite.

## Diagnostic evidence in those workflows

Use [Core diagnostics](diagnostics.md) and [SDK diagnostics](../Atlas%20SDK/diagnostics.md)
while exercising the real paths above. Check records and summaries against
independent request counts, known content lengths, and retained domain results.
Diagnostic records alone cannot establish that work committed or executed.

| Scenario | Required evidence |
| --- | --- |
| Lost non-report write reply | With default Core detail and explicitly enabled SDK Summary, match the attempt; keep SDK outcome unknown; retry has new attempt context and the same prepared identity; one durable effect and complete picture application |
| Read routing and transfers | Ready picture reads send zero HTTP requests; explicit Observation/history reads use HTTP in both modes; default reads and repeated uploads report the observed source and byte category without buffering whole files |
| Recovery and authorization | Revoked credentials stop all network work; complete local picture queries/subscriptions remain explicitly stale and authorization-required; changed credentials need authenticated discovery, with no write replay or recovery hot loop |
| Server delay and cleanup | Separate writer wait from commit time, file publication from cleanup, and lost maintenance replies from verified process exit |
| Correlation headers | Missing, malformed, and duplicate header fields preserve domain behavior; reused attempt values need no registry; trusted browser origins can send/read headers; validate IDs on success, error, binary, and empty responses |
| Diagnostic pressure and privacy | Flood producers and block/fail sinks; memory and disk stay bounded, omissions remain visible, request outcomes are unchanged, and prohibited fields appear in no normal log or standard export |
| Safe fault context | Handled HTTP exceptions and fatal runtime errors produce safe bounded context and frames or explicitly unavailable evidence; unstructured output is never retained |
| SDK observer lifecycle | Debug frames and context obey field/count bounds; raw Error/stack/input objects never reach observers; throwing observers or failed exports do not change requests or recovery; close stops deliveries and timers |
| Restart and Reset | Restart retains bounded logs; Reset verifies Core and export writers stopped and old logs/staging cleared; interrupted cleanup needs explicit recovery; establishment proof prevents a second wipe |

Exercise handled HTTP exceptions, fatal background errors, and dependency writes
in Core and local commands. Inject sentinel filenames and secrets into exception
text and unstructured output. None may reach retained logs, debug fields, recovery
records, or exports. Verify useful fault locations without argument values, honest
unavailable evidence, bounded direct file rotation, and no unmanaged raw copies.
Interrupt a command and verify no detached cleanup or automatic recovery runs.
Explicit recovery must recheck ownership and preserve an already established Dataset.
Crash after the establishment marker commits but before proof or action progress
flushes. Recovery must preserve that Dataset and regenerate proof without another
wipe. Separately interrupt before establishment, then verify one establishment on
recovery. Conflicting or unreadable facts must stop cleanup without deleting data.

## Workload targets, not measured capability

The [workload qualification inputs](workload-qualification.md) reference budgets and
own initial targets, selected cumulative-turnover pressure fixtures, and Full
recovery acceptance. Pressure results do not establish supported retained workloads.
The bounded `npm run fixture:retention` does not qualify the sustained workload.
Neither tuning nor capacity failure permits weaker retention or atomicity.

## Operator-interface qualification

The [intended CLI and TUI](command-line.md) require the following evidence before
release. These workflows are unrun until the packaged interface exists. Extend the
existing CLI and container workflows using the exact npm artifact and matching image
identified by the [release metadata](build-profile.md#operator-package).

- Install on a clean supported host without a checkout or compiler. Check missing
  prerequisites, invalid artifacts, and retained-state protection.
- Install the local release tarball offline with an empty npm cache and networking
  disabled, then set up Core with its preloaded image. Verify the tarball against
  the trusted manifest before installation. A tampered tarball must fail that check
  before npm runs; a missing runtime dependency must fail the offline-install test.
- Complete setup, start, settings changes, credential provisioning, enrollment,
  export, and certificate replacement through both interfaces with matching outcomes.
- Exercise keyboard navigation, resize, SSH, noninteractive output, cancellation,
  terminal loss, concurrent commands, and interrupted destructive work.
- Verify authenticated HTTP, WebSocket synchronization, and file transfers directly
  against the configured endpoint, including local use without internet.
- Verify retained data across stop, restart, and host reboot. Core remains stopped
  after reboot until explicitly started. Package replacement and removal preserve state.
- Check safe failure output, partial exports, recovery-required states, and invalid
  or expired certificates. Neither diagnostics nor cancellation may conceal cleanup failure.

Keep installation and failure evidence outside the workspace. Record package and
image identities, host configuration, commands, and results. These checks do not
qualify external deployment services, sustained workload, or power-loss durability.

## Report honestly

Record revision, actual commands, inputs, environment, and passed/failed/unrun checks.
Do not borrow historical successes from another repository. Process-kill tests do
not establish power-loss durability. Simulated Assets do not establish flight or
radio readiness. An external integration test must use public HTTP and credentials,
without relying on Core-owned process supervision.

[Next: SDK](../Atlas%20SDK/README.md)
