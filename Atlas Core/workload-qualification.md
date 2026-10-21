# Workload and retained-Dataset qualification

**These are qualification inputs and acceptance requirements, not measured results.**
This documentation-only baseline has run none of the runtime cases below.

## Existing initial targets

Keep one server, one or two operators, about 20 Assets, and 200 Observations reporting
concurrently. Rates are two reports per Asset and one per Observation per second.
Track changes are derived effects, not incoming reports. Use a four-CPU, 8 GB RAM,
local-SSD Core host and an 8 GB client. Target four-hour missions and eight-hour
retained Datasets. Eight hours is a workload duration, not a retention limit.

The fixed baseline retains 200 Observations and 200 default Tracks without turnover.
Over eight hours it has 6,912,000 reports, 9,600 Tasks, and 28,800 Operations.
Include accumulated identities/history, terminal records, old and replacement pictures,
and decoded memory. Test a 10× burst, ten-minute backlog, slow consumer, and four
concurrent 1 GB uploads plus downloads. Typical files are 100 MB. Plan for 10 GB
of content per day. These existing design targets still require qualification.

## Proposed cumulative-turnover fixture

The following rates and totals are proposed test assumptions, not approved deployment
targets or a supported retained-Dataset limit. Field evidence must confirm their realism.
Start with 200 Observations and their 200 default Tracks. Replace one reporting
Observation with a new lifetime for each turnover event. Keep exactly 200 reporting
at one report per second each. Retain every inactive record and its history until Reset.
Creation's initial evidence counts in that reporting rate. Seed creation is outside
the timed interval. For turnover rate r and duration t seconds, each retained type
has N = 200 + r × t records. Restart does not reduce N.

| Variant | New lifetimes per second | Duration | Retained Observations | Retained Tracks | Pair resources alone |
| --- | --- | --- | --- | --- | --- |
| Mission | 1 | 4 hours | 14,600 | 14,600 | 29,200 |
| Dataset | 1 | 8 hours | 29,000 | 29,000 | 58,000 |
| Count-pressure case | 2 | 8 hours | 57,800 | 57,800 | 115,600 |

At eight hours, the Dataset variant has 28,800 inactive records of each type.
Use 100 Geofeatures, one Task every three seconds, one Operation per second, and one
100 MB ready Object every 900 seconds. With 20 Assets, the eight-hour picture has
9,600 Tasks, 32 ready Objects, and 67,752 total resources. Associations add image bytes.
History and 28,800 Operations use Core storage but are outside the Full picture.
The count-pressure case must encounter Full capacity before its final retained total.
Even 50,000 pairs consume 100,000 resources before other resource types.

Before a run, fix valid payload-size distributions, disk budget, and reserved headroom.
Record exact counts and encoded bytes at each checkpoint, including inactive records.
These remaining fixture inputs and supported turnover/retained totals are unresolved.

## Initial budgets and accounting

Both byte and count limits apply. Settings require measurement and reviewed tuning.

| Boundary | Byte budget | Count or time budget |
| --- | --- | --- |
| Request/file admission | 1 MiB JSON; 2 GB per file | Four uploads; 1,000 outstanding Tasks per Asset; 32 sync connections |
| Object storage | 16 GB quota; 8 GB headroom | Aggregate storage accounting still applies |
| Complete sync message | 4 MiB | 1,000 changes |
| Pending sync connection | 4 MiB | Whole messages only |
| Retained replay | 64 MiB | 15 minutes |
| SDK picture | 512 MiB | 100,000 resources across all covered types |
| SDK journal | 16 MiB | 10,000 complete commits |

Measure actual aggregate RAM, including old picture, staging, indexes, decoded values,
and journal. Encoded-byte accounting is not a memory guarantee. Charge database,
history, indexes, temporary captures, files, Plugin work, and logs to aggregate disk.
Use typed `413 payload_too_large`, `429 resource_limit`, and `507 storage_limit`
refusals. Lower limits govern new admission, not silent deletion or cancellation.

## Full snapshot, recovery, and capacity acceptance

1. At seed, four hours, and eight hours, attempt a fresh Full snapshot while reports
   continue. Where it fits, check retained totals, inactive records, associations, and source
   ages against independent expected values. Publish only after fixed-handoff catch-up.
2. At accumulated size, interrupt snapshot paging and catch-up separately. Resume a
   valid capture or complete staging as permitted. Expire capture/replay and rebuild.
   Check coherent cursors, complete commits, subscription recovery, and owner cleanup.
3. Restart Core and reconnect at the same retained size. Verify IDs, history, and
   associations through both Full reads and explicit history reads. Restart expires
   temporary captures without reducing retained counts or fabricating fresh ages.
4. Exercise count and byte capacity separately, below, at, and above each configured
   limit. Keep the other dimension within budget. Use valid payloads to cross the
   picture byte limit, and vary turnover for count pressure. Check journal, whole-batch,
   replay, and aggregate-memory limits too. Record actual first-binding limits.
5. On capacity failure, require the documented explicit resource-limited state.
   Expose no partial replacement, eviction, hidden HTTP fallback, or rebuild hot loop.
   Explicit retry or a relevant capacity change starts one recovery owner. A retry
   under unchanged insufficient limits returns to paused. Retained records survive.
   Core can still admit reports within its own budgets while Full recovery is paused.
6. Measure p95 ordinary requests below 250 ms, picture lag below one second, and
   initial load below ten seconds where the whole picture fits. A capacity stop is
   expected only in declared pressure cases, not a passing normal-load result.

Follow [Protocol recovery](../Atlas%20Protocol/synchronization.md) and
[SDK capacity behavior](../Atlas%20SDK/picture.md#capacity-and-retry). Report revision,
inputs, configured budgets, measured peaks, commands, and passed/failed/unrun cases.
No result for the fixed baseline establishes qualification of cumulative turnover.

[Qualification checklist](qualification.md)
