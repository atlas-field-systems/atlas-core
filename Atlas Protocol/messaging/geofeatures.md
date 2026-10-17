# Geofeature messages

**Geofeature messages create and edit authored points, lines, and polygons.**
Creation requires Geometry and accepts permitted Description and [Type](../components/type.md#geofeature-type) values.
It has no Asset enrollment or Track publisher inputs. Shared message context and
the proposal status of exact names and payloads follow the [messaging index](../messaging.md).

## Messages

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `CreateGeofeature` | Operator app or import tool authors a point, line, or area for planning | Stable Geofeature and request IDs, required Geometry, and permitted initial description | Created Geofeature |
| `ListGeofeatures` | Operator app browses authored geometry for display or Task selection | Bounded filters | Matching Geofeature views |
| `GetGeofeature` | Operator app or Asset runtime reads geometry referenced by a Task | Geofeature ID | Current Geofeature view |
| `GetGeofeatureByAlias` | Planning integration resolves a configured alias to a Geofeature | Geofeature alias | Matching Geofeature view |
| `EditGeofeature` | Operator app or import tool revises geometry or its description | Geofeature ID, permitted description/geometry edits, retry identity, and `expected_edit_revision` | Committed Geofeature; a geometry change advances its geometry revision |
| `DeleteGeofeature` | Operator app removes authored geometry that is no longer needed | Geofeature ID and retry identity | Deletion or an explicit refusal under [reference guards](../entities.md#geometry-and-references) |
| `GetGeofeatureObjects` | Operator app finds reference files associated with a point, line, or area | Geofeature ID and bounded query | Associated Object metadata |

Inputs reuse the [permitted Entity components](../entities.md#component-composition).
Geometry edits and Task references follow [Geometry and references](../entities.md#geometry-and-references).
Saving a changed Geofeature does not prove that an Asset applied it.

[Messaging index](../messaging.md)
