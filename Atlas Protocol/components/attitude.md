# Attitude

Attitude owns body heading, pitch, and roll in a frame aligned to true north.
Heading belongs here rather than in Telemetry. Gimbal bearing describes the
camera's viewing direction, which can differ from the body's heading.
The angle representation, bounds, and null choices below are proposals.

## Proposed frame and fields

Use a local North-East-Down frame aligned to true north, with heading, pitch, and roll
Euler rotations in intrinsic Z-Y-X order. Angles use degrees. A level body pointing
north has zero heading, pitch, and roll. Magnetic or mounting-relative readings
must be converted by the external source before submission.

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `heading` | Number or null | Required | Body forward direction clockwise from true north, 0 inclusive to 360 exclusive; 90 is east |
| `pitch` | Number or null | Required | Nose-up angle above the local horizon, -90 through 90 inclusive |
| `roll` | Number or null | Required | Rotation about the forward axis, positive right side down, -180 inclusive to 180 exclusive |

All numbers are finite. Null means the angle is unknown. Actual measurement
failures use the [shared section error representation](README.md#shared-proposed-section-fields).
Include the shared `observed_at` field and report the complete Attitude section.
The source declares state until changed or dated measurement under [Entity rules](../entities.md#reported-sections).

True north defines the horizontal reference. Pitch and roll are tilt angles in
that frame, not separate compass bearings. Direction of travel is a different
quantity. Attitude does not infer it from heading.

## Examples

Valid under the proposed field contract:

```json
{
	"heading": 90,
	"pitch": 5,
	"roll": -10,
	"observed_at": "2026-10-17T12:00:00Z"
}
```

Invalid because 360 is outside the proposed heading interval:

```json
{
	"heading": 360,
	"pitch": 0,
	"roll": 0,
	"observed_at": "2026-10-17T12:00:00Z"
}
```

## Decisions to settle

Confirm the Euler convention and behavior at vertical orientations, where heading
and roll are not independently determined. Angle readings from different times
must retain those times rather than imply one coherent new orientation.

[Component index](README.md)
