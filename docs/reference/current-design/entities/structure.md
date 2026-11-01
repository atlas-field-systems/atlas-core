# Entities and reported sections

> Retained current design for review. [Planning status](../../../README.md#planning-status).

An Entity has one immutable `id` and `entity_type`, exactly `asset`, `observation`,
`track`, or `geofeature`. Resource [Type](components/type.md) is descriptive data.
Identity allocation, aliases, deletion, and Dataset lifetime follow [Identity](../support/identity.md).

## Component composition

Every read image requires UUID `dataset_id`, UUID `id`, `entity_type`, `version`, and
`edit_revision`. Both revisions are unsigned 64-bit decimal strings, initially `"0"`.
Core advances `version` on every public image change and `edit_revision` on authored edits.
Optional `alias` and [`description`](components/description.md) are authored metadata.
Neither is null or generated when absent. Other fields are exactly the following.

| Entity | Required fields beyond the common fields | Optional fields |
| --- | --- | --- |
| Asset | Authored `type`, `capabilities`; UUID `process_generation`; reported `status`; `communications`; `heartbeat`; read-only `task_queue`, `task_control` | Reported [`tags`](assets/components/tags.md), `telemetry`, `attitude`, `power`, `camera`, `camera_optics`, `gimbal` |
| Observation | UUID `publisher_id`; reported `type`; UUID `track_id` under the default policy | Immutable UUID `source_asset_id`; immutable `publisher_subject`; reported `telemetry`, `attitude`, `geometry` |
| Track | Reported `type`; read-only `sources` | Reported `telemetry`, `attitude`, `geometry` |
| Geofeature | Authored `type`, `geometry`; counter string `geometry_revision`, initially `"0"` | None |

`publisher_subject`, when supplied, contains exactly nonblank string `id`, at most
128 Unicode scalar values, and UUID `lifetime_id`. The pair distinguishes reuse
of a publisher-local number. It is not the Observation ID.
Track `sources` is a nonempty unique-by-Observation array of objects containing
UUID `observation_id`, UUID `publisher_id`, and optional recorded UUID `source_asset_id`.
Initially it has exactly one source under the [default policy](tracks/tracks.md#default-policy).

Asset `communications` contains derived `health` and reported `capacity` as defined
by [Communications](assets/components/communications.md). `heartbeat` is the read-only
[Heartbeat](assets/components/heartbeat.md) object. Every reported field is a complete
[section result with read evidence](reporting/evidence.md), not a raw component value.
Authored values have no report wrapper. Unknown fields and illegal compositions
are refused. No Type label requires or forbids an optional component.
Queue/control fields follow [Task rules](../tasks/tasks.md#scheduling-and-controls).

There is at most one Camera, Camera Optics, and Gimbal section per Asset. The
[Asset runtime owns coherence](assets/components/camera.md#exposed-hardware-ownership).
Military-display metadata, sensor metadata or references, uncertainty fields, and
multi-camera collections are unsupported initially. Files use [Object associations](../objects/objects.md),
not an inline media component or untyped extension dictionary.

## Initial states

Asset registration starts `status` with `condition: "unknown"`, capacity with
`bandwidth_bps: null`, Communications health `offline`, and Heartbeat
`last_contact_at: null`. Optional reported sections are absent. Capabilities defaults
to `{"commands": []}` when not supplied. Asset and Geofeature Type defaults to
`{"kind": null}` when not supplied. Geofeature creation always supplies Geometry.

Observation creation may supply any permitted reported sections using the
[report envelope](reporting/format.md). If Type is absent, initialize it to
`{"kind": null}`. Other absent reported sections remain absent. Creation need not
have a position. The default Track mirrors all permitted Observation section
results immediately. Its Description and alias initially remain absent.

Each source-free initial reported value uses `state: "value"`, classification
`state_until_changed`, `observed_at: null`, and read `evidence: null`.
It has no report sequence, constituent identity, or movement sample. Source-free
initial values are not source assertions. Later accepted reports replace them.

## Reported sections

`state_until_changed` applies until replacement or withdrawal. `dated_measurement`
retains its original measurement times. Infrequency or stopping does not change
classification. Every change of classification is explicit in a complete result.
Omission preserves the section. Optional sections stay present after a reported
withdrawal, with that withdrawal's evidence. Required containers always remain.

[Report format](reporting/format.md) owns exact fields. [Evidence admission](reporting/evidence.md)
owns immutable reading identity and independent whole-section ordering. Telemetry replaces its
quantities together, with no subfield merge. Derived Tracks retain original scopes.
Contact health remains separate under [Reports](reporting/reports.md#time-and-contact).

## Data ownership

`UpdateAsset` supplies complete authored Description, Type, and Capabilities or
reported sections. Descriptive writes use `expected_edit_revision`; measurement
reports do not advance that revision. Authored changes advance it. Other Entities use their descriptive
edit messages. Observation reports and Track fusion cannot overwrite descriptions.
One update can include both kinds. Core validates and commits the complete candidate,
evidence, history, default Track effects, and public change atomically.

## Geometry and references

See [Geofeature references](geofeatures/references.md).

## Spatial conventions

Named positions use WGS84 latitude then longitude in degrees. GeoJSON uses longitude
first. Coordinates are complete pairs and zero is valid. Use finite binary64 values,
metres, metres per second, and true-north headings in `[0,360)`. Altitude names
`wgs84_ellipsoid`, never an implicit AGL or MSL substitute.

[Next: Observations](observations/observations.md)
