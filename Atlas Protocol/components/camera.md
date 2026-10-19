# Camera

Camera owns current zoom and capture activity. Gimbal owns pointing.
[Camera Optics](camera-optics.md) retains baseline field of view separately, so
zoom updates do not resend calibration. [OpenAPI](../openapi.json) owns the fields below.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `zoom_ratio` | Number or null | Required | Magnification relative to declared 1x baseline, at least 1; null when unknown |
| `recording` | Boolean or null | Optional | Whether video recording is active; omit when video recording is unsupported |
| `capturing` | Boolean or null | Optional | Whether still-image capture is active; omit when still capture is unsupported |

For supported activities, null means their current state is unknown. Fixed optics
can report `zoom_ratio: 1`. Magnification is not a vendor's uncalibrated slider or
percentage. The capture flags are independent because still capture and
video recording can overlap. Both activity flags may be present.

Include the [shared section fields](README.md#reported-results).
An accepted source update uses `UpdateAsset` with the whole Camera section.
Omitting Camera leaves it unchanged. Reported activity is evidence, not a request
to start recording, nor proof that a result Object has been published.

## Examples

Valid snapshot for a camera supporting video recording only:

```json
{
	"zoom_ratio": 2,
	"recording": true,
	"observed_at": "2026-10-17T12:00:00Z"
}
```

Invalid because magnification is below the baseline minimum:

```json
{"zoom_ratio": 0.5, "observed_at": "2026-10-17T12:00:00Z"}
```

## Scope

This contract describes one Camera section. A future multiple-camera collection
needs stable instance identities. Sources calibrate magnification; media transport
and camera execution remain external responsibilities.

[Component index](README.md)
