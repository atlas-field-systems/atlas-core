# Spatial data and the MVP examples

This page owns shared coordinates, spatial quantities and the concrete Move To and Elevation Lookup fixture contracts. Protocol authors these facts once for Commands, Components and Plugin capability schemas. [Tasks](tasks.md) owns execution outcomes, and [Plugins](plugins.md) owns Operation acceptance and results. Required verification follows the [MVP checks](../testing-strategy.md#mvp-integration-checks).

## Coordinates and quantities

Named positions use `latitude` and `longitude`, finite double-precision numbers in decimal degrees, in the WGS84 geographic reference. Latitude is inclusive -90 to 90; longitude is inclusive -180 to 180. Named fields remove tuple-order ambiguity. Neither field is inferred or swapped. Nonfinite numbers, missing coordinates and unknown coordinate references fail validation.

Geofeature geometry uses GeoJSON point, line or polygon geometry. Its coordinate arrays are longitude first, latitude second, with optional WGS84 ellipsoid height in metres. These axis/reference rules follow [RFC 7946](https://www.rfc-editor.org/rfc/rfc7946#section-3.1.1). Named position objects and GeoJSON arrays are distinct schemas, with an explicit conversion at that boundary.

Horizontal distances and uncertainty use metres; speed uses metres per second; heading uses degrees clockwise from true north in the range 0 inclusive to 360 exclusive. A negative uncertainty is invalid. An absent quantity is unknown or unconstrained according to its field's purpose; zero is a known value. A nullable observed quantity explicitly reports unknown, while omission in a patch preserves the existing quantity and its age. [Observation groups](tracks-and-geofeatures.md#observation-identities-ordering-and-time) retain field-specific time; receipt does not make an old position fresh.

An optional target altitude is `{ "value_m": number, "vertical_reference": "wgs84_ellipsoid" }` for the initial MVP. It is never implicitly mean sea level or height above local ground. Supporting another named vertical reference requires a Protocol edition and explicit integration conversion; do not relabel values from a different datum. An omitted target altitude imposes no Core-defined vertical target. Altitude-bearing GeoJSON uses its defined ellipsoid reference.

## Move To

`move_to` supports queued or immediate scheduling when the Asset advertises the selected choice; omitted scheduling selects queued. Its immutable input has `target` with either `kind: "position"` and a named `position`, or `kind: "geofeature"` and a `geofeature_id` referring to a point Geofeature. The point reference is required while the Task is nonterminal and follows live geometry until its [cutoff](tasks.md#live-geofeature-geometry). Lines or polygons are not implicit destinations for this Command. Unsupported inputs fail before Task creation.

Successful execution means arrival, as determined by the Asset's implementation. Core does not define an arrival radius, compare telemetry to the target or infer success from position uncertainty. Progress may carry Asset-selected distance and uncertainty details in the shared units. On a terminal report involving a Geofeature, record the actual applied geometry revision even if a newer point is now saved. The simulated Asset's independent fixture chooses its own arrival boundary; that fixture threshold is not a Core admission or completion rule.

The initial simulated fixture uses target latitude 10, longitude 20, an Asset-side arrival tolerance of 5 metres, and two progress observations whose independently assigned distances are 5.1 and 4.9 metres. The simulator reports completion only for the latter. Core must remain In progress after the former, and record Completed after the latter's valid report. Conversely, a valid Asset success report is recorded even when the last telemetry lies outside that simulator threshold: stale telemetry is not authority to reject execution evidence.

## Elevation Lookup

The separate `elevation_lookup` capability takes a named two-dimensional position and returns `{ "elevation_m": number, "vertical_reference": "wgs84_ellipsoid", "reference_data_id": string }`. It does not take an Asset Task or produce an Object. The reference-data identity describes the fixture grid, not the operational Dataset. Capability/input versions follow [Plugin dispatch](plugins.md#private-operation-dispatch-and-reconciliation).

The offline test Plugin packages a synthetic four-corner grid, not a production terrain measurement. Reference grid `atlas-elevation-fixture-v1` spans latitude 10 through 11 and longitude 20 through 21 inclusive. Values are ellipsoid-referenced fixture metres:

| Latitude | Longitude | Elevation |
| --- | --- | --- |
| 10 | 20 | 100 m |
| 10 | 21 | 120 m |
| 11 | 20 | 140 m |
| 11 | 21 | 160 m |

Use bilinear interpolation inside this rectangle, preserving exact corner values. The centre independently expects 130 m and latitude 10.25, longitude 20.75 expects 125 m. Outside coverage return the definitive Operation failure `out_of_coverage`, with no fabricated zero elevation. Invalid coordinates fail input validation before acceptance. Unknown/no-data cells in a future fixture return `no_data`; they never masquerade as zero or as another vertical reference. The Plugin remains responsible for dataset interpretation and any later production provider.

## Independent fixture expectations

| Input or event | Expected result |
| --- | --- |
| Named latitude 10, longitude 20 | Valid position; no axis swapping |
| GeoJSON point `[20, 10]` | Same horizontal point after explicit conversion |
| Named latitude 120, longitude 10 | Reject invalid latitude; never infer reversal |
| Missing altitude | Valid horizontal Move To input, no implicit zero or ground elevation |
| Altitude marked with another vertical reference | Explicit unsupported-reference validation, no relabelling |
| Line Geofeature used as Move To destination | Reject before Task creation |
| Asset progress outside fixture arrival boundary | No inferred success |
| Valid Asset completion with older saved telemetry | Record the report's outcome; preserve telemetry age |
| Lookup at the four corners and centre | 100/120/140/160 m and 130 m, with fixture identity and ellipsoid reference |
| Lookup at latitude 9.9, longitude 20.5 | Accepted Operation fails `out_of_coverage`, without zero or an Object |

Execute these expectations through the real SDK/Core/simulated-Asset workflow and the separately built Plugin container. Near-boundary fixture evidence proves report handling only; real arrival behavior requires the [physical Asset milestone](../testing-strategy.md#core-contract-and-field-validation-milestones).
