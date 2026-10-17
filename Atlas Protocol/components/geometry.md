# Geometry

Geometry describes a point, line, or polygon using a shared spatial value.
Geofeatures require it. Applicable Tracks can report an observed extent. Asset
location uses [Position](telemetry.md#position). Exact schema limits below remain proposals.

## Proposed representation

Use a two-dimensional subset of [GeoJSON Geometry](https://www.rfc-editor.org/rfc/rfc7946.html#section-3.1).
Each object has required, non-null `type` and `coordinates` fields. Its geometry
`type` selects the coordinate shape. It is independent of resource [Type](type.md).

| Geometry `type` | Coordinates | Minimum structure |
| --- | --- | --- |
| `Point` | One coordinate pair | Exactly two finite numbers, longitude then latitude |
| `LineString` | Array of coordinate pairs | At least two pairs |
| `Polygon` | Array of closed rings | At least one ring; at least four pairs per ring, including the repeated first/last pair |

Use WGS84 degrees and the bounds from [Position](telemetry.md#position), preserving
double precision. Coordinate tuples reference the same longitude and latitude scalar
definitions in the eventual schemas. The first polygon ring is the exterior.
Subsequent rings are holes. Follow GeoJSON winding rules.

This proposal accepts geometry objects, not Feature wrappers or collections.
It starts with two-dimensional coordinates. Command altitude uses the explicit
[Altitude](telemetry.md#altitude) value. Vertex limits, antimeridian handling, and
polygon validity rules need agreement before an executable schema is complete.

## Examples

Valid point under the proposal:

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
