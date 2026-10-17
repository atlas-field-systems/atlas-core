# Component field reference

**Start here to review the fields and JSON layout proposed for Atlas resources.**
Each page lists intended fields, types, units, bounds, null/omission choices,
examples, and decisions still open. Proposed details are not approved contracts.

| Reportable section | Purpose | Used by |
| --- | --- | --- |
| [Telemetry](telemetry.md) | One complete location and motion section | Assets and applicable Track observations |
| [Gimbal](gimbal.md) | One complete pointing section | Assets with a gimbal |
| [Camera Optics](camera-optics.md) | Baseline field of view at 1x zoom | Assets with a camera |

Telemetry documents the reusable [Position](telemetry.md#position) and
[Altitude](telemetry.md#altitude) values inline. Command inputs can reference those
same definitions without adopting the complete Telemetry section.

These are component proposals, not new Entity types or an arbitrary field registry.
Exact permitted Entity compositions still need schemas. Reference Asset examples
are a mounted gimbal camera, powered fixed-wing aircraft, a glider, a quadcopter,
and a commandless tracker that reports its own telemetry.

## Agreed behavior

[Entities](../entities.md#reported-sections) owns the distinction between state
until changed and dated measurements. [Reports](../reports.md#shared-context)
owns complete-section replacement, errors, ordering, and sparse report behavior.
Those rules apply to the proposed sections below without being redefined here.

## Shared proposed section fields

These fields apply to complete reported sections. Reusable value types do not
include reporting metadata.

| Field | Type | Presence | Proposed meaning |
| --- | --- | --- | --- |
| `observed_at` | UTC timestamp string or null | Required | Original source observation time; null when unknown |
| `error` | Error object | Omitted when healthy | Present only for an actual reported error |

Propose an error object with a required string `code` and optional string `message`.
The allowed codes and handling of failures affecting only part of a section remain
undecided. A single `observed_at` works for a coherent observation; representation
of mixed source times is also undecided. Bundling must preserve original ages.

Examples show values or section snapshots, not full authenticated API requests.
The proposed `state` and `measurements` group names remain undecided.

## Contract source

These pages are the human-readable place to refine field proposals. Accepted
machine-readable definitions belong in the [OpenAPI artifact](../README.md#contract-ownership).
Once authored, its schemas own exact structure and validation; these pages explain
them. There is no executable schema or generated package here yet.
