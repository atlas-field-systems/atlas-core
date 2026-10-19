# Camera Optics

Camera Optics is a section for baseline field of view at 1x zoom.
A mounted camera can supply it once as state until changed. Changing calibration
would replace the whole section.
Current magnification belongs in [Camera](camera.md), independently of this calibration.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `horizontal_fov` | Number or null | Required | Full horizontal angle at 1x, in degrees; greater than 0 and less than 180 for rectilinear optics |
| `vertical_fov` | Number or null | Required | Full vertical angle at 1x, in degrees; greater than 0 and less than 180 for rectilinear optics |

Also include the [reported result definitions](README.md#reported-results).
Both fields are present in every replacement. Null means unknown calibration.

## Examples

Valid component value:

```json
{
	"horizontal_fov": 90,
	"vertical_fov": 60,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

Invalid under the rectilinear bounds:

```json
{
	"horizontal_fov": 200,
	"vertical_fov": 60,
	"observed_at": "2026-10-16T12:00:00Z"
}
```

## Scope

The schema describes rectilinear baseline angles. Calibration plus a vendor's
raw zoom setting is not a universal projection model.
[ONVIF](https://www.onvif.org/specs/srv/ptz/ONVIF-PTZ-Service-Spec-v1612.pdf)
does not require generic zoom positions to map to physical magnification or FOV.
Consumer tools own derived viewing geometry. Atlas does not promise an exact
ground footprint from these two angles alone.

[Component index](README.md)
