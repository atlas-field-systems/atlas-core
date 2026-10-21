# Type

Type describes what a resource represents, for display and explicit system behavior.
The Entity category remains Asset, Observation, Track, or Geofeature. Geometry's `type` remains
Point, LineString, or Polygon. This separate Type value describes an Asset family,
an Observation's subject kind, a Track's derived kind, or a Geofeature's purpose.
Wire names and enums are proposals.

## Proposed shared fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `kind` | String or null | Required | Value from the resource-specific set below; null when unknown |
| `variant` | String or null | Required for a drone Asset; otherwise omitted | More specific drone form; null when not yet known |

Define named AssetType, ObservationType, TrackType, and GeofeatureType schemas using these shared
value definitions and their own allowed fields. Plugins cannot register arbitrary
values. Exact initial enum sets still need review.

## Asset type

Proposed kinds are `drone`, `security_camera`, `tracker`, and `other`.
Drone variants are `powered_fixed_wing`, `fixed_wing_glider`, and `quadcopter`.
A camera or tracker omits `variant`. It does not supply `variant: null`.

Type is descriptive Asset data changed through `UpdateAsset` and the descriptive
revision precondition. Applications can choose icons or handling by Type. Supported
Commands still come from [Capabilities](capabilities.md). Type alone grants none.
Any additional type-specific Core rule must be explicit in Protocol.

Valid proposed glider value:

```json
{"kind": "drone", "variant": "fixed_wing_glider"}
```

## Observed subject type

Proposed kinds are `person`, `ground_vehicle`, `aircraft`, `animal`, and `other`.
ObservationType and TrackType reuse this set. Observation values are publisher
claims under [Observation rules](../observations.md), with original report identity
and time retained. Track values follow the active [fusion policy](../tracks.md)
with source provenance. Type adds no confidence score or automatic inference service.

Valid proposed value for a vehicle detection:

```json
{"kind": "ground_vehicle"}
```

## Geofeature type

Proposed kinds are `point_of_interest`, `route`, `search_area`, `boundary`, and `other`.
This is authored purpose, changed through the Geofeature's descriptive edit rules.
It is independent of the coordinates and shape in [Geometry](geometry.md).
A purpose does not itself request work or activate boundary enforcement.

Valid proposed purpose value:

```json
{"kind": "search_area"}
```

## Invalid example and open choices

Invalid Asset Type because a security camera cannot carry a drone variant:

```json
{"kind": "security_camera", "variant": "quadcopter"}
```

Confirm `kind` and `variant` names, initial enum sets, and compatibility rules
between purpose and geometry. These examples are reusable values. Reported Observation
sections also carry their source evidence. The exact enclosing layout remains
incomplete.

[Component index](README.md)
