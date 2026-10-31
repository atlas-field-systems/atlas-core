# Eval runs

**An eval passes or fails, and every run records how Atlas performed.** Atlas is
deterministic, so correctness has one right answer and no score. Performance and
resource use vary between runs, so they are recorded for comparison and never
change a verdict.

## Run an eval

[CI](continuous-integration.md) runs every eval on every commit. To run them locally,
use these commands from `Atlas Simulations`, with a built Core and its pinned image.
Keep both directories outside the repository.

```sh
export ATLAS_TEST_ROOT="$(mktemp -d /var/tmp/atlas-simulations.XXXXXX)"
export ATLAS_EVAL_HISTORY="$ATLAS_TEST_ROOT/history"
npm run eval -- --all
```

Use `--group NAME` or `--scenario FILE` to run less. Each scenario runs in this order:

1. Create a Core installation under `ATLAS_TEST_ROOT` with
   [`setup` and `start`](../Atlas%20Core/lifecycle.md#commands) and `settings/eval.json`.
2. Start every Asset and wait for each first check-in.
3. Apply the timeline through one operator client in SDK Full mode.
4. Wait until every Task is terminal and no action remains, or until `deadline_seconds`.
5. Check correctness through a new SDK HTTP client.
6. Stop Core, verify that it stopped, and append the run record.

## Correctness decides pass or fail

Each check compares three separate sources.

| Source | Contents | Owner |
| --- | --- | --- |
| `expect` and `timeline` | Hand-written results and targets | The scenario author |
| Truth log | Every reading, `tags` report, and Task report that the simulator produced | The World and the Asset runtime |
| Core reads | Tasks, Assets, Tracks, Observations, and position history | Core, read after the run |

Write `expect` by reasoning about the scenario. Never copy it from a run's output,
because then a broken implementation approves itself. Values compare exactly, with
no tolerance.

| Check | Passes when |
| --- | --- |
| `tasks` | Each Task's final state matches `expect` and the truth log |
| `order` | The Tasks ran in the requested order, and queued work stayed blocked while paused |
| `positions` | Every produced reading appears exactly once in Core history |
| `final_position` | Core's position equals the last truth-log reading, and equals the target when the Asset's last Task completed |
| `tracks` | The Track count matches `expect`, and each Track names its source Observation |
| `tags` | Each Asset's first report carried `simulated`, and each Asset that Core still holds has the Tags from its last `current` `tags` report |
| `faults` | Every `fault` action fired and its [required result](failure-points.md) held |

A scenario passes only when every check ran and passed and cleanup is verified. A
check that cannot run, a passed deadline, or a failed setup is a failure, and the
record says why. `npm run eval` exits 0 if every scenario passed and 1 otherwise.

## Performance is recorded

Each record holds these measurements. Timings come from SDK Summary observers.

| Group | Measurements |
| --- | --- |
| Run | Duration, requests, and accepted reports |
| Latency | p50, p95, and p99 for each exchange |
| Picture | Initial load time and p95 lag behind committed writes |
| Core resources | CPU time, peak memory, and final SQLite, WAL, and installation bytes |
| Simulator resources | CPU time and peak memory, so that its own cost stays visible |

A `docker stats` sample each second supplies Core CPU and memory. Evals do not replace
[workload qualification](../Atlas%20Core/workload-qualification.md), which fixes its
own hardware, payloads, and durations.

Every run becomes a permanent record. [Continuous integration](continuous-integration.md)
owns the record format, the history, and version comparison.

[Next: failure points](failure-points.md)
