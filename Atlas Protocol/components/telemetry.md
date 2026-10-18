# Telemetry

Telemetry is the proposed complete section for an Entity's location and motion.
A report supplies the whole section, including defined null values.
Asset history and synchronization use [location reading rules](../location-history.md).

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `position` | [Position](#position) or null | Required | Complete WGS84 coordinate pair; null when unknown |
| `altitude` | [Altitude](#altitude) or null | Required | Height with explicit reference; null when unknown |
| `ground_speed` | Number or null | Required | Horizontal metres per second, at least zero; null when unknown |
| `airspeed` | Number or null | Optional | Metres per second relative to air, at least zero; omit when not applicable |

All results include the [shared fields](README.md#shared-proposed-section-fields).
Asset reports require [quantity sources](../reports.md#quantity-sources) in their
shared report context. `observed_at` dates the other telemetry values, including
speed. It never refreshes the position or altitude source times.
Unknown values do not imply an error. Errors replace the success section with the
shared error result. Body heading belongs in [Attitude](attitude.md).

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

Successful Asset report fragment with enclosing quantity context. Other shared
report fields are elided. The altitude is an older original observation.

```json
{
	"telemetry": {
		"position": {"latitude": 51.5074, "longitude": -0.1278},
		"altitude": {"metres": 142.6, "reference": "wgs84_ellipsoid"},
		"ground_speed": 0, "observed_at": "2026-10-16T12:00:00Z"
	},
	"quantity_sources": {
		"position": {
			"original_evidence": {"process_generation": "00000000-0000-4000-8000-000000000001", "id": "00000000-0000-4000-8000-000000000042", "sequence": "42"},
			"observed_at": "2026-10-16T12:00:00Z", "revision": "1"
		},
		"altitude": {
			"original_evidence": {"process_generation": "00000000-0000-4000-8000-000000000001", "id": "00000000-0000-4000-8000-000000000040", "sequence": "40"},
			"observed_at": "2026-10-16T11:59:00Z", "revision": "1"
		}
	}
}
```

Omitted `airspeed` is allowed by this proposal. Neither omission nor null
substitutes an older subfield value.

`{"ground_speed": 0, "observed_at": "2026-10-16T12:00:00Z"}` is an invalid
success replacement because required position and altitude are missing.

A mounted camera can retain Telemetry as state until changed. Aircraft and
commandless trackers can report dated measurements. Telemetry is not universal.

[`UpdateAsset`](../messaging/assets.md#updating-sections) carries this Asset section.

HTTP Asset reads and public SDK values keep expanded `position` and `altitude`.
Successful Asset reads also expose `telemetry.quantity_sources.position` and
`.altitude`. Each contains the selected reading's `id`, `revision`,
`original_evidence`, `observed_at`, and `time_usability`. Response schemas add this
read-only metadata separately from the producer's enclosing report context.
Writable telemetry excludes it. `UpdateAsset` rejects nested
`telemetry.quantity_sources` with a validation error. Errors expose neither.
Sync replaces expanded values and this metadata with [references](../synchronization.md#complete-changes).
Longitude endpoint canonicalization and Altitude's object layout remain proposals.
Uncertainty fields and exact Track field applicability remain undefined.

[Component index](README.md)
