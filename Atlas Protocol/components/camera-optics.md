# Camera Optics

Camera Optics is a proposed section for baseline field of view at 1x zoom.
A mounted camera can supply it once as state until changed. Changing calibration
would replace the whole section.
Current magnification belongs in [Camera](camera.md), independently of this calibration.

## Proposed fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `horizontal_fov` | Number or null | Required | Full horizontal angle at 1x, in degrees; greater than 0 and less than 180 for rectilinear optics |
| `vertical_fov` | Number or null | Required | Full vertical angle at 1x, in degrees; greater than 0 and less than 180 for rectilinear optics |

The enclosing result carries [shared section metadata](README.md#shared-section-results).
Both fields are present in every replacement. Null means unknown calibration.

## Examples

Valid under the proposed field contract:

```json
{
	"horizontal_fov": 90,
	"vertical_fov": 60
}
```

Invalid under the proposed rectilinear bounds:

```json
{
	"horizontal_fov": 200,
	"vertical_fov": 60
}
```

## Decisions to settle

Settle the section name, optical models, and definition of 1x zoom. Baseline
calibration plus a vendor's raw zoom setting is not a universal projection model.
[ONVIF](https://www.onvif.org/specs/srv/ptz/ONVIF-PTZ-Service-Spec-v1612.pdf)
does not require generic zoom positions to map to physical magnification or FOV.
Consumer tools own derived viewing geometry. Atlas does not promise an exact
ground footprint from these two angles alone.

[Component index](README.md)
