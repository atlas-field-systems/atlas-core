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
| Asset updates and Tracks | Unified description/status/section updates; whole-section replacement and mixed-update atomicity; API-key-only direct/relayed evidence; deduplication across keys/gateways, ordering, and history; contact expiry without new packets; competing process replacement; obsolete-generation rejection; stable publisher; correction age |
| Field reconnection | Drops lasting seconds or about 30 seconds; an Asset returning after five minutes; retained evidence without repeating uncertain work |
| Tasks | Lost reply, terminal immutability, queue revisions, Pause/Resume ordering, edited Geofeature references, late results, Asset deletion without invented outcomes or transferred Tasks |
| Task cancellation | Offline request, Asset-confirmed cancellation, refusal restores execution state and queue slot, delayed completion supersedes the request |
| Objects | Streaming bounds, exact digest/bytes, crash around file/SQL publication, same-ID retry without overwriting prior attempt files, cleanup preserves live precommit writers and ambiguous files, holds versus deletion, disk-full and integrity faults |
| Plugins | Disconnect versus runtime loss, same-runtime redelivery, receipt exhaustion, protected drain/force, recovered evidence, removal and retained results |
| Operation cancellation | Request alone does not cancel; Plugin-confirmed cancellation; completion or failure before effective cancellation wins; late reports preserve terminal state |
| Operation recovery | Plugin loss before possible delivery keeps pending work; loss after possible delivery interrupts it; Core restart interrupts both |
| Recovered outcomes | Original Operation reads expose recovered outcomes, effects, and result links; state remains interrupted; no new Operation or execution |
| Lifecycle | Retained Restart, interrupted Reset before/after establishment, verified writer exit, manager loss/takeover, Hard Reset and settings failure |
| Full synchronization | Whole-message interruption, immutable capture under concurrent writes and paging, failed-build cleanup, fixed handoff, capture retry/release, replay expiry, slow clients, rebuild, Dataset change and capacity pause |

For generation, delete outputs and regenerate deterministically with pinned tools.
Qualify the supported schema profile, independent cross-language examples, package
consumption, and binary adapters. Do not buffer a large file in a JSON validator.
A generated type check is not a request/response-validation test.

A test must fail when its required assertion cannot run. Observe the promised
path, not just an eventual value that a hidden fallback could produce. Test the
actual failure boundary, including cleanup after owner interruption. Preserve both
primary and cleanup failures. Extend existing workflows before creating another suite.

## Workload targets, not measured capability

Target one server, one or two operators, about 20 Assets and 200 Tracks. Initial
rates are two Asset reports and one Track report per second per source. Qualify
four-hour missions and eight-hour retained Datasets, including bursts and backlog.
Use a four-CPU, 8 GB RAM, local-SSD Core host and an 8 GB client as the reference.

The eight-hour fixture has 6,912,000 reports, 9,600 Tasks, and 28,800 Operations.
Include accumulated identities/history, terminal records, old and replacement
pictures, and decoded memory. Test a 10× burst, ten-minute backlog, slow consumer,
and four concurrent 1 GB uploads plus downloads. Typical files are 100 MB;
plan for 10 GB of content per day.

Initial admission settings are 1 MiB JSON, 2 GB files, four uploads, 1,000 outstanding
Tasks per Asset, and 32 sync connections. Initial Object quota/headroom are
16 GB/8 GB. Use typed `413 payload_too_large`, `429 resource_limit`, and
`507 storage_limit` refusals. Lower limits govern new admission, not silent deletion
or cancellation of accepted work.

Initial sync budgets are 4 MiB/1,000 changes per complete message, 4 MiB pending per
connection, and 64 MiB/15 minutes of replay. SDK picture and journal budgets start
at 512 MiB/100,000 resources and 16 MiB/10,000 commits. Measure actual aggregate RAM;
encoded-byte accounting is not a memory guarantee.

Qualification targets include p95 ordinary requests below 250 ms, picture lag below
one second, and initial load below ten seconds. All values require measurement and
may need reviewed tuning; none justifies weakening retention or atomicity.

## Report honestly

Record revision, actual commands, inputs, environment, and passed/failed/unrun checks.
Do not borrow historical successes from another repository. Process-kill tests do
not establish power-loss durability. Simulated Assets do not establish flight or
radio readiness. An independently built Plugin must actually run and be removable.

This completes the Core reading path. Continue with [SDK](../Atlas%20SDK/README.md).
