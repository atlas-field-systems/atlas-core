# Task messages

Task messages record requested Commands and the Asset's execution evidence.
They expose work as Tasks rather than arbitrary resource state edits.

## Work and execution

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `CreateTask` | Operator app or automation requests an advertised Asset Command, such as Move To or Pause | Stable Task and request IDs, target Asset, Command inputs, scheduling choice, and validity terms | Recorded Task and per-Asset submission sequence, or refusal under [Task rules](../tasks.md#creation-and-state) |
| `ListTasks` | Operator app reviews requested work and its reported progress | Bounded filters | Matching Task views |
| `GetTask` | Operator app or Asset runtime inspects one Task and its current recorded state | Task ID | Current Task view |
| `ReportTaskExecution` | Asset runtime reports acknowledgment, progress, or an execution outcome | Task identity and original Asset execution evidence | Accepted execution transition or an explicit refusal |
| `RequestTaskCancellation` | Operator app or automation asks the Asset to cancel requested work | Task identity and retry facts | Recorded cancellation intent under [Task rules](../tasks.md#creation-and-state) |
| `ReportTaskResults` | Asset runtime declares result files, including files it has not uploaded yet | Task identity, retry facts, and result declarations | Retained declarations, separate from file availability |
| `GetTaskObjects` | Operator app discovers available files associated with a Task | Task ID and bounded query | Associated Object metadata |

Move To, Pause, and Resume use `CreateTask` with their Command-specific inputs.
Core acceptance is not physical execution. Cancellation intent and accepted Asset
evidence of cancellation remain distinct. There is no generic Task edit or deletion.
Result declarations follow [References and results](../tasks.md#references-and-results).

## Assigned work

| Proposed message | Expected user and purpose | Input | Observable result |
| --- | --- | --- | --- |
| `GetAssignedTasks` | Asset runtime retrieves current instructions, including when reconciling after reconnect | Asset ID and bounded query context | Assigned Tasks with queue revision and paging context |
| `SetTaskOrder` | Operator app or planning automation requests a new order for eligible unstarted Tasks | Asset ID, complete eligible order, retry identity, and revision precondition | Recorded requested order and revision |
| `ConfirmTaskOrder` | Asset runtime confirms the requested queue order it actually adopted | Asset and process context, plus original evidence of the adopted order | Recorded confirmation, distinct from the requested order |

Queue eligibility, pagination consistency, and adopted order follow
[Scheduling and controls](../tasks.md#scheduling-and-controls). Asset execution and
order-confirmation evidence also follow the [report rules](../reports.md).

[Messaging index](../messaging.md)
