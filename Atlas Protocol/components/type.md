# Type

Type describes what a resource represents, for display and explicit system behavior.
The Entity category remains Asset, Track, or Geofeature. Geometry's `type` remains
Point, LineString, or Polygon. This separate Type value describes an Asset family,
a Track's reported kind, or a Geofeature's purpose. [OpenAPI](../openapi.json) owns the wire names and enums.

## Shared fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `kind` | String or null | Required | Value from the resource-specific set below; null when unknown |
| `variant` | String or null | Required for a drone Asset; otherwise omitted | More specific drone form; null when not yet known |

Define named AssetType, TrackType, and GeofeatureType schemas using these shared
value definitions and their own allowed fields. Plugins cannot register arbitrary
values. The initial enum sets are closed.

## Asset type

Kinds are `drone`, `security_camera`, `tracker`, and `other`.
Drone variants are `powered_fixed_wing`, `fixed_wing_glider`, and `quadcopter`.
A camera or tracker omits `variant`. It does not supply `variant: null`.

Type is descriptive Asset data changed through `UpdateAsset` and the descriptive
revision precondition. Applications can choose icons or handling by Type. Supported
Commands still come from [Capabilities](capabilities.md). Type alone grants none.
Any additional type-specific Core rule must be explicit in Protocol.

Valid glider value:

```json
{"kind": "drone", "variant": "fixed_wing_glider"}
```

## Track type

Kinds are `person`, `ground_vehicle`, `aircraft`, `animal`, and `other`.
These values describe the observed subject, not its publisher. Updates are source
claims under [Track observation rules](../entities.md#tracks), with publisher,
original observation identity, and time retained. Type does not add a confidence
score or an automatic inference service.

Valid value for a vehicle detection:

```json
{"kind": "ground_vehicle"}
```

## Geofeature type

Kinds are `point_of_interest`, `route`, `search_area`, `boundary`, and `other`.
This is authored purpose, changed through the Geofeature's descriptive edit rules.
It is independent of the coordinates and shape in [Geometry](geometry.md).
A purpose does not itself request work or activate boundary enforcement.

Valid purpose value:

```json
{"kind": "search_area"}
```

## Invalid example and scope

Invalid Asset Type because a security camera cannot carry a drone variant:

```json
{"kind": "security_camera", "variant": "quadcopter"}
```

Purpose does not add geometry enforcement or request work. These examples are
reusable values. A reported Track Type uses `TrackTypeObservation` inside its
section result, with source evidence and observation time.

[Component index](README.md)
