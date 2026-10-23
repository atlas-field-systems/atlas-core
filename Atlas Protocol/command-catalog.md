# Initial Command Catalog

The local Protocol artifact defines exactly `move_to`, `pause`, and `resume`.
An Asset's capabilities advertise a subset with the scheduling choices below.
Unsupported Commands or scheduling choices return `422 unsupported_command`.
There is no immediate Move To, area-search Command, or integration-defined Asset Command.

## Task creation fields

`CreateTask` requires `request_id`, `task_id`, `asset_id`, `command`, `scheduling`,
and `inputs`. IDs are stable UUIDs prepared before submission. These fields and
the Command's validity facts are retry facts. `scheduling` is exactly `queued`
for Move To and `immediate` for Pause and Resume. Inputs are closed objects.
Core adds `accepted_at` and the per-Asset `submission_sequence`.

## Move To

`move_to` requires `inputs.target`, with exactly one alternative:

| `target.kind` | Required fields | Meaning |
| --- | --- | --- |
| `position` | `position` | Complete [Position](components/telemetry.md#position) |
| `geofeature` | `geofeature_id` | Existing Geofeature with Point geometry |

Optional `inputs.altitude` is the shared [Altitude](components/telemetry.md#altitude),
non-null when supplied. Omission requests no explicit altitude change. Position
and Geofeature targets use that same rule. No `expires_at` is allowed.
Resource Type or purpose does not change the required Point shape.

Geofeature inputs retain the ID. Geometry edits follow
[the live-reference rules](entities.md#geometry-and-references), not a copied target.
The runtime reports the geometry revision actually used when known.

Valid coordinate inputs:

```json
{
	"target": {"kind": "position", "position": {"latitude": 51.5, "longitude": -0.1}},
	"altitude": {"metres": 120, "reference": "wgs84_ellipsoid"}
}
```

## Pause

`pause` requires empty `inputs: {}` and has no expiry. Applying it suspends queued
execution and gates future queued starts, including when the queue is empty.
It preserves requested order. The Asset reports completion only after the gate
and any required suspension have taken effect. This is not an emergency stop.

## Resume

`resume` requires empty `inputs: {}` and a top-level `expires_at` timestamp.
At first admission it must be later than Core's current UTC and at most 60 seconds
ahead. Retries recover original acceptance before checking that admission window.
The runtime must satisfy [fresh instruction reconciliation](task-controls.md#fresh-resume)
before unpausing and before `expires_at`. Expiry never authorizes an older Resume.

Resume continues a remaining paused Task first. If that Task ended or was cancelled,
it starts the next eligible queued Task. It can clear the gate on an empty queue.
Failure to resume the remaining paused Task fails that Task and Resume, and keeps
the gate paused. Pending cancellation must resolve before resumption.
When already running, the same fresh reconciliation completes Resume with
`queue_state: "running"`, without restarting or reordering work.

[Tasks](tasks.md)
