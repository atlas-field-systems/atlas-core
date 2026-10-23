# Type

Type is descriptive. It names an Asset family, an observed subject kind, or an
authored Geofeature purpose. It grants no Command support or execution authority.
Entity category and Geometry's `type` are separate fields.

## Shared fields

| Field | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `kind` | String or null | Required | Resource-specific value below; null means unknown |
| `variant` | String or null | Required for `kind: "drone"`, otherwise omitted | Drone form; null means unknown |

`other` means a known kind outside the named categories. It is distinct from an
unknown kind. The sets below are closed. Integrations cannot register new values.

## Asset type

Kinds are `drone`, `security_camera`, `tracker`, and `other`, plus null for unknown.
Drone variants are `powered_fixed_wing`, `fixed_wing_glider`, and `quadcopter`,
plus null for unknown. Other kinds, including null, omit `variant`.

This is authored data changed through `UpdateAsset` with the descriptive revision
precondition. Applications can select icons by Type. Commands come from
[Capabilities](capabilities.md). No Type requires or forbids optional hardware
sections. A tracker can advertise Commands and a drone can advertise none.

Valid glider value:

```json
{"kind": "drone", "variant": "fixed_wing_glider"}
```

## Observed subject type

Observation and Track kinds are `person`, `ground_vehicle`, `aircraft`, `animal`,
and `other`, plus null for unknown. They never have a `variant` field.
Observation Type is a publisher-reported section with
[report evidence](../report-evidence.md). Track Type retains that evidence under
[fusion rules](../tracks.md). No confidence score or inference service is implied.

The only `source_times` key is `kind`, covering the whole classification.

Valid vehicle subject value:

```json
{"kind": "ground_vehicle"}
```

## Geofeature type

Kinds are `point_of_interest`, `route`, `search_area`, `boundary`, and `other`,
plus null for unknown. Geofeature Type is authored data and omits `variant`.
It does not require a matching Geometry shape or activate work or enforcement.
A `route` Point and a `search_area` LineString can both be saved. A Command validates
the actual geometry it consumes under that Command's own requirements.

Valid purpose value:

```json
{"kind": "search_area"}
```

Invalid because a security camera cannot carry a drone variant:

```json
{"kind": "security_camera", "variant": "quadcopter"}
```

[Component index](README.md)
