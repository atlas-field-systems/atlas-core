# Gimbal

Gimbal groups bearing and elevation into one complete pointing section.
Whole-section reporting is agreed. [OpenAPI](../openapi.json) owns the fields and bounds.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bearing` | Number or null | Required | Viewing direction clockwise from true north, in degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Viewing direction above the local horizon, in degrees, -90 through 90 inclusive |

Also include the [reported result definitions](README.md#reported-results).
Propose null for an unknown required angle. Actual failures need error information
rather than a silent unknown reading.

The angles describe world-relative viewing direction. Raw mechanical
pan and tilt coordinates would require an explicit mounting transform.
Live zoom belongs in [Camera](camera.md). Baseline field of view belongs in
[Camera Optics](camera-optics.md).

## Examples

Valid Gimbal value:

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

[Component index](README.md)
