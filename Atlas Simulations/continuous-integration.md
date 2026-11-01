# Continuous integration

**CI is the main place evals run.** Every pull request commit and every push to
`main` starts a real Core container and real simulated Assets, runs every scenario,
and records the result. Local runs use the same commands, but nothing depends on them.

## When it runs

`.github/workflows/simulations.yml` runs on every pull request commit, every push to
`main`, and manual dispatch on any branch. It does not cancel older runs, because a
cancelled run leaves a commit with no record. Standard GitHub-hosted runners are
free for this public repository.

## Jobs

| Job | Work |
| --- | --- |
| `build` | Build the pinned Protocol, SDK, Core image, and simulator once, and upload them |
| `eval` | Load those artifacts, then run one eval group on one runner |
| `publish` | Append the new run records to `eval-history`, except on a fork pull request |
| `record` | Compare the records, write the job summary, and decide the final result |

`record` always runs. It fails if any group failed, was cancelled, or produced no
record, or if `publish` failed, so a skipped eval can never look like a pass. `record` is the required check
for evals. `eval` uses `fail-fast: false`, so one failure does not hide others.

Each group runs its scenarios in order, each with a fresh Core installation under
`$RUNNER_TEMP`. Groups run in parallel on separate runners.

| Group | Contents |
| --- | --- |
| `missions` | Normal multi-Asset missions with no injected failure |
| `ip` | [IP and responses](failure-points.md#ip-and-responses) |
| `core-process` | [Core process](failure-points.md#core-process) |
| `capacity` | [Capacity](failure-points.md#capacity) |
| `credentials` | [Credentials and Datasets](failure-points.md#credentials-and-datasets) |
| `tasks` | [Tasks](failure-points.md#tasks) |
| `evidence` | [Evidence](failure-points.md#evidence) |

## Runner limits

| Limit | Plan |
| --- | --- |
| 60 minutes for each `eval` job | A job that reaches this limit fails. Split a group that gets close |
| 3,600 seconds for each scenario | `deadline_seconds` cannot exceed this limit |
| 4 vCPUs, 16 GB of memory, and 14 GB of SSD | Scenarios target this hardware, not the [workload baseline](../Atlas%20Core/workload-qualification.md#selected-baseline-targets) |
| Fresh machine for each job | Nothing persists between jobs, except artifacts and history |

Core's default 8 GB free-disk headroom is too close to a 14 GB disk, so evals start
Core with the checked-in `settings/eval.json`. Each run record includes its hash.
Eight-hour workload runs do not fit in CI and stay unrun.

## History

Run records live on the `eval-history` branch, which shares no commits with `main`
and is never merged. This design needs no external service and no extra secret.

`publish` is the only job with write access. It checks out only `eval-history`, runs
no code from the pull request or from an artifact, and treats each record as data.
It refuses a record above 256 KiB, so the branch stays small enough to keep forever.
Anyone who can edit the workflow file already has write access, so this boundary
protects against build and scenario output.

`publish` commits the records and pushes them. If another run pushed first, it pulls
and retries. A pull request from a fork has a read-only token, so its records stay as
artifacts for seven days, along with logs and failure evidence.

| Record field | Contents |
| --- | --- |
| Source | Branch, full commit, dirty state, and Protocol, SDK, and Core versions |
| Environment | Core image ID, Node version, CPU model and count, memory, and kernel |
| Input | Scenario name, scenario SHA-256, and Settings SHA-256 |
| Result | Verdict, every check, and the failure reason |
| Measurements | The [recorded groups](evals.md#performance-is-recorded) and cleanup evidence |

The file path is `SCENARIO/UTC-TIME-SHORT-SHA-RUN-ATTEMPT.json`, with GitHub's run ID
and attempt number, so paths cannot clash. Nothing edits or deletes a record, and a
failed run also adds one. Comparison streams the archive with bounded directory
buffers, 16 nested directories, and retained results. Traversal time grows with history.

## Compare versions

Each pull request's job summary compares its records with the median of the newest
ten `main` records for each scenario. It shows each verdict, each measurement, and
its percentage change. A performance change never fails the check. Only correctness
does. Runners can differ in hardware, so the median reduces noise from one run, and
the summary marks a pair when the CPU model or an input hash differs.

To test any branch, run the workflow manually on that branch. To compare two refs
yourself, check out the history and run the comparison:

```sh
git worktree add /var/tmp/atlas-eval-history eval-history
ATLAS_EVAL_HISTORY=/var/tmp/atlas-eval-history npm run eval:compare -- main t3/my-branch
```

This command exits 1 only if a scenario passed on the first side and failed on the second.

[Next: qualification](qualification.md)
