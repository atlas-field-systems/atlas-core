# Geometry

Geometry describes a point, line, or polygon using a shared spatial value.
Geofeatures require it. Applicable Tracks can report an observed extent. Asset
location uses [Position](telemetry.md#position).

## Representation

Use a two-dimensional subset of [GeoJSON Geometry](https://www.rfc-editor.org/rfc/rfc7946.html#section-3.1).
Each object has required, non-null `type` and `coordinates` fields. Its geometry
`type` selects the coordinate shape. It is independent of resource [Type](type.md).

| Geometry `type` | Coordinates | Minimum structure |
| --- | --- | --- |
| `Point` | One coordinate pair | Exactly two finite numbers, longitude then latitude |
| `LineString` | Array of coordinate pairs | At least two pairs |
| `Polygon` | Array containing one closed ring | At least four pairs, including the repeated first/last pair |

Use WGS84 degrees and the bounds from [Position](telemetry.md#position), preserving
double precision. Coordinate tuples reference the same longitude and latitude scalar
definitions in the schemas. The single polygon ring is the exterior. The exterior ring uses counterclockwise winding. A polygon must have nonzero area and must not intersect itself.

Accept only these two-dimensional geometry objects. Feature wrappers, collections,
holes, and multipart geometry are unsupported. The initial profile excludes these
dateline and pole representations before planar topology checks:

- An adjacent pair's absolute longitude step exceeds 180 degrees. Exactly 180 is allowed.
- A non-Point geometry's longitude extent is the full 360 degrees, including both -180 and +180.
- A Polygon edge joins distinct longitudes at the same pole, latitude +90 or -90.

A Point at either pole and an isolated polygon pole vertex are valid. These limits
define the initial representation profile, not general spherical topology.
The initial maximum is 1,024 coordinate pairs in total, including a ring's repeated
closing pair. Command altitude uses the explicit [Altitude](telemetry.md#altitude) value.

Refuse malformed shapes as `invalid_geometry`, excluded representations as
`unsupported_geometry`, and excess vertices as `geometry_limit_exceeded`. Never
silently close, simplify, reorient, split, or repair submitted geometry. These rules
apply to `Geometry` and each concrete geometry schema.

## Examples

Valid point as a component value:

```json
{"type": "Point", "coordinates": [-0.1278, 51.5074]}
```

Valid closed polygon ring:

```json
{
	"type": "Polygon",
	"coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]
}
```

Invalid polygon because the ring is not closed:

```json
{
	"type": "Polygon",
	"coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1]]]
}
```

Geometry edits, revisions, and Task references follow [Entity rules](../entities.md#geometry-and-references).
A `search_area` purpose does not itself make Core plan a search or enforce a boundary.

[Component index](README.md)
