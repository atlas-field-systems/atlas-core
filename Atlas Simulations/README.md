# Atlas Simulations

**Atlas Simulations runs simulated Assets through the whole Atlas stack.** Simulated
Assets register, read Tasks, move, detect subjects, and report through the SDK. Nothing
flies. These pages define the intended behavior. No simulator code exists yet.

## Two kinds of run

Both kinds of run use one [Asset runtime](asset-runtime.md) and one
[scenario format](scenarios.md). They differ in who issues Tasks and how a run ends.

| | [Interactive run](interactive.md) | [Eval run](evals.md) |
| --- | --- | --- |
| Issues Tasks | An operator, through Atlas Mission or another SDK client | The scenario timeline |
| Core | An existing installation that you name | A fresh installation that the run owns |
| Ends | When you stop it | When the timeline settles or its deadline passes |
| Produces | Live Assets and Tracks in Core | Pass or fail, plus a recorded performance history |

Task handling never depends on the kind of run. A Move To sent by a person and a
Move To sent by a timeline reach the same runtime through the same public reads.

## Whole stack

Every eval exercises all three layers with their real artifacts.

| Layer | What runs |
| --- | --- |
| Protocol | The hash-pinned package, validating at both SDK and Core boundaries |
| SDK | The packed `@atlas/sdk`, with HTTP mode for Assets and Full mode for the operator |
| Core | The pinned container image, with real HTTPS, WSS, SQLite, and local commands |

Evals inject as many [failure points](failure-points.md) as the public boundaries
can reach. Overlap with Core and SDK tests is deliberate. Those suites prove each
behavior in isolation, and an eval proves it during live traffic across all layers.

## Boundary

Simulations is an independent integration, like a gateway or an Asset runtime. It
is a consumer of Core, not a fourth layer. It imports no Core source, Core test
helper, or SDK test harness. Eval runs reach Core only through public HTTPS and
WSS, the documented [local commands](../Atlas%20Core/lifecycle.md#commands), and
Docker control of the Core container.

Simulated Assets carry the `simulator` Asset tag. Tags are a general Asset feature
that Protocol will own, and they do not exist yet. Core gives this tag no special
behavior. There is no development mode, and Core never skips a rule for a simulated
Asset. If a simulation needs a behavior that Protocol lacks, change Protocol first.

## Ownership

| Owner | Responsibility |
| --- | --- |
| Scenario loader | Read, bound, and validate one scenario file before any network work |
| World | Hold simulated positions and advance Assets and subjects |
| Asset runtime | Own one Asset's client, timers, memory state, and reports |
| Fault injector | Own the HTTPS proxy and apply each failure point |
| Run | Own the process, start and stop every runtime, and await their cleanup |
| Eval runner | Own one Core installation, the timeline, the checks, and the run record |

One Node.js process owns one run. An unexpected fatal error in one Asset stops the
whole run, because a partly running simulation hides the fault that stopped it.

## Scope

The initial release covers the [Command Catalog](../Atlas%20Protocol/command-catalog.md)
as it stands today: `move_to`, `pause`, and `resume`. Assets use direct IP. Subjects
follow fixed routes, and detection uses a fixed radius.

The initial release excludes gateways, radio and link-outage models, wind, batteries,
sensor noise, simulator restart recovery, Object uploads, and a user interface.
Operator screens belong to Atlas Mission.

`Atlas SDK/test/mission.test.mjs` stays where it is and does not use this runtime.
It is an independent check of SDK workflows, and a shared runtime could let both
sides agree on one mistake.

## Reading order

[Asset runtime](asset-runtime.md) → [Scenarios](scenarios.md) →
[Interactive runs](interactive.md) → [Eval runs](evals.md) →
[Failure points](failure-points.md) → [Qualification](qualification.md).

The [mission example](../mission-example.md) describes the operator workflow that a
simulated Asset must support. Task, control, and report rules stay in
[Protocol](../Atlas%20Protocol/README.md).
