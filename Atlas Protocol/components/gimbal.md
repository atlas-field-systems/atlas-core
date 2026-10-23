# Gimbal

Gimbal groups world-relative viewing bearing and elevation into one complete section.
It describes the single [exposed camera set](camera.md#exposed-hardware-ownership).
The external source converts mechanical pan and tilt through its mounting transform.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `bearing` | Number or null | Required | Viewing direction clockwise from true north, degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Viewing direction above the local horizon, degrees, -90 through 90 inclusive |

All numbers are finite. Null means unknown or undefined. At elevation exactly
-90 or 90, bearing must be null because vertical viewing has no horizontal bearing.
Reject a non-null bearing in that singular case. Where true north is undefined,
the source reports bearing null rather than inventing a direction.
Actual acquisition failures use a [section error](../report-evidence.md).

The result declares state until changed or dated measurement.
Allowed `source_times` keys are exactly `bearing` and `elevation`.
If the angles have different times, retain those times. Do not imply a simultaneous
pointing measurement. Live zoom belongs in [Camera](camera.md), and baseline FOV
belongs in [Camera Optics](camera-optics.md).

## Examples

Valid pointing:

```json
{"bearing": 135, "elevation": -10}
```

Valid downward vertical pointing:

```json
{"bearing": null, "elevation": -90}
```

Invalid because elevation is missing:

```json
{"bearing": 135}
```

[Component index](README.md)
