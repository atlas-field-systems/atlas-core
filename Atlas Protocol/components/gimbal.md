# Gimbal

Gimbal groups bearing and elevation into one complete pointing section.
Whole-section reporting is agreed. The fields and coordinate frame below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bearing` | Number or null | Required | Viewing direction clockwise from true north, in degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Viewing direction above the local horizon, in degrees, -90 through 90 inclusive |

Also include the [shared proposed section fields](README.md#shared-proposed-section-fields).
Propose null for an unknown required angle. Actual failures need error information
rather than a silent unknown reading.

The proposed angles describe world-relative viewing direction. Raw mechanical
pan and tilt coordinates would require an explicit mounting transform.
Live zoom belongs in [Camera](camera.md). Baseline field of view belongs in
[Camera Optics](camera-optics.md).

## Examples

Valid under the proposed field contract, with a healthy section omitting `error`:

```json
{
	"bearing": 135,
	"elevation": -10,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

Invalid as a section replacement because elevation is missing:

```json
{"bearing": 135, "observed_at": "2026-10-16T12:00:00Z"}
```

## Decisions to settle

Confirm angle bounds and the representation of unknown readings and errors.
Raw mechanical pan and tilt readings still need conversion to this proposed
world-relative representation.

[Component index](README.md)
