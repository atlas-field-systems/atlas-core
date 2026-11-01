# Task read format

> Retained current design for review. [Planning status](../../../README.md#planning-status).

A Task requires `dataset_id`, `task_id`, `request_id`, `asset_id`, `version`,
`command`, `inputs`, `scheduling`, `accepted_at`, `submission_sequence`,
`execution_state`, `execution_summary`, `cancellation_request_id`, and
`result_declarations`. IDs are
UUIDs, version is a counter, acceptance is a timestamp, and submission sequence
is positive. Command fields use the Catalog; only Resume has `expires_at`.
Declarations use the [Task result set](tasks.md#references-and-results).

`accepted_at` is Core's timestamp of the Task's first successful admission.
Exact retries preserve it. Resume's immutable `expires_at` must be strictly later
than `accepted_at` and no more than 60 seconds after it, at exact nanosecond
precision. This interval remains valid in historical images after expiry;
reading an image does not compare expiry to the current clock.

`execution_state` is pending, acknowledged, in_progress, paused, completed, failed,
or cancelled. With no pending cancellation, `cancellation_request_id` is null.
With a pending cancellation, the request ID is non-null and execution_state is
nonterminal. Terminal variants require a null pending request. The display state
cancellation_requested is derived, never another serialized field. The compact `execution_summary` is null until execution evidence selects the
current state. Otherwise it contains the original `origin`, `report_id`, `sequence`,
and nullable `generated_at`, plus `event` and `state` from that report. `origin`
uses the existing Asset-process shape. `event` is `state` or `cancellation_refused`.
The summary state matches `execution_state`.

A failed state or cancellation refusal requires its reported `reason`. Cancelled
state and cancellation refusal include their reported `cancellation_request_id`.
Preserve `message` and `geometry_revision` exactly when supplied. Revision is
allowed only for Move To targeting a Geofeature. These fields have the same bounds
as [execution evidence](messages.md#execution-and-cancellation-evidence).
Omitted fields stay omitted, including when an older report had a value. Core
never invents a reason or infers a revision from the current target.

Only evidence that selects the current execution state replaces the summary,
even when that state is unchanged. Older or duplicate evidence cannot replace it.
The first accepted terminal report fixes the terminal summary; later reports of
the same terminal facts retain it. Cancellation requests and result declarations
do not replace it. The summary survives Restart and appears identically in Get,
list, assigned-work, snapshot, and change-feed Task images. Assigned-work selection
still excludes terminal Tasks. Detailed control proofs stay in retained evidence.
