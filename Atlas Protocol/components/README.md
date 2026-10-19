# Component field reference

The [OpenAPI contract](../openapi.json) owns exact fields, bounds, unions, and
permitted resource compositions. These pages explain the component meanings.
Remaining design questions do not expand the executable contract.

## Descriptions and type

| Component | Purpose | Used by |
| --- | --- | --- |
| [Description](description.md) | Human-readable name and details | Entities |
| [Type](type.md) | Asset family, observed subject kind, or authored purpose | Assets, Tracks, Geofeatures |
| [Capabilities](capabilities.md) | Supported Protocol Commands and scheduling | Assets, including commandless trackers |

## Reported sections

| Section | Purpose | Used by |
| --- | --- | --- |
| [Status](status.md) | Reported overall condition | Assets |
| [Telemetry](telemetry.md) | One complete location and motion section | Assets and applicable Track observations |
| [Attitude](attitude.md) | True-north body heading, pitch, and roll | Applicable Assets and Track observations |
| [Power](power.md) | Supply state and energy reserves | Applicable Assets |
| [Gimbal](gimbal.md) | One complete pointing section | Assets with a gimbal |
| [Camera](camera.md) | Live zoom and capture activity | Assets with a camera |
| [Camera Optics](camera-optics.md) | Baseline field of view at 1x zoom | Assets with a camera |

## Contact and geometry

| Component | Purpose | Used by |
| --- | --- | --- |
| [Communications](communications.md) | Declared link information and Core-derived contact health | Assets |
| [Heartbeat](heartbeat.md) | Contact evidence and its accepted read metadata | Assets |
| [Geometry](geometry.md) | Reusable point, line, or polygon | Geofeatures and applicable Tracks |

Telemetry documents the reusable [Position](telemetry.md#position) and
[Altitude](telemetry.md#altitude) values inline. Command inputs can reference those
same definitions without adopting the complete Telemetry section. Position quality
remains deferred. This reference adds no field contract for it.

These components do not create new Entity types or an arbitrary field registry.
Concrete schemas select permitted Entity components. Reference Asset examples
are a mounted gimbal camera, powered fixed-wing aircraft, a glider, a quadcopter,
and a commandless tracker that reports its own telemetry.

## Agreed behavior

[Entities](../entities.md#reported-sections) owns the distinction between state
until changed and dated measurements. [Reports](../reports.md#shared-context)
owns complete-section replacement, errors, ordering, and sparse report behavior.
Those rules apply to all reported sections.

## Reported results

Each supplied section has `state`, `classification`, and original `evidence`.
`value` carries the complete named component snapshot. `error` carries a required
code, optional message, and observation time, with no usable value. `withdrawn`
retains evidence and observation time and requires `state_until_changed`.
[Reports](../reports.md#shared-context) owns replacement and ordering behavior.

A component value carries `observed_at`, which may be null. Quantity-specific times
preserve constituent ages. Error and withdrawal results carry their own time.
Required read containers stay present. A retained container is `unknown` before
any report, or `reported` with the source result and a separate Core receipt.
Callers cannot submit receipt time, submitting-key attribution, or derived health.

Examples show component values, not full authenticated requests or retained reads.
The [OpenAPI contract](../openapi.json) owns exact structure and validation.
