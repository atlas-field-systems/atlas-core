# Geometry

Geometry describes a point, line, or polygon using a shared spatial value.
Geofeatures require it. Applicable Tracks can report an observed extent. Asset
location uses [Position](telemetry.md#position).

## Geometry profile

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
definitions in the eventual schemas. The single polygon ring is the exterior.
Authors emit counterclockwise rings. Readers accept either winding and retain it
unchanged, following [GeoJSON's parsing guidance](https://www.rfc-editor.org/rfc/rfc7946.html#section-3.1.6).
A polygon must have nonzero area. Reject crossings, nonadjacent touching, and overlap.
Check bounds on original numeric tokens before conversion. Use robust topology
checks on binary64 coordinates without grid snapping or decimal truncation.

Accept only these two-dimensional geometry objects. Feature wrappers, collections,
holes, and multipart geometry are unsupported. The planar boundary profile below
defines the excluded dateline and pole cases.
The proposed initial cap is 1,024 coordinate pairs in total, including a ring's
repeated closing pair. It requires qualification. Command altitude uses the explicit
[Altitude](telemetry.md#altitude) value.

Refuse malformed shapes as `invalid_geometry`, excluded representations as
`unsupported_geometry`, and excess vertices as `geometry_limit_exceeded`. Never
silently close, simplify, reorient, split, or repair submitted geometry.

The vertex cap alone does not establish bounded validation cost. Qualification must
cover adversarial valid shapes and complete messages, as described in
[Core qualification](../../Atlas%20Core/protocol-qualification.md).

## Boundary examples

Edges use straight interpolation in longitude and latitude, not geodesic routing.
Preserve both longitude endpoint spellings, `-180` and `180`.

| Case | Result |
| --- | --- |
| `LineString` from `[0, 0]` to `[180, 0]` | Accept the exactly 180-degree longitude step |
| `LineString` from `[170, 0]` to `[-170, 0]` | Refuse `unsupported_geometry` for a step greater than 180 degrees |
| Non-Point geometry containing both longitude endpoints | Refuse `unsupported_geometry` for full 360-degree extent |
| Point `[0, 90]` or `[0, -90]` | Accept a pole Point |
| `Polygon` coordinates `[[[0, 89], [1, 89], [0, 90], [0, 89]]]` | Accept an isolated pole vertex |
| Polygon edge between different longitudes at either pole, such as `[0, 90]` to `[1, 90]` | Refuse `unsupported_geometry` |
| Valid exterior ring in either orientation | Accept without reorientation |

## Examples

Valid point under this profile:

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
