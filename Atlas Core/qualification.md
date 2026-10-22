# Qualification and acceptance

**A design is not evidence. Test observable behavior through real boundaries.**
Use real SDK/Core HTTP, SQLite, files, and relevant containers/manager processes.
Use independent expected values, not a client and server agreeing on the same
mistake. Run direct Protocol and SDK cases from equivalent isolated states.

## Compact acceptance checklist

| Workflow | Essential failure evidence |
| --- | --- |
| Shared components | Independent valid/invalid examples; allowed Entity compositions; Go/TypeScript agreement; SDK input/response validation and direct-HTTP refusal of malformed input |
| Wire and identity | Absent/null, exact counters and identifiers; authenticated discovery and exact-version refusal; equal API permissions across keys; wrong Dataset; lost enrollment reply; revoked-key rejection |
| Asset updates | Unified description/status/section updates; whole-section replacement and mixed-update atomicity; API-key-only direct/relayed evidence; direct/relayed deduplication, section ordering, correction identity and age, and movement history; contact expiry without new packets; competing process replacement; obsolete-generation rejection |
| Observations and default fusion | Stable publisher; continuing Observation versus report and constituent measurement identities; direct/relayed deduplication; whole-section ordering and correction age; atomic Observation/Track creation and updates; lost replies and racing retries; errors, withdrawals, and unknowns remain visible |
| Retained Tracks and evidence | Independent publishers initially yield separate Tracks; inactivity and Restart preserve identities, history, source provenance, and Object associations; no individual Observation or Track deletion; Reset clears all retained records |
| Field reconnection | Drops lasting seconds or about 30 seconds; an Asset returning after five minutes; retained evidence without repeating uncertain work |
| Tasks | Lost reply, terminal immutability, queue revisions, Pause/Resume ordering, edited Geofeature references, late results, Asset deletion without invented outcomes or transferred Tasks |
| Task cancellation | Offline request, Asset-confirmed cancellation, refusal restores execution state and queue slot, delayed completion supersedes the request |
| Objects | Streaming bounds, exact digest/bytes, crash around file/SQL publication, same-ID retry without overwriting prior attempt files, cleanup preserves live precommit writers and ambiguous files, holds versus deletion, disk-full and integrity faults |
| Plugins | Disconnect versus runtime loss, same-runtime redelivery, receipt exhaustion, protected drain/force, recovered evidence, removal and retained results |
| Operation cancellation | Request alone does not cancel; Plugin-confirmed cancellation; completion or failure before effective cancellation wins; late reports preserve terminal state |
| Operation recovery | Plugin loss before possible delivery keeps pending work; loss after possible delivery interrupts it; Core restart interrupts both |
| Recovered outcomes | Original Operation reads expose recovered outcomes, effects, and result links; state remains interrupted; no new Operation or execution |
| Lifecycle | Retained Restart, interrupted Reset before/after establishment, verified writer exit, manager loss/takeover, Hard Reset and settings failure |
| Full synchronization | All four Observation/history coverage combinations; local versus explicit HTTP reads; independent base readiness; online backfill/cutover/disable; whole-message interruption, capture cleanup, fixed handoff, replay expiry, slow clients, restart rebuild, Reset and isolated optional capacity failure |
| History query views | [Frozen-page examples](../Atlas%20Protocol/history-queries.md#independent-acceptance-example); exact-time/scoped-identity order; inserts and corrections during paging; HTTP/Full parity; lost first-page replies; explicit release, expiry, Restart/Reset and local coverage loss; original-owner continuation; view expiry before capacity refusal |

For example, create O17 and record its assigned T42. Move O17 with R2 and verify
both IDs remain. Replay creation and R2 through another gateway with no new Track,
movement sample, or public change. Force rollback and verify neither side publishes.
Make O17 silent, resume it, and verify T42 remains the same retained Track.
Include a churn case with new Observations alongside accumulated inactive records.
Neither silence nor picture capacity permits eviction of the retained records.
Use the independent [history-only evidence example](../Atlas%20Protocol/report-evidence.md#independent-acceptance-example)
and [retained-Dataset qualification](workload-qualification.md) requirements.

For generation, delete outputs and regenerate deterministically with pinned tools.
Qualify the supported schema profile, independent cross-language examples, package
consumption, and binary adapters. Do not buffer a large file in a JSON validator.
A generated type check is not a request/response-validation test.

Use the [Protocol boundary qualification cases](protocol-qualification.md) to retain
demonstrated validator pitfalls without treating the experiment as a qualified runtime.

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
| Lost non-report write reply | At default Core and SDK Summary detail, match the attempt; keep SDK outcome unknown; retry has new attempt context and the same prepared identity; one durable effect and complete picture application |
| Read routing and transfers | Covered Full-mode reads send zero HTTP requests; default reads and repeated uploads report the observed source and byte category without buffering whole files |
| Recovery and authorization | Explain requested/ready coverage, replay versus rebuild, capacity pause, and subscriber gaps; ordinary outages and revoked credentials cause no diagnostic or recovery hot loop |
| Server delay and cleanup | Separate writer wait from commit time, file publication from cleanup, and Plugin channel loss from confirmed process death |
| Correlation headers | Missing, malformed, and duplicate header fields preserve domain behavior; reused attempt values need no registry; trusted browser origins can send/read headers; validate IDs on success, error, binary, and empty responses |
| Diagnostic pressure and privacy | Flood producers and block/fail sinks; memory and disk stay bounded, omissions remain visible, request outcomes are unchanged, and prohibited fields appear in no normal log or standard export |
| Local troubleshooting | Off by default and enabled only for selected runs; recovered/fatal panics produce useful bounded context and frames or explicitly sensitive crash evidence; private raw capture never leaks into normal logs or standard exports |
| SDK observer lifecycle | Debug frames and context obey field/count bounds; raw Error/stack/input objects never reach observers; throwing observers or failed exports do not change requests or recovery; close stops deliveries and timers |
| Restart and Reset | Restart retains bounded files but disables troubleshooting; Reset verifies container, Plugin, manager, and launcher capture writers and old copies are cleared, including interrupted cleanup; management authority stays separate |

Exercise recovered HTTP panics, fatal background panics, and dependency writes in
both Go processes with troubleshooting off and on. Inject sentinel filenames and
secrets into panic/error text: none may reach normal logs, structured debug fields,
journals, or standard exports. Sensitive raw capture may contain them only within
its declared private boundary; verify access, quotas, truncation, deliberate export,
disable, and Reset cleanup. Verify useful fault locations survive without argument
values, and that unavailable evidence is reported honestly. No capture blocks work.

## Workload targets, not measured capability

The [workload qualification inputs](workload-qualification.md) own initial targets,
resource and byte budgets, proposed cumulative-turnover fixtures, and Full recovery
acceptance. The proposed rates and retained totals need confirmation and measurement.
No workload qualification has run in this documentation-only baseline.
Neither tuning nor capacity failure permits weaker retention or atomicity.

## Report honestly

Record revision, actual commands, inputs, environment, and passed/failed/unrun checks.
Do not borrow historical successes from another repository. Process-kill tests do
not establish power-loss durability. Simulated Assets do not establish flight or
radio readiness. An independently built Plugin must actually run and be removable.

This completes the Core reading path. Continue with [SDK](../Atlas%20SDK/README.md).
