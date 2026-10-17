# Telemetry

Telemetry is the proposed complete section for an Entity's location and motion.
The name and exact field layout remain proposals. A report supplies this whole
section, including defined null values, rather than a single-value update.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `position` | [Position](#position) or null | Required | Complete WGS84 coordinate pair; null when unknown |
| `altitude` | [Altitude](#altitude) or null | Required | Height with explicit reference; null when unknown |
| `ground_speed` | Number or null | Required | Horizontal metres per second, at least zero; null when unknown |
| `airspeed` | Number or null | Optional | Metres per second relative to air, at least zero; omit when not applicable |

Also include the [shared proposed section fields](README.md#shared-proposed-section-fields).
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

The object layout and absence of an operational height limit remain proposals.
The containing field defines how unknown altitude uses null or omission.

- Valid: `{"metres": -12.5, "reference": "wgs84_ellipsoid"}`.
- Invalid reference: `{"metres": 120, "reference": "agl"}`.

## Complete section example

Valid under the proposed field contract:

```json
{
	"position": {"latitude": 51.5074, "longitude": -0.1278},
	"altitude": {"metres": 142.6, "reference": "wgs84_ellipsoid"},
	"ground_speed": 0,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

Omitted `airspeed` is allowed by this proposal. Neither omission nor null
substitutes an older subfield value.

This fragment is an invalid replacement because required fields are missing:

```json
{"ground_speed": 0, "observed_at": "2026-10-16T12:00:00Z"}
```

## Use and decisions

A mounted camera can retain a complete Telemetry section as state until changed.
Aircraft and a commandless vehicle tracker can report it as dated measurements.
This does not require every Entity to have Telemetry.

The proposed [`UpdateAsset`](../messaging/assets.md#updating-sections) message
carries this Asset section.

Settle the section name, required nullable fields, optional airspeed, and source-time
layout. A single section timestamp must not conceal older constituent readings.
Longitude endpoint canonicalization and Altitude's object layout remain open.
Uncertainty fields and exact Track field applicability remain undefined.

[Component index](README.md)
