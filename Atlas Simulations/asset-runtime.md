# Simulated Asset runtime

**A simulated Asset behaves like an external Asset runtime with no hardware.** It
follows every Protocol rule that a real runtime follows. Only movement and detection
come from the [World](README.md#ownership) instead of sensors and motors.

## Identity

Each simulated Asset owns one SDK HTTP client and its own API key. The runtime
prepares registration through `reporting.register` and advertises these capabilities:

| Command | Scheduling |
| --- | --- |
| `move_to` | `queued` |
| `pause` | `immediate` |
| `resume` | `immediate` |

Core keeps aliases unique, and Assets from earlier runs stay until Reset. The run
therefore adds its four-character run ID to each alias, so `Drone 1` becomes
`Drone 1 a1b2`. Scenarios and eval records use the scenario alias.

Core refuses [Tags](../Atlas%20Protocol/components/tags.md) in registration, so the
Asset has none until its first report. The runtime sends that `current` report
through `reporting.asset` with the start position and `{presets: ["simulated"]}`,
classified `state_until_changed`. Later reports omit `tags`, which keeps the set.

## State lives in memory

An Asset's identity, sequences, control revision, gate, active Task, and position
last only as long as its process. Protocol's [durable revision](../Atlas%20Protocol/task-controls.md)
and [sequence](../Atlas%20Protocol/observations.md#reports-and-movement) rules hold,
because a simulated Asset never outlives its process. A new run registers new Assets.

## Timers

The runtime starts these timers after Core accepts the first report, so no Asset
takes a Task untagged. It stops them before it closes its client.

| Timer | Interval | Work |
| --- | --- | --- |
| Instructions | 1 second | Read `tasks.assigned` and apply the actions below |
| Contact | 5 seconds | Run `assets.contact` and send a current check-in |
| Position | 0.5 seconds | Send new telemetry through `reporting.asset` |
| Movement | 0.1 seconds | Advance the World by elapsed time |

The five-second contact timer keeps a reachable Asset inside the `healthy` window
defined by [contact rules](../Atlas%20Protocol/reports.md#time-and-contact).

## Task actions

[Tasks](../Atlas%20Protocol/tasks.md) and
[controls](../Atlas%20Protocol/task-controls.md) own the rules. This table states
what the runtime does when it observes each condition.

| Condition | Action |
| --- | --- |
| New `task_queue.revision` | Adopt the order and send `tasks.confirmOrder` |
| No active Task, gate running, queue not empty | Start the first ID, report `in_progress`, and begin moving |
| Arrival | Send the exact target as the final position, then report `completed` |
| Cancellation requested before arrival | Hold position if the Task is active, then report `cancelled` with the request ID |
| Pause requested | Stop moving, set the gate, report the active Task as `paused`, and complete the Pause |
| Resume requested | Run the [fresh Resume checks](../Atlas%20Protocol/task-controls.md#fresh-resume), then continue and complete the Resume |
| Fresh Resume checks fail | Keep the gate paused and read again while the Resume is valid |
| Resume expired or superseded | Keep the gate paused and report `failed` with `expired` or `superseded` |
| Command not supported | Report `failed` with `unsupported` |

An arrival that happens before the runtime reads a cancellation request reports
`completed`. Protocol allows that outcome, and it tests the race that operators see.

## Move To

The Asset flies a straight great-circle line at its `cruise_speed`. It arrives when
one movement step would reach the target. The World sets altitude directly from
`inputs.altitude` when the Task supplies one.

For a Geofeature target, the runtime reads the point once when the Task starts and
keeps that revision. It reports the revision as `geometry_revision`. A later edit
does not divert the Asset. Protocol [leaves that choice to the Asset](../mission-example.md#edit-a-waypoint).

## Failure behavior

| Failure | Behavior |
| --- | --- |
| `unknown_outcome` | [Retry the same prepared operation](../Atlas%20SDK/requests.md#retry-deliberately) with capped backoff. Never repeat movement |
| Core unreachable | Keep moving and keep retrying each write with capped backoff |
| Core Restart | Keep executing and check in again. The `core_run_id` change starts fresh reads |
| Dataset invalidated | Stop this Asset's traffic and tell the Run. Never register again by itself |
| API key rejected | Stop this Asset's traffic and tell the Run. Do not try another key |

The Run decides what a stopped Asset means. In an interactive run, it stops the run
and exits 1. In an eval, an active [failure point](failure-points.md) can expect that
stop, and the check records it. Any other stop fails the eval.

[Next: scenarios](scenarios.md)
