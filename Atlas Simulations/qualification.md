# Qualify Atlas Simulations

**The simulator must prove that it follows Protocol and that its evals can fail.**
Use Node 24.22.1 and npm 11.19.0. Build Core with the same Protocol artifact first.
Run every case against real Core HTTPS and the packed SDK.

```sh
export ATLAS_TEST_ROOT="$(mktemp -d /var/tmp/atlas-simulations.XXXXXX)"
npm run verify:inputs
npm test
```

`verify:inputs` checks the pinned tools, the lock entries, and the installed SDK
and Protocol archives against Core's Protocol hash. Keep Core installations and
logs under `ATLAS_TEST_ROOT`, outside the managed workspace. Run the shared formatter
with `node ../scripts/format.mjs --base <full-ancestor-SHA>`.

## Acceptance checklist

| Workflow | Essential failure evidence |
| --- | --- |
| Scenario loading | Oversized, malformed, and unknown-field files stop with exit 2 and no network traffic |
| Boundary | A packaging check finds no import of Core source, Core tests, or SDK tests |
| Task execution | Move To by position and by Geofeature, two queued Tasks in order, and reordering before start |
| Pause and Resume | Every [required control example](../Atlas%20Protocol/task-controls.md#required-examples) |
| Failure points | Every ID in [failure points](failure-points.md) fires in at least one scenario and meets its required result |
| Run records | A failed run still appends a record, and an unwritable history directory fails the run |
| Comparison | Two records with known values print the expected change, and a changed scenario hash is marked |
| CI result | A failed, cancelled, or missing eval group fails `record`, and a fork pull request pushes no history |
| Shutdown | SIGINT awaits writes, revokes created keys, and exits 1 with any stalled write listed |

## Prove that evals can fail

Each check in [eval runs](evals.md#correctness-decides-pass-or-fail) needs a broken
control. A control injects one defect and must fail that check.

| Injected defect | Check that must fail |
| --- | --- |
| Report the wrong final Task state | `tasks` |
| Start the second Task first | `order` |
| Omit one reading from Core | `positions` |
| Stop one report short of the target | `final_position` |
| Expect one Track too many | `tracks` |
| Name a failure point that never fires | `faults` |

Each failure point also needs one broken control that its check rejects. A separate
control removes a required check from a run, and that run must fail. Measurements
get no control, because they never affect a verdict.

## Limits of this evidence

A passing eval shows that Atlas retained correct state for one simulated workload
and the listed failures on one host. A failure that nobody listed goes untested,
so a passing suite is not proof that Atlas has no failures. It says nothing about
real flight or radio behavior. See
[Core's reporting rules](../Atlas%20Core/qualification.md#report-honestly).
It establishes no power-loss durability and no sustained workload capacity.

Report the revision, the commands, the scenario, and the passed, failed, and unrun
checks. A simulated run never fills a gap in Core or SDK qualification.

[Back to Atlas Simulations](README.md)
