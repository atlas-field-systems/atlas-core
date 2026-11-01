# Report format

> Retained current design for review. [Planning status](../../../../README.md#planning-status).

This page owns the exact report fields for `UpdateAsset`, `CreateObservation`, and `ReportObservation`.
Authored changes and contact exchanges retain their owning contracts. [Wire](../../shared/http/wire.md)
owns UUIDs, timestamps, parsing, and counter representation. Messages carry this
envelope in `report`, required for `ReportObservation` and optional for the other two.
Omit it when creation or an update supplies only authored data. Its IDs must match
the addressed resource and Dataset.

## Report envelope

| Field | Presence and exact meaning |
| --- | --- |
| `dataset_id`, `entity_id` | Required UUIDs naming the Dataset and reported Asset or Observation |
| `origin` | Required object, exactly `{kind: "asset_process", process_generation: UUID}` for Assets or `{kind: "publisher", publisher_id: UUID}` for Observations |
| `report_id` | Required source-assigned UUID, immutable within Dataset, Entity, and origin scope |
| `sequence` | Required positive unsigned 64-bit decimal string, `"1"` through `"18446744073709551615"`; applies independently to each supplied section |
| `generated_at` | Required original report creation timestamp or null when unknown; not a substitute for measurement times |
| `mode` | Required, exactly `current` or `history_only`; a history-only report never replaces current results |
| `sections` | Required object of complete results keyed only by that Entity's reportable fields in [composition](../structure.md#component-composition); Asset `communications` means capacity |
| `contact_proof` | Optional [Heartbeat proof](../assets/components/heartbeat.md), only for current Asset reports |

At least one section is required, except a current Asset contact-proof report may
have `sections: {}`. Observation envelopes forbid contact proof and Asset origin.
Authored Description, Capabilities, and Asset Type are not reported sections.
Unknown fields, null containers, and inapplicable fields are refused.

## Complete section results

| Field | Presence and exact meaning |
| --- | --- |
| `state` | Required, exactly `value`, `error`, or `withdrawn` |
| `classification` | Required, exactly `state_until_changed` or `dated_measurement` |
| `observed_at` | Required original default quantity timestamp or null when unknown |
| `source_times` | Optional only with `value`; keys and nested structure are closed by the [component reference](../components/README.md#shared-section-results); leaves are timestamps or null |
| `value` | Required only with `state: "value"`; complete component payload |
| `error` | Required only with `state: "error"`; exactly required nonblank string `code`, at most 128 Unicode scalar values, and optional non-null string `message`, at most 512 Unicode scalar values |
| `constituents` | Required only for sourced Telemetry `value`; object with exactly the supplied Telemetry quantity keys, each containing the reading evidence below |

A withdrawal has neither value nor error. No result inherits earlier fields or times.
Every read result adds read-only `evidence`, exactly
`{dataset_id, entity_id, origin, report_id, sequence, section}`, referencing its
accepted source report. `section` is the section's wire name. Source-free initial
values alone use `evidence: null`. Track copies retain the original Observation
reference. Input results forbid read-only fields.

Every read result also adds Core-assigned `time_status`. A value has an object
with one `known`, `unknown`, or `uncertain` leaf for every supplied quantity in
`source_times`' vocabulary, including quantities using the default `observed_at`.
Geometry uses `geometry`. Power includes `external_power` and `reserves`, keyed
by every reserve ID with its applicable quantity leaves. Optional quantities
have a status exactly when present in the value. Error and withdrawn results use
one status string for `observed_at`. Source-free initial quantities are `unknown`.
A status is `unknown` exactly when its effective source time is null. Core retains
first-admission status under the [time rule](reports.md#time-and-contact).
Publishers cannot supply or override it; invalid or incomplete metadata is refused.

Each constituent is exactly `{origin, reading_id}`.
The ID is a source-assigned UUID with immutable reading facts.
Scope is Dataset, original Entity, origin, and quantity. Null values also need identities.
New readings use the envelope origin and get new IDs, even with equal values and times.
Carrying forward retains origin, ID, value, and original effective source time.
An older Asset origin is allowed only for a retained reading of that same Asset.
Tracks never replace the original Entity or origin with their own.

[Evidence admission](evidence.md) owns the effects of these fields.
