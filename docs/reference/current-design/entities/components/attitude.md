# Attitude

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

Attitude owns body heading, pitch, and roll relative to true north.
Gimbal describes viewing direction separately. Direction of travel is not inferred.

## Frame and fields

Use a local North-East-Down frame and intrinsic Z-Y-X Euler rotations.
Angles use degrees. A level body pointing north has all three angles zero.
The external source converts magnetic and mounting-relative measurements.

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `heading` | Number or null | Required | Forward direction clockwise from true north, 0 inclusive to 360 exclusive; 90 is east |
| `pitch` | Number or null | Required | Nose-up angle above the local horizon, -90 through 90 inclusive |
| `roll` | Number or null | Required | Rotation about the forward axis, positive right side down, -180 inclusive to 180 exclusive |

All numbers are finite. Null means unknown, including an undefined angle.
At pitch exactly -90 or 90, both heading and roll must be null. They cannot be
independently recovered from this Euler representation. Reject non-null values in
that singular case. At a geographic pole, the source reports heading null when
true north is undefined. Core does not invent a heading from an earlier reading.
Actual acquisition failures use a [section error](../reporting/evidence.md).

The complete value declares state until changed or dated measurement.
Allowed `source_times` keys are exactly `heading`, `pitch`, and `roll`.
Different quantity times remain different. One complete section is not a claim
that all three angles were measured simultaneously.

## Examples

Valid ordinary orientation:

```json
{"heading": 90, "pitch": 5, "roll": -10}
```

Valid vertical orientation:

```json
{"heading": null, "pitch": 90, "roll": null}
```

Invalid singular orientation:

```json
{"heading": 0, "pitch": 90, "roll": 0}
```

Heading 360 and roll 180 are also invalid endpoint values.

[Component index](README.md)
