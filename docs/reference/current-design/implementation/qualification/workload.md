# Workload and retained-Dataset qualification

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

**These are qualification inputs and acceptance requirements, not measured results.**
`npm run fixture:retention` is a bounded functional fixture, separate from the
unrun sustained and capacity cases below. It defaults to 20 Assets, 200 reporting
Observations, 20 inactive lifetimes, and five rounds. It checks retained IDs,
220 Observations/Tracks, fixed picture pages and sampled history after Restart.

## Selected baseline targets

Use one server, one or two operators, 20 Assets reporting twice per second, and
200 Observations reporting once per second concurrently. Track changes are derived
effects, not incoming reports. Use a four-CPU, 8 GB RAM, local-SSD Core host and an
8 GB, Pi 5-class-or-better SDK client with good Wi-Fi/IP. Client RAM is a fixture,
not a universal minimum. Target four-hour missions and eight-hour retained Datasets;
neither is a retention limit.

The fixed baseline retains 200 Observations and 200 default Tracks without turnover.
Over eight hours it has 6,912,000 reports and 9,600 Tasks. Include retained evidence,
terminal records, picture staging, and decoded memory. Test a 10× burst, ten-minute
backlog, slow consumer, and four concurrent 1 GB uploads plus downloads.
Typical files are 100 MB; plan for 10 GB per day.

## Selected cumulative-turnover pressure fixtures

These are selected pressure tests, not additional supported-workload requirements.
An explicit resource-limited outcome is valid when the fixed picture exceeds its
configured budget. They require no larger client limit. Start with 200 Observations
and their default Tracks. Replace one reporting Observation per turnover event;
keep 200 reporting once per second. Retain inactive records and positions until Reset.
Creation's initial evidence counts toward the rate; seed creation is outside the
interval. At rate r over t seconds, each type has N = 200 + r × t records.
Restart does not reduce N.

| Variant | New lifetimes per second | Duration | Retained Observations | Retained Tracks | Pair resources alone |
| --- | --- | --- | --- | --- | --- |
| Mission | 1 | 4 hours | 14,600 | 14,600 | 29,200 |
| Dataset | 1 | 8 hours | 29,000 | 29,000 | 58,000 |
| Count-pressure case | 2 | 8 hours | 57,800 | 57,800 | 115,600 |

At eight hours, the Dataset variant has 28,800 inactive records of each type.
Use 100 Geofeatures, one Task every three seconds, and one 100 MB ready Object every
900 seconds. With 20 Assets, eight hours has 9,600 Tasks and 32 ready Objects.
The fixed picture has 38,752 resources in the Dataset variant and 67,552 in the
count-pressure variant. Observations and history do not add SDK picture items.
Neither count alone exceeds the 100,000-image budget; bytes can still exhaust it.
Associations add image bytes. Activity also remains outside the picture.

Declare fresh positions, carried readings, late arrivals, and duplicate reports
separately. If every Asset report has a new position, 20 × 2 × 28,800 produces
1,152,000 retained positions before Observation history. Carried readings add none.
Default Track history shares the source reading identity. HTTP history views have
their own reference and byte budgets; neither SDK mode backfills all history.

Fix payload sizes, disk budget, and headroom before each run; record counts and
encoded bytes at checkpoints. Resource counts alone do not prove byte or RAM fit.

## Initial budgets and accounting

Use the selected [Core limits](../../support/server-limits.md) and initial
[SDK picture budgets](../../shared/synchronization/client-picture.md#capacity-and-retry).
Both byte and count limits apply. No pressure case implies budget expansion.

Measure aggregate RAM for the old picture, staging, indexes, decoded values, journal,
and query pages. Encoded bytes do not prove fit. Bound Core history views and
references before allocation. Charge database, retained positions, indexes, captures,
files, and logs to aggregate disk. Lower settings govern new admission, not silent
deletion or cancellation. Use the typed refusals defined in those limits.

## Full snapshot, recovery, and capacity acceptance

1. At seed, four hours, and eight hours, load the fixed picture under continued
   reports. Declare expected ready or resource-limited outcomes from fixed inputs
   and budgets. Check inactive Tracks, provenance, and ages independently. Ready
   picture reads use no HTTP. Observation and history reads use explicit HTTP in
   both modes. Loading never looks empty. Known-empty history differs from unknown IDs.
2. During paging/catch-up, submit new, late, duplicate, and carried positions.
   Verify history-only admission through explicit history reads, without changing
   current sections. Observation reports update Tracks without adding Observation
   or history feed items. Read history concurrently and verify its frozen pages.
3. Interrupt paging, catch-up, and live delivery. Resume valid captures/replay;
   expire them and rebuild. Check complete commits, ordered progress, gaps, and
   cleanup. Core Restart preserves retained facts but expires temporary allocations.
   SDK restart rebuilds the picture from empty memory. Reset invalidates it and old loads.
4. Cross count and byte limits independently. Expire Core history views and recheck
   capacity before refusing otherwise viable work. Measure journal, whole-batch,
   replay, staging, and aggregate RAM too. Picture capacity failure is explicit.
   Never evict records, partially publish, or repeatedly rebuild. Explicit retry
   owns one recovery; unchanged insufficient limits pause again. Core retains facts.
5. Target p95 ordinary requests below 250 ms, ready-picture lag below one second,
   and initial load below ten seconds where the picture fits. Capacity stops pass
   pressure cases only when independently expected. Baseline picture failure is a
   qualification failure. Do not raise budgets or reduce retention to make a fixture pass.

Follow [Protocol recovery](../../shared/synchronization/contract.md) and
[SDK capacity](../../shared/synchronization/client-picture.md#capacity-and-retry). Report revision, inputs,
budgets, peaks, commands, and passed/failed/unrun cases. No fixed-baseline result
establishes qualification of cumulative turnover.
