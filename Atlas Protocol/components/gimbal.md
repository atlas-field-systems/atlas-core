# Gimbal

Gimbal groups bearing and elevation into one complete pointing section.
Whole-section reporting is agreed. The fields and coordinate frame below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bearing` | Number or null | Required | Viewing direction clockwise from true north, in degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Viewing direction above the local horizon, in degrees, -90 through 90 inclusive |

The enclosing result carries [shared section metadata](README.md#shared-section-results).
Propose null for an unknown required angle. Actual failures need error information
rather than a silent unknown reading.

The proposed angles describe world-relative viewing direction. Raw mechanical
pan and tilt coordinates would require an explicit mounting transform.
Live zoom belongs in [Camera](camera.md). Baseline field of view belongs in
[Camera Optics](camera-optics.md).

## Examples

Valid Gimbal value under the proposed field contract:

```json
{
	"bearing": 135,
	"elevation": -10
}
```

Invalid as a section replacement because elevation is missing:

```json
{"bearing": 135}
```

[Component index](README.md)
