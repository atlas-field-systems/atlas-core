# Run the Atlas experiments

These disposable prototypes investigate the documented design at commit `1ca5623`.
They are instruments for finding implementation traps, not an Atlas server or SDK.
The findings link to that historical design. Current Protocol, Core, and SDK pages
define the supported contracts. The SDK remains unimplemented.

## Run

Use Python 3.12 and Node 24 on Linux. No third-party packages are required.

```sh
env TMPDIR=/tmp python3 prototypes/flight-lab/run.py
```

Use the short `/tmp` directory because long Unix socket paths fail in deep harness
temporary directories. The command prints results and its evidence directory.
A missing runner, unexpected failed observation, process failure, or invalid output
makes the command exit nonzero. Deliberately broken controls pass only when the
experiment observes their expected failure.
The checked-in [case manifest](case-manifest.json) lists every required observation;
missing or unexpected cases fail the run. Verify this gate with
`python3 prototypes/flight-lab/test_run.py`.

Run one experiment or choose a new evidence directory.

```sh
env TMPDIR=/tmp python3 prototypes/flight-lab/run.py wire
env TMPDIR=/tmp python3 prototypes/flight-lab/run.py --out /tmp/atlas-flight-rerun
```

The output directory must not exist. Each run records source hashes, environment,
raw stdout, stderr, and the combined result. Runtime children and files belong to
their individual experiment. The parent enforces a 120-second limit per runner.
It drains stdout and stderr while the runner executes and retains at most 8 MiB
in each log. Overflow or timeout fails the run and stops the runner's process group.
When the leader exits, the parent stops remaining descendants and drains buffered
output before validating it. Evidence comparison ignores object member order and
preserves array order and JSON types. Booleans differ from numbers; finite `1` and
`1.0` match. Nonfinite numbers fail validation.

## Read the results

Read [the findings](report.md) first. The evidence directory named in that report
contains the observed values and independent expected values for every case.

The four runners investigate retry and execution recovery, synchronization,
Object publication, and wire decoding. Their private schemas are experiment
fixtures. They do not define public endpoints or fill gaps in Protocol.

Python mechanisms did not qualify the then-planned Go server or the current TypeScript Core. Process termination
cannot qualify power-loss durability. Docker management, physical execution,
constrained radio, and the full deployment workload need separate qualification.
