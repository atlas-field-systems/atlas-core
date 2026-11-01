# Scenarios

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**A scenario is one JSON file that describes a simulated world.** It names the
Assets, the subjects they can detect, and, for an eval, the timeline and expected
results. An [interactive run](interactive.md) reads only `assets` and `subjects`,
so one file can serve both kinds of run.

## Example

Drone 1 starts near a road and can detect a vehicle that drives along it.

```json
{
	"name": "road-inspection",
	"assets": [
		{"alias": "Drone 1", "position": {"latitude": 51.5, "longitude": -0.1}, "cruise_speed": 15, "detection_radius": 300}
	],
	"subjects": [
		{"alias": "Vehicle 1", "route": [{"latitude": 51.501, "longitude": -0.1}, {"latitude": 51.51, "longitude": -0.09}], "speed": 8}
	],
	"timeline": [
		{"at_seconds": 5, "action": "move_to", "asset": "Drone 1", "position": {"latitude": 51.505, "longitude": -0.095}},
		{"at_seconds": 20, "action": "fault", "id": "reply-lost", "asset": "Drone 1"}
	],
	"deadline_seconds": 300,
	"expect": {
		"tasks": [{"asset": "Drone 1", "index": 0, "state": "completed"}],
		"tracks": 1
	}
}
```

## Fields

Speeds use metres per second. `detection_radius` uses metres. Aliases are unique in
one file.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | Yes | Scenario name, copied into the run record |
| `assets` | Yes | One to 100 Assets, each with `alias`, `position`, `cruise_speed`, and `detection_radius` |
| `subjects` | Yes | Up to 1,000 subjects, each with `alias`, `route`, and `speed`. The list can be empty |
| `geofeatures` | No | Up to 1,000 named Points with `alias` and `position` |
| `timeline` | Eval only | Up to 10,000 actions sorted by `at_seconds` |
| `deadline_seconds` | Eval only | Longest eval duration, at most [3,600](continuous-integration.md#runner-limits) |
| `expect` | Eval only | Hand-written results that [eval checks](evals.md#correctness-decides-pass-or-fail) compare |

`expect` holds `tasks`, `tracks`, and an optional `removed_assets` list of the Assets
that a fault deletes. A `tasks` entry can name a nonterminal state for a Task that a
fault strands.
Every `move_to` action requires exactly one `expect.tasks` entry for its Asset and
index. Missing or duplicate expectations are invalid input.

A subject follows its route once at a fixed speed and stops at the last point. A
route holds one to 1,000 points. The loader refuses more than 1,000 Asset/subject
pairs or 10,000 total route points with exit 2 before network work.

## Detection

An Asset detects a subject when the subject is inside its `detection_radius`. The
runtime creates one Observation for each Asset and subject pair, with
`source_asset_id` set to that Asset, then reports once per second while the subject
stays in range. When the subject leaves, the Observation goes silent. If the
subject returns, reports continue under the same Observation.

Each Observation therefore produces one Track under the
[default policy](../entities/tracks/tracks.md#default-policy). Two Assets that see
one vehicle produce two Tracks. Core owns that result, and the simulator never
matches subjects across Assets.

## Timeline actions

The eval runner applies each action at its time, counted from the moment that all
Assets finish their first check-in.

| Action | Extra fields | Effect |
| --- | --- | --- |
| `move_to` | `asset`, then `position` or `geofeature`, and optional Protocol `altitude` | The operator client creates a queued Task |
| `pause` | `asset` | The operator client creates a Pause Task |
| `resume` | `asset` | The operator client creates a Resume Task that expires in 30 seconds |
| `cancel` | `asset`, `index` | The operator client requests cancellation of that Asset's Task at `index` |
| `reorder` | `asset`, `indexes` | The operator client sends `tasks.setOrder` with those Tasks in that order |
| `fault` | `id`, plus any fields its [failure point](failure-points.md) needs | The fault injector applies that failure point |

`index` counts `move_to` actions for one Asset, from zero. A `core-reset` fault must
be the last action, and it runs [after the checks](evals.md#run-an-eval), not at its time.

## Time

Runs use real UTC and real elapsed time. A virtual clock cannot work, because Core
applies its own 15-second and 60-second contact windows, ten-second instruction
validity, and 60-second Resume admission. To shorten a scenario, raise `cruise_speed`
and `speed`, not the clock.

## Validation

The loader reads at most 1 MiB, parses the JSON, and validates it with a closed
schema before any network work. An unknown field, an unknown failure point, an
out-of-range value, a duplicate alias, an action that names an unknown Asset, or a
`core-reset` before the last action stops the run with exit code 2. Scenarios contain no randomness, so a correctness
difference between two runs comes from the software.

[Next: interactive runs](interactive.md)
