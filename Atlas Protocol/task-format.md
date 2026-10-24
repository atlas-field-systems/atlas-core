# Task read format

A Task requires `dataset_id`, `task_id`, `request_id`, `asset_id`, `version`,
`command`, `inputs`, `scheduling`, `accepted_at`, `submission_sequence`,
`execution_state`, `cancellation_request_id`, and `result_declarations`. IDs are
UUIDs, version is a counter, acceptance is a timestamp, and submission sequence
is positive. Command fields use the Catalog; only Resume has `expires_at`.
Declarations use the [Task result set](tasks.md#references-and-results).

`execution_state` is pending, acknowledged, in_progress, paused, completed, failed,
or cancelled. With no pending cancellation, `cancellation_request_id` is null.
With a pending cancellation, the request ID is non-null and execution_state is
nonterminal. Terminal variants require a null pending request. The display state
cancellation_requested is derived, never another serialized field. Core retains
accepted execution evidence internally without adding a public evidence blob.
