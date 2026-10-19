# Telemetry

Telemetry is the complete section for an Entity's location and motion.
The [OpenAPI contract](../openapi.json) owns its exact layout. A report supplies this whole
section, including defined null values, rather than a single-value update.
The same whole-snapshot ordering applies to Asset and Track Telemetry. The source
assembles the snapshot; Core does not merge independently arriving quantities.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `position` | [Position](#position) or null | Required | Complete WGS84 coordinate pair; null when unknown |
| `altitude` | [Altitude](#altitude) or null | Required | Height with explicit reference; null when unknown |
| `ground_speed` | Number or null | Required | Horizontal metres per second, at least zero; null when unknown |
| `airspeed` | Number or null | Optional | Metres per second relative to air, at least zero; omit when not applicable |

Also include the [reported result definitions](README.md#reported-results).
Unknown readings do not imply an error. Actual failures use the shared error
representation. Body heading belongs in [Attitude](attitude.md), separately from
direction of travel.

## Position

Position is a reusable coordinate pair for Telemetry and Command inputs.
[Spatial conventions](../entities.md#spatial-conventions) establish WGS84 degrees,
complete pairs, valid zero coordinates, and double precision.

| Field | Type | Presence | Proposed bounds |
| --- | --- | --- | --- |
| `latitude` | Number | Required, non-null | -90 through 90 inclusive |
| `longitude` | Number | Required, non-null | -180 through 180 inclusive |

Numbers must be finite under [Wire](../wire.md#parsing-and-edits).
Preserve precision without rounding.

- Valid: `{"latitude": 0, "longitude": 0}`.
- Invalid latitude: `{"latitude": 91, "longitude": 0}`.
- Invalid incomplete pair: `{"latitude": 51.5074}`.

## Altitude

Altitude is a reusable height value for Telemetry and Command inputs.
[Spatial conventions](../entities.md#spatial-conventions) require metres and an
explicit `wgs84_ellipsoid` reference. AGL and MSL must not be silently substituted.

| Field | Type | Presence | Proposed meaning |
| --- | --- | --- | --- |
| `metres` | Number | Required, non-null | Finite signed metres; negative and zero are allowed |
| `reference` | String | Required, non-null | Exactly `wgs84_ellipsoid` |

Altitude has no Protocol operational height cap.
The containing field defines how unknown altitude uses null or omission.

- Valid: `{"metres": -12.5, "reference": "wgs84_ellipsoid"}`.
- Invalid reference: `{"metres": 120, "reference": "agl"}`.

## Complete section example

Valid component value:

```json
{
	"position": {"latitude": 51.5074, "longitude": -0.1278},
	"altitude": {"metres": 142.6, "reference": "wgs84_ellipsoid"},
	"ground_speed": 0,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

Omitted `airspeed` is allowed. Neither omission nor null
substitutes an older subfield value.

This fragment is an invalid replacement because required fields are missing:

```json
{"ground_speed": 0, "observed_at": "2026-10-16T12:00:00Z"}
```

## Use and decisions

A mounted camera can retain a complete Telemetry section as state until changed.
Aircraft and a commandless vehicle tracker can report it as dated measurements.
This does not require every Entity to have Telemetry.

The [`UpdateAsset`](../messaging/assets.md#updating-sections) message
carries this Asset section.

`observed_at` supplies the common original time. Optional
`position_observed_at`, `altitude_observed_at`, `ground_speed_observed_at`, and
`airspeed_observed_at` override it for their quantities. An omitted override uses
the common time; explicit null records an unknown original time. The enclosing
section carries one source sequence, including on Tracks. Longitude endpoints
retain their original values; no canonicalization occurs. Position quality and
uncertainty fields remain deferred.

[Component index](README.md)
