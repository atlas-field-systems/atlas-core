# Telemetry

Telemetry is the complete section for an Entity's location and motion.
A report supplies the whole section, including defined null values.
The same whole-snapshot ordering applies to Asset and Track Telemetry. The source
assembles the snapshot; Core does not merge independently arriving quantities.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `position` | [Position](#position) or null | Required | Complete WGS84 coordinate pair; null when unknown |
| `altitude` | [Altitude](#altitude) or null | Required | Height with explicit reference; null when unknown |
| `ground_speed` | Number or null | Required | Horizontal metres per second, at least zero; null when unknown |
| `airspeed` | Number or null | Optional | Metres per second relative to air, at least zero; omit when not applicable |

The enclosing result carries [shared section metadata](README.md#shared-section-results).
Unknown readings do not imply an error. Actual failures use the shared error
representation. Body heading belongs in [Attitude](attitude.md), separately from
direction of travel.

## Position

Position is a reusable coordinate pair for Telemetry and Command inputs.
[Spatial conventions](../entities.md#spatial-conventions) establish WGS84 degrees,
complete pairs, valid zero coordinates, and double precision.

| Field | Type | Presence | Bounds |
| --- | --- | --- | --- |
| `latitude` | Number | Required, non-null | -90 through 90 inclusive |
| `longitude` | Number | Required, non-null | -180 through 180 inclusive |

Numbers must be finite under [Wire](../wire.md#parsing-and-edits).
Preserve binary64 precision without decimal truncation. Accept and retain both
longitude endpoint spellings, `-180` and `180`, without canonicalizing either.

- Valid: `{"latitude": 0, "longitude": 0}`.
- Invalid latitude: `{"latitude": 91, "longitude": 0}`.
- Invalid incomplete pair: `{"latitude": 51.5074}`.

## Altitude

Altitude is a reusable height value for Telemetry and Command inputs.
[Spatial conventions](../entities.md#spatial-conventions) require metres and an
explicit `wgs84_ellipsoid` reference. AGL and MSL must not be silently substituted.

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `metres` | Number | Required, non-null | Finite signed metres; negative and zero are allowed |
| `reference` | String | Required, non-null | Exactly `wgs84_ellipsoid` |

This object has no operational height limit beyond finite binary64 representation.
The containing field defines how unknown altitude uses null or omission.

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

Omitted `airspeed` is allowed. Neither omission nor null
substitutes an older subfield value.

This fragment is an invalid replacement because required fields are missing:

```json
{"ground_speed": 0}
```

## Use and source times

A mounted camera can retain a complete Telemetry section as state until changed.
Aircraft and a commandless vehicle tracker can report it as dated measurements.
This does not require every Entity to have Telemetry.

The [`UpdateAsset`](../messaging/assets.md#updating-sections) message
carries this Asset section.

The enclosing result's `observed_at` is the default source time. Its `source_times`
may override `position`, `altitude`, `ground_speed`, and supplied `airspeed`.
Position is one complete quantity, not separate latitude and longitude observations.
Explicit null means an unknown time. A fresh snapshot cannot refresh older readings.
Uncertainty fields remain deferred. Schemas must declare exact Track applicability.

## Constituent observation identity

Each supplied quantity carries a source-assigned observation ID and correction revision
as source evidence, separate from the complete section's sequence and delivery identity.
Scope the ID by Dataset, Entity, originating source, and quantity. The originating
source is the Asset process generation or the Track's stable publisher. A carried-forward
reading retains its original scope, including across Asset process replacement.
Credentials and gateways do not affect observation identity.

Carrying a reading into a later snapshot preserves its ID, revision, value, and original
source time, including unknown time. Supply `source_times` when that time differs from
the new `observed_at`, including explicit null. Core never fills from the prior section.
A genuinely new reading gets a new ID even when its value and source time are identical.
Neither equal values nor equal or unknown timestamps establish duplicate observations.

A correction keeps the observation identity and original source time and increases its
revision. The same identity and revision must repeat identical facts. Conflicting reuse
or a revision below the highest accepted revision rejects the update atomically.
A newer section sequence cannot authorize a stale constituent revision. Observation IDs
and correction revisions do not change whole-section ordering or permit subfield updates.

These examples use one Entity and source. Every row supplies a complete snapshot with
position, altitude, and ground speed. Other quantities carry forward unless stated.

| Case | Constituent evidence in the later snapshot | Movement result |
| --- | --- | --- |
| Carried-forward reading | Sequence 11 adds a new speed reading but repeats position `P1`, revision 0, coordinates, and source time null from sequence 10 | Retain the new speed observation only; no extra position observation or fresh position age |
| New equal reading | Sequence 12 supplies position `P2`, revision 0, with the same coordinates and null source time as `P1` | Retain a distinct position observation despite the identical value and unknown time |
| Correction | Sequence 13 supplies corrected coordinates for `P2`, revision 1, keeping its null source time | Retain the correction against `P2`; no new reading or fresh age; repeating revision 1 adds no correction |

For known equal times, `P1` and new reading `P2` can both have source time
`2026-10-20T12:00:00Z`. The correction of `P2` keeps that time even in a snapshot
whose `observed_at` is later. A conflicting revision 1 or later reuse of revision 0
is rejected. Exact metadata fields remain for the concrete message schemas.

[Component index](README.md)
