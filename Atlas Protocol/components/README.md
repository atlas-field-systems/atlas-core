# Component field reference

These pages define the selected component fields, units, bounds, and presence rules.
They are the documentation contract, implemented by the shared runtime schemas.
Unknown input properties are refused. Qualification commands live in the
[package guide](../qualification.md).
String limits count Unicode scalar values. Nonblank strings contain at least one
character outside Unicode White_Space. Accepted spelling is retained.

## Descriptions and type

| Component | Purpose | Used by |
| --- | --- | --- |
| [Description](description.md) | Human-readable name and details | All Entity types |
| [Type](type.md) | Descriptive family, subject kind, or purpose | All Entity types |
| [Capabilities](capabilities.md) | Supported Catalog Commands | Assets, including commandless trackers |

## Reported sections

| Section | Purpose | Used by |
| --- | --- | --- |
| [Tags](tags.md) | Asset-reported preset set | Assets |
| [Status](status.md) | Source's overall condition assessment | Assets |
| [Telemetry](telemetry.md) | Complete location and motion snapshot | Assets, Observations, and derived Tracks |
| [Attitude](attitude.md) | True-north body heading, pitch, and roll | Assets, Observations, and derived Tracks |
| [Power](power.md) | Supply state and energy reserves | Assets |
| [Gimbal](gimbal.md) | Complete world-relative pointing snapshot | Assets |
| [Camera](camera.md) | Calibrated zoom and independent capture activities | Assets |
| [Camera Optics](camera-optics.md) | Baseline rectilinear field of view | Assets |
| [Type](type.md#observed-subject-type) | Publisher's subject classification | Observations and derived Tracks |
| [Geometry](geometry.md) | Reported subject extent | Observations and derived Tracks |

## Contact and reusable values

| Component | Purpose | Used by |
| --- | --- | --- |
| [Communications](communications.md) | Reported capacity and Core-derived contact health | Assets |
| [Heartbeat](heartbeat.md) | Contact proof and accepted contact timestamp | Assets |
| [Geometry](geometry.md) | Authored point, line, or polygon | Geofeatures |

[Telemetry](telemetry.md) also defines reusable Position and Altitude values.
Commands can use those values without adopting Telemetry. Position uncertainty,
military-display metadata, sensor references, and collections of independently
exposed cameras are unsupported initially. No untyped extension fields replace them.

## Shared section results

[Report format](../report-format.md) is the sole authority for exact report,
section-result, constituent, and evidence-reference fields.
The result alternative `state` is distinct from the section's `classification`.
Do not split resources into separate state and measurement containers.

Every supplied reported section is a complete result. Omission preserves a section;
replacement never inherits values or timestamps. Unknown values use the component's
specified nulls. Failures use an error result. Withdrawal ends an assertion.
[Entities](../entities.md#reported-sections) defines classification behavior.

`observed_at` supplies the default original quantity time. A `source_times` entry
replaces that default for its named quantity. Explicit null means unknown time.
Each component page lists all allowed keys. Keys for absent optional quantities
and undeclared nested reserves are refused. No wildcard or arbitrary path is allowed.
Descriptions, Capabilities, authored Type and Geometry, Heartbeat, and derived
contact health do not accept `source_times`.

Examples on component pages show payloads without their enclosing report evidence.
Track copies retain original Observation scopes, IDs, and quantity times
under the [default policy](../tracks.md#default-policy).

## Contract source

The shared [runtime schemas](../schema-profile.md) encode these rules and export
the OpenAPI reference. Neither chooses different fields or defaults.
Core and SDK still need qualification of their consuming workflows.
