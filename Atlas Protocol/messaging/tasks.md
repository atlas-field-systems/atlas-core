# Task messages

Task messages record requested Commands and the Asset's execution evidence.
They expose work as Tasks rather than arbitrary resource state edits.

## Work and execution

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `CreateTask` | Operator app or automation requests an advertised Asset Command, such as Move To or Pause | Stable Task and request IDs, target Asset, Command inputs, scheduling choice, and validity terms | Recorded Task and per-Asset submission sequence, or refusal under [Task rules](../tasks.md#creation-and-state) |
| `ListTasks` | Operator app reviews requested work and its reported progress | Bounded filters | Matching Task views |
| `GetTask` | Operator app or Asset runtime inspects one Task and its current recorded state | Task ID | Current Task view |
| `ReportTaskExecution` | Asset runtime reports acknowledgment, progress, or an execution outcome | Task identity and original Asset execution evidence | Accepted execution transition or an explicit refusal |
| `RequestTaskCancellation` | Operator app or automation asks the Asset to cancel requested work | Task identity and retry facts | Recorded cancellation intent under [Task rules](../tasks.md#creation-and-state) |
| `ReportTaskResults` | Asset runtime declares result files, including files it has not uploaded yet | Task identity, retry facts, and result declarations | Retained declarations, separate from file availability |
| `GetTaskObjects` | Operator app discovers available files associated with a Task | Task ID and bounded query | Ready Objects from declarations or metadata associations, deduplicated |

Move To, Pause, and Resume use `CreateTask` with their Command-specific inputs.
The [Catalog](../command-catalog.md) fixes inputs, scheduling, and validity.
Core acceptance is not physical execution. Cancellation intent and accepted Asset
evidence of cancellation remain distinct. There is no generic Task edit or deletion.
Result declarations follow [References and results](../tasks.md#references-and-results).

## Assigned work

| Message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `GetAssignedTasks` | Asset runtime retrieves current instructions, including when reconciling after reconnect | Asset ID and bounded query context | Assigned Tasks, recoverable requested order and confirmed adoption, with queue revision and paging context |
| `SetTaskOrder` | Operator app or planning automation requests a new order for eligible unstarted Tasks | Asset ID, complete eligible order, retry identity, and revision precondition | Recorded requested order and revision |
| `ConfirmTaskOrder` | Asset runtime confirms adopted queue order and optionally an inherited control effect | Original adoption evidence and optional paired control confirmation | Recorded observations, distinct from requested intent |

Queue eligibility, pagination consistency, and adopted order follow
[Scheduling and controls](../tasks.md#scheduling-and-controls). Asset execution and
order-confirmation evidence also follow the [report rules](../reports.md).

## Execution and cancellation evidence

`ReportTaskExecution`, `ReportTaskResults`, and `ConfirmTaskOrder` use the
[execution evidence envelope](../execution-evidence.md). It defines distinct payloads,
source scopes, sequence handling, cancellation refusal, and whole-report atomicity.

`RequestTaskCancellation` requires `task_id` and stable `request_id`. Core returns
the Task with `cancellation_request_id` equal to that request ID and retained
`execution_state` while pending. The overlay never becomes an execution state.
An exact retry recovers that intent. A different request while one is outstanding
returns `409 cancellation_pending`. A terminal Task returns its existing outcome.

Refusal and cancellation reports must name the outstanding request under the
evidence contract. `GetTask.result_declarations` exposes the complete append-only
set. Progress and declaration streams never clear cancellation intent.

## Assigned-work fields

`GetAssignedTasks` requires `asset_id`, `process_generation`, fresh `read_id`,
and bounded paging context. A continuation retains its original read ID.
Result `data` contains `asset_id`, the echoed process/read IDs, `tasks`, nullable
`next_page_token`, and the complete queue/control/capture fields defined below.
`tasks` includes all nonterminal assigned work; terminal controls remain described
by `task_control` and can be inspected through `GetTask`, never executed again.
Its complete queue/control context and instruction expiry follow
[fresh Resume](../task-controls.md#fresh-resume). Ordinary reads can inspect expired
instructions, but cannot use them to Resume. Obsolete processes return
`409 generation_mismatch`.
`SetTaskOrder` requires `request_id`, `asset_id`, `expected_queue_revision`, and
`task_ids`. Queue adoption uses the execution-evidence contract above. Only the
current process can provide new adoption evidence.

[Messaging index](../messaging.md)

## Concrete results and continuation

Create, get, and cancellation return the complete Task. Execution and results
reports return `{task, evidence_disposition}` with accepted or duplicate disposition.
SetTaskOrder returns the complete Asset; ConfirmTaskOrder returns
`{asset, evidence_disposition}`. Task object reads use task_id on the first page.
Assigned first pages require asset_id, process_generation, read_id and optional
page_size. A continuation supplies only page_token. Every assigned reply repeats
asset_id, process_generation, read_id, core_run_id, captured_at,
instructions_valid_until, task_queue and task_control, plus tasks and
next_page_token. Instructions expiry must be after capture; tasks belong to the
named Asset and are nonterminal.
