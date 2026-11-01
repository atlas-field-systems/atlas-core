# Bearing Measurement

Bearing Measurement records one direction from a sensor toward a detected subject
at one moment. It states where the subject was seen from, not where the subject is.
Observations report it. Assets and Tracks refuse it.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `sensor_origin` | Object | Required, non-null | Sensor location at the measurement time |
| `sensor_origin.position` | [Position](telemetry.md#position) or null | Required | Null when unknown |
| `sensor_origin.altitude` | [Altitude](telemetry.md#altitude) or null | Required | Null when unknown |
| `bearing` | Number or null | Required | Direction clockwise from true north, degrees, 0 inclusive to 360 exclusive |
| `elevation` | Number or null | Required | Direction above the local horizon, degrees, -90 through 90 inclusive |
| `bearing_interval` | Object | Optional, non-null | Exactly `start` and `end`, each bounded as `bearing` |
| `elevation_interval` | Object | Optional, non-null | Exactly `lower` and `upper`, each bounded as `elevation` |

All numbers are finite. Null means unknown or undefined, and zero means north or
the horizon. At least one angle is a number. The source converts device-relative
pointing to these world-relative angles before reporting.

## Undefined bearing

Bearing must be null at elevation exactly -90 or 90, because a vertical direction
has no horizontal bearing. Bearing must also be null when `sensor_origin.position`
is at latitude -90 or 90, because true north is undefined there. Elsewhere, a source
that cannot establish true north reports null rather than inventing a direction.

## Sensor origin

`sensor_origin` is the source's own record of where the sensor was at the measurement
time. Position and altitude are independent, so either can be null alone. Unknown
location stays null. Current source Asset Telemetry never fills it, and later Asset
movement never changes it.

## Intervals

Intervals are closed bounds asserted by the source, not statistical confidence.
An interval requires its non-null angle and must contain it.

`bearing_interval` runs clockwise from `start` through `end`. It crosses north when
`start` exceeds `end`. Equal endpoints contain exactly that angle, never the full
circle. `elevation_interval` requires `lower` at most `upper`, and it does not wrap.

| `bearing_interval` | Contains | Excludes |
| --- | --- | --- |
| `{"start": 350, "end": 10}` | 350, 359.5, 0, 10 | 349, 11, 180 |
| `{"start": 20, "end": 30}` | 20, 25, 30 | 10, 31 |
| `{"start": 10, "end": 10}` | 10 | Every other angle |

Omit an interval when uncertainty is unknown. Null is refused. A zero-width interval
asserts an exact angle, so omission and zero width differ. An elevation interval can
reach -90 or 90. Only a vertical `elevation` value requires a null bearing.

## Section result

The section is one dated measurement. `classification` is always `dated_measurement`,
including on errors and withdrawals. `observed_at` is the original time of the whole
measurement, and null means unknown. `source_times` is refused even when empty, because
the origin and angles have no separate times. Every read result has one `time_status`
string under [report format](../report-format.md#complete-section-results).

Reports replace the current section under [evidence admission](../report-evidence.md).
Direction alone creates no target Telemetry, Attitude, Geometry, or position history.
The [default policy](../tracks.md#default-policy) does not copy this section to Tracks.
There is no bearing history query. Confidence, covariance, range, per-device
calibration, and inferred target position or attitude are unsupported.

## Examples

Valid north-crossing sighting from a known location:

```json
{"state": "value", "classification": "dated_measurement", "observed_at": "2026-10-21T12:00:00.0000001Z",
 "value": {"sensor_origin": {"position": {"latitude": 51, "longitude": -1}, "altitude": {"metres": 0, "reference": "wgs84_ellipsoid"}},
  "bearing": 0, "elevation": 12, "bearing_interval": {"start": 350, "end": 10}, "elevation_interval": {"lower": 10, "upper": 15}}}
```

Valid vertical sighting with unknown time and location:

```json
{"state": "value", "classification": "dated_measurement", "observed_at": null,
 "value": {"sensor_origin": {"position": null, "altitude": null},
  "bearing": null, "elevation": 90, "elevation_interval": {"lower": 90, "upper": 90}}}
```

Invalid value, because bearing 180 lies outside the north-crossing arc:

```json
{"sensor_origin": {"position": null, "altitude": null}, "bearing": 180, "elevation": 0,
 "bearing_interval": {"start": 350, "end": 10}}
```

[Component index](README.md)
