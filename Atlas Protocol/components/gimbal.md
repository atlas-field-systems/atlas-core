# Gimbal

**Gimbal groups bearing and elevation into one complete pointing section.**
Whole-section reporting is agreed. The fields and coordinate frame below are proposals.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bearing` | Number or null | Required | Viewing direction clockwise from true north, in degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Viewing direction above the local horizon, in degrees, -90 through 90 inclusive |
| `zoom_ratio` | Number or null | Optional | Camera magnification relative to the declared 1x baseline, at least 1 |

Also include the [shared proposed section fields](README.md#shared-proposed-section-fields).
Propose null for an unknown required angle and omission of zoom on hardware
without zoom. A zoom-capable source's unknown zoom could be null. Actual failures
need error information rather than a silent unknown reading.

The proposed angles describe world-relative viewing direction. Raw mechanical
pan/tilt coordinates would require an explicit mounting transform.
Baseline field of view belongs in [Camera Optics](camera-optics.md).

## Examples

Valid under the proposed field contract, with a healthy section omitting `error`:

```json
{
	"bearing": 135,
	"elevation": -10,
	"zoom_ratio": 2,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

Invalid as a section replacement because elevation is missing:

```json
{"bearing": 135, "observed_at": "2026-10-16T12:00:00Z"}
```

## Decisions to settle

Confirm the angle frame and bounds. Decide whether camera zoom belongs here or
in a separate Camera section. Including it here keeps the camera's pointing and
zoom state together; a separate section also fits cameras without a gimbal.
No roll, angular-rate, actuator-health, or control-mode fields are defined yet.

[Component index](README.md)
