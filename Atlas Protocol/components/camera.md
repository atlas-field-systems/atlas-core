# Camera

Camera reports current calibrated magnification and capture activity for one exposed
camera. [Gimbal](gimbal.md) reports pointing. [Camera Optics](camera-optics.md)
reports the baseline field of view without requiring it in every zoom update.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `zoom_ratio` | Number or null | Required | Finite calibrated magnification relative to the exposed 1x baseline, at least 1; null when unknown |
| `recording` | Boolean or null | Optional | Whether video recording is active; omit only when unsupported |
| `capturing` | Boolean or null | Optional | Whether still capture is active; omit only when unsupported |

Supported activity uses null when its current state is unknown. The two flags are
independent and can both be true. Fixed optics can report 1 when the baseline is
known. A vendor slider, percentage, or uncalibrated zoom position cannot be used
as magnification. Without calibration, report `zoom_ratio: null`.

The [section result](../report-evidence.md) declares state until changed or dated
measurement. Allowed `source_times` keys are `zoom_ratio`, `recording`, and
`capturing`, restricted to fields present in the value. Activity timestamps describe
the source's assessment, not Object publication or a request to start capture.
Omitting the entire Camera section preserves it. Supplied sections replace it whole.

## Exposed hardware ownership

An Asset exposes at most one `camera`, one `camera_optics`, and one `gimbal`.
The external Asset runtime owns internal camera selection, transforms, and
calibration. Core does not select cameras or manage hardware instances.
When selection changes the exposed set, the runtime supplies Camera and Camera
Optics together, plus Gimbal if exposed, in one atomic report. It supplies current
values, explicit unknowns, or errors for the newly selected hardware. It cannot
carry forward the previous camera's calibration or pointing as current evidence.
A removed exposed section uses withdrawal in that same report.

Multiple independently exposed cameras and camera instance collections are
unsupported initially. Media transport and physical camera execution remain external.

## Examples

Valid snapshot supporting both capture activities:

```json
{"zoom_ratio": 2, "recording": true, "capturing": true}
```

Valid uncalibrated camera with unknown supported video activity:

```json
{"zoom_ratio": null, "recording": null}
```

Invalid because magnification is below the baseline:

```json
{"zoom_ratio": 0.5}
```

[Component index](README.md)
