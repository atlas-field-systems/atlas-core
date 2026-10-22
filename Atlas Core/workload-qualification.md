# Workload and retained-Dataset qualification

**These are qualification inputs and acceptance requirements, not measured results.**
This documentation-only baseline has run none of the runtime cases below.

## Selected baseline targets

Use one server, one or two operators, 20 Assets reporting twice per second, and
200 Observations reporting once per second concurrently.
Track changes are derived effects, not incoming reports. Use a four-CPU, 8 GB RAM,
local-SSD Core host and an 8 GB, Pi 5-class-or-better SDK client with good Wi-Fi/IP.
Client RAM is a fixture, not a universal minimum. Target four-hour missions and
eight-hour retained Datasets; neither is a retention limit.

The fixed baseline retains 200 Observations and 200 default Tracks without turnover.
Over eight hours it has 6,912,000 reports, 9,600 Tasks, and 28,800 Operations.
Include retained evidence, terminal records, selected coverage, staging, and decoded
memory. Test a 10× burst, ten-minute backlog, slow consumer, and four concurrent 1 GB
uploads plus downloads. Typical files are 100 MB; plan for 10 GB per day.

## Selected cumulative-turnover pressure fixtures

These are selected pressure tests, not additional supported-workload requirements.
An explicit resource-limited outcome is valid when selected coverage exceeds its
configured budget. They require no larger client limit. Start with 200 Observations
and their default Tracks. Replace one reporting Observation per turnover event;
keep 200 reporting once per second.
Retain inactive records and history until Reset. Creation's initial evidence counts
toward the report rate; seed creation is outside the timed interval. At turnover
rate r over t seconds, each type has N = 200 + r × t records. Restart does not reduce N.

| Variant | New lifetimes per second | Duration | Retained Observations | Retained Tracks | Pair resources alone |
| --- | --- | --- | --- | --- | --- |
| Mission | 1 | 4 hours | 14,600 | 14,600 | 29,200 |
| Dataset | 1 | 8 hours | 29,000 | 29,000 | 58,000 |
| Count-pressure case | 2 | 8 hours | 57,800 | 57,800 | 115,600 |

At eight hours, the Dataset variant has 28,800 inactive records of each type.
Use 100 Geofeatures, one Task every three seconds, one Operation per second, and one
100 MB ready Object every 900 seconds. With 20 Assets, the eight-hour picture has
9,600 Tasks and 32 ready Objects: 38,752 base resources, or 67,752 with Observations.
The count-pressure variant has 67,552 base resources, or 125,352 with Observations;
only the latter necessarily exceeds the initial 100,000 count budget before history.
Associations add image bytes. Operations and activity remain outside the picture.

Enabled movement history adds retained readings and indexes. Declare fresh quantities,
carried-forward readings, late evidence, and corrections separately. For example,
20 Assets × 2 reports/second × 2 new quantities × 28,800 seconds gives 2,304,000
readings before any Observation/Track history: a count-pressure case at initial limits.
Carried-forward readings add none; corrections replace a revision of the same reading.

Fix payload sizes, disk budget, and headroom before each run; record counts and
encoded bytes at checkpoints. Resource counts alone do not prove byte or RAM fit.

## Initial budgets and accounting

Use the selected [Core limits](limits.md) and unchanged initial
[SDK picture budgets](../Atlas%20SDK/picture.md#capacity-and-retry).
Both byte and count limits apply. No pressure case implies automatic budget expansion.

Measure aggregate RAM for caches, old picture, staging, indexes, decoded values, journal,
query references, and frozen revisions. Encoded bytes do not prove fit. Bound views and
references before allocation. Charge database, history, indexes, captures, files,
Plugin work, and logs to aggregate disk.
Use the typed refusals defined in those limits. Lower settings govern new admission,
not silent deletion or cancellation.

## Full snapshot, recovery, and capacity acceptance

1. At seed, four hours, and eight hours, test all four Observation/history switch
   combinations under continued reports. Declare expected ready or resource-limited
   coverage from fixed inputs and budgets. Check retained totals, inactive/deleted-source
   evidence, provenance, and ages independently, including unknown IDs versus known-empty
   history for retained/deleted Entities. Ready reads use no HTTP; off reads use explicit
   HTTP. Loading never looks empty.
2. Enable each option online with concurrent new, late, duplicate, carried, and corrected
   evidence, including history-only corrections. Check gap-free common-boundary joining
   with no rollback or partial publication; base reads/updates remain usable while loading.
   Disable during paging/catch-up and after readiness; late work cannot restore the cache.
3. Interrupt paging, catch-up, and live delivery. Resume valid captures/replay; expire them
   and rebuild. Check complete commits, projected cursor progress, subscriber gaps, and
   cleanup. Restart Core preserves retained facts; SDK restart rebuilds selected caches
   from empty memory. Reset invalidates all coverage and outstanding loads immediately.
4. Cross count and byte limits independently. Expire query views and recheck capacity
   before pausing otherwise viable coverage. Measure journal, whole-batch, replay, staging,
   and aggregate RAM too. Optional load/update capacity failure leaves base coverage usable
   within its own limits, exposes unavailable coverage, and never silently evicts history,
   disables the requested option, falls back to HTTP, or repeatedly rebuilds. Explicit retry
   owns one recovery; unchanged insufficient limits pause again. Core retains all facts.
5. Target p95 ordinary requests below 250 ms, ready-picture lag below one second, and
   initial load below ten seconds where coverage fits. Report base readiness and each
   optional backfill separately. Capacity stops pass declared pressure cases only when
   independently expected. Baseline base-picture failure remains a qualification failure.
   Do not raise client budgets or reduce retention to make a fixture pass.

Follow [Protocol recovery](../Atlas%20Protocol/synchronization.md) and
[SDK capacity](../Atlas%20SDK/picture.md#capacity-and-retry). Report revision, inputs,
budgets, peaks, commands, and passed/failed/unrun cases.
No result for the fixed baseline establishes qualification of cumulative turnover.
