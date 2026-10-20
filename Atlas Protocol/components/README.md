# Component field reference

This reference proposes fields, types, units, bounds, null and omission rules,
and JSON examples for Atlas resources. Exact field details remain proposals
unless explicitly agreed.

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

These are component proposals, not new Entity types or an arbitrary field registry.
Exact permitted Entity compositions still need schemas. Reference Asset examples
are a mounted gimbal camera, powered fixed-wing aircraft, a glider, a quadcopter,
and a commandless tracker that reports its own telemetry.

## Agreed behavior

[Entities](../entities.md#reported-sections) owns the distinction between state
until changed and dated measurements. [Reports](../reports.md#shared-context)
owns complete-section replacement, errors, ordering, and sparse report behavior.
Those rules apply to all proposed sections.
Component value-field requirements do not require healthy values in an error or
withdrawn result. Their exact wire representations remain to be specified.

## Shared proposed section fields

These fields apply to complete reported sections. Reusable values and authored
sections do not inherit them. Contact evidence has its own linked representation.

| Field | Type | Presence | Proposed meaning |
| --- | --- | --- | --- |
| `observed_at` | UTC timestamp string or null | Required | Original source observation time; null when unknown |
| `error` | Error object | Omitted when healthy | Present only for an actual reported error |

An Asset reports an actual section failure with a required string `code` and optional
string `message`. Reads expose the section error rather than reconstructing partial
success. Withdrawal follows [Reports](../reports.md#shared-context). A single
`observed_at` describes a coherent observation; mixed-time values retain their own ages.

Examples show values or section snapshots, not full authenticated API requests.
The proposed `state` and `measurements` group names remain undecided.

## Contract source

These pages are the human-readable place to refine field proposals. Accepted
machine-readable definitions belong in the [OpenAPI artifact](../README.md#contract-ownership).
Once authored, its schemas own exact structure and validation. These pages explain
them. There is no executable schema or generated package here yet.
