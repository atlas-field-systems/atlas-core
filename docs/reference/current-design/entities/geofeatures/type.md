# Geofeature type

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

Kinds are `point_of_interest`, `route`, `search_area`, `boundary`, and `other`,
plus null for unknown. Geofeature Type is authored data and omits `variant`.
It does not require a matching Geometry shape or activate work or enforcement.
A `route` Point and a `search_area` LineString can both be saved. A Command validates
the actual geometry it consumes under that Command's own requirements.

Valid purpose value:

```json
{"kind": "search_area"}
```
