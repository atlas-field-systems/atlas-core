# Camera Optics

> Retained current design for review. [Planning status](../../../../../README.md#planning-status).

Camera Optics reports the exposed camera's baseline rectilinear field of view at 1x.
Its wire section name is `camera_optics`. [Camera](camera.md) reports live magnification.
A calibration can remain state until changed. Recalibration replaces it whole.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `horizontal_fov` | Number or null | Required | Full horizontal angle at 1x, in degrees, greater than 0 and less than 180 |
| `vertical_fov` | Number or null | Required | Full vertical angle at 1x, in degrees, greater than 0 and less than 180 |

Both numbers must be finite. Null means unknown calibration. The external source
defines 1x as the widest calibrated rectilinear configuration of the exposed set.
It converts hardware zoom to magnification relative to that reference. Digital
crop or internal camera switching requires a calibrated equivalent before a known
ratio can be reported. Unsupported optical models expose unknown FOV values.

The [section result](../../reporting/evidence.md) allows `source_times` keys exactly
`horizontal_fov` and `vertical_fov`. Calibration time is not current capture time.
The Asset owns coherence when its [exposed camera changes](camera.md#exposed-hardware-ownership).

These angles and a zoom ratio do not define a universal projection model.
Consumer tools own derived viewing geometry. Atlas promises neither exact ground
footprints nor a media transport from this calibration.

## Examples

Valid baseline calibration:

```json
{"horizontal_fov": 90, "vertical_fov": 60}
```

Invalid rectilinear calibration:

```json
{"horizontal_fov": 200, "vertical_fov": 60}
```

[Component index](../../components/README.md)
