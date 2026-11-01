# Telemetry

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

Telemetry is the complete section for an Entity's location and motion.
A report supplies the whole section, including defined null values. The source
assembles it without Core merging quantities. Default Tracks retain its source evidence.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `position` | [Position](#position) or null | Required | Complete WGS84 coordinate pair; null when unknown |
| `altitude` | [Altitude](#altitude) or null | Required | Height with explicit reference; null when unknown |
| `ground_speed` | Number or null | Required | Horizontal metres per second, at least zero; null when unknown |
| `airspeed` | Number or null | Optional | Metres per second relative to air, at least zero; omit when not applicable |

Use [shared section metadata](README.md#shared-section-results) and its error result
for acquisition failures. Body heading belongs in [Attitude](attitude.md).

## Position

Position is a reusable coordinate pair for Telemetry and Command inputs.
[Spatial conventions](../structure.md#spatial-conventions) establish WGS84 degrees,
complete pairs, valid zero coordinates, and double precision.

| Field | Type | Presence | Bounds |
| --- | --- | --- | --- |
| `latitude` | Number | Required, non-null | -90 through 90 inclusive |
| `longitude` | Number | Required, non-null | -180 through 180 inclusive |

Numbers must be finite under [Wire](../../shared/http/wire.md#parsing-and-edits).
Preserve binary64 precision without decimal truncation. Accept and retain both
longitude endpoint spellings, `-180` and `180`, without canonicalizing either.

- Valid: `{"latitude": 0, "longitude": 0}`.
- Invalid latitude: `{"latitude": 91, "longitude": 0}`.
- Invalid incomplete pair: `{"latitude": 51.5074}`.

## Altitude

Altitude is a reusable height value for Telemetry and Command inputs.
[Spatial conventions](../structure.md#spatial-conventions) require metres and an
explicit `wgs84_ellipsoid` reference. AGL and MSL must not be silently substituted.

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `metres` | Number | Required, non-null | Finite signed metres; negative and zero are allowed |
| `reference` | String | Required, non-null | Exactly `wgs84_ellipsoid` |

- Valid: `{"metres": -12.5, "reference": "wgs84_ellipsoid"}`.
- Invalid reference: `{"metres": 120, "reference": "agl"}`.

## Value examples

Valid complete Telemetry value:

```json
{
	"position": {"latitude": 51.5074, "longitude": -0.1278},
	"altitude": {"metres": 142.6, "reference": "wgs84_ellipsoid"},
	"ground_speed": 0
}
```

This fragment is an invalid replacement because required fields are missing:

```json
{"ground_speed": 0}
```

## Use and source times

Telemetry is optional on Assets, Observations, and derived Tracks. A mounted camera
can retain state until changed. Moving sources can report dated measurements.
The `source_times` keys are exactly `position`, `altitude`, `ground_speed`, and
supplied `airspeed`. Position is one quantity, not separate coordinate times.
Explicit null means unknown time. A new snapshot cannot refresh older readings.

## Constituent reading identity

Every supplied Telemetry quantity, including a null value, carries the exact
`constituents` evidence defined in [report format](../reporting/format.md).
A constituent identifies a reading, not the Observation Entity. Position has one
identity for the complete pair. Its value and source time are immutable.
Tracks retain original Observation scopes. Whole-section ordering stays separate.

| Later complete snapshot | Required history outcome |
| --- | --- |
| Sequence 11 repeats position P1, value, and source time null while adding new speed | No extra position reading or fresh position age |
| Sequence 12 uses new P2 with the same coordinates and null time as P1 | A distinct position reading |
| Sequence 13 reuses P2 with changed coordinates or source time | Atomic `constituent_conflict` refusal |

Equal known timestamps never merge readings. New readings require new IDs.
Only positions enter append-only history; speed and altitude remain latest-state
fields. Accepted replay remains harmless. See the [history-only admission example](../reporting/evidence.md#independent-acceptance-example).

[Component index](README.md)
