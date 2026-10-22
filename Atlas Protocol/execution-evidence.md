# Asset execution evidence

Task execution, Task result declarations, and queue adoption have independent
streams. They reuse the Asset origin type from [report format](report-format.md),
not its Entity-section envelope. They cannot carry sections or contact proof.
An execution report never establishes fresh Asset contact.

## Envelope

Each reporting message carries one `evidence` object with these exact fields.

| Field | Required meaning |
| --- | --- |
| `dataset_id`, `asset_id` | UUIDs identifying the current Dataset and live source Asset |
| `origin` | Exactly `{kind: "asset_process", process_generation: UUID}`, matching the Asset's current process |
| `report_id` | Stable source-assigned UUID for this submission |
| `sequence` | Positive uint64 decimal string in the independent stream below |
| `generated_at` | Original evidence creation timestamp or null when unknown |
| `payload` | Complete closed payload selected by the reporting message |

The addressed Task must belong to that Asset. Deleted Assets and obsolete processes
cannot submit new evidence. Current valid API authority is required even for retries.
The submitting key, gateway, and delivery packet never change source identity.

Report identity is scoped by Dataset, Asset, origin, message kind, and Task ID when
applicable. Task execution and results each have a separate per-Task sequence;
queue adoption has one per-Asset sequence. Exact accepted repeats recover the same
result. Changed scoped report facts or another report at an occupied sequence
return `409 evidence_conflict` atomically. No stream has an Asset-wide watermark.

## Execution payload

`ReportTaskExecution` requires `task_id`, `event`, and `state`. Event is `state` or
`cancellation_refused`. Ordinary state is `acknowledged`, `in_progress`, `paused`,
`completed`, `failed`, or `cancelled`. Refusal also permits `pending` for unstarted work.
Failures and refusals require nonblank `reason` of at most 64 Unicode scalar values.
Optional `message` is at most 1,024. Other fields are only those defined below.

A refusal names the outstanding `cancellation_request_id` and actual nonterminal
state. A `cancelled` report names that same outstanding request. Mismatch returns
`409 cancellation_changed`. Ordinary progress never clears cancellation intent.
A matching refusal clears intent without rolling back newer accepted progress.
For completed Pause/Resume, include the [control effect facts](task-controls.md#execution-evidence).
Before an effect, those fields are absent. Control failure does not fabricate an effect time.
Optional `geometry_revision` records the point Geofeature revision used by Move To.

Newer nonterminal execution evidence updates the retained execution state. Unseen
older progress is retained without rollback. A valid previously unseen terminal
outcome may finish nonterminal work even after newer progress was received; do not
discard terminal evidence by a progress watermark. Once terminal, exact repeats are
harmless and conflicting state changes return `409 terminal_state_conflict`.
For nonterminal work, the current process's first accepted execution report for that
Task supersedes prior-process state at any sequence, even 1 after 50. Later sequence
comparisons use that process's stream. Replacement never rewrites a terminal outcome
or restarts work.
Validate transitions and commit state, queue/control effects, evidence, and changes together.

## Result and queue payloads

`ReportTaskResults` requires `task_id` and `declarations` under
[Task result rules](tasks.md#references-and-results). Valid unseen declarations append
even when their sequence is older than a previously received result report. Duplicate
entries add nothing; conflicting declarations reject the entire report.

`ConfirmTaskOrder` requires `queue_revision`. The runtime supplies the revision it
actually adopted, never a future revision. Core retains source evidence and updates
confirmed adoption only without rolling back a newer confirmation from the current
process. An accepted replacement process can provide its own first confirmation.
A confirmation never edits requested order or proves physical Task execution.

Optional `control_revision` and `queue_state` must appear together. They reaffirm
an already accepted completed control's effect under the current process, with
the same queue state. Core resolves its Task ID from that revision and updates
`task_control.confirmed` without rolling back a newer current-process confirmation.
An unapplied or mismatched effect returns `409 control_not_confirmed`. This does
not reexecute or complete a control, and cannot replace fresh Resume evidence.

## Required examples

| Delivery | Required result |
| --- | --- |
| New telemetry, then unseen Task completion | Retain the Task completion independently |
| Progress while cancellation is requested | Update underlying evidence; preserve the request |
| Refusal naming an old cancellation request | Refuse without clearing the current request |
| Result report 11, then unseen declarations from report 10 | Retain both sets without repeated holds |
| Replay through another gateway | No repeated state, activity, declaration, or public effect |
| P1 reports progress 50 for A and B; P2 replaces it and reports paused 1 for each | P2's evidence becomes current for both Tasks without repeating work |
| P2 reaffirms a completed Pause through queue confirmation | Show the inherited pause under P2; keep the Pause Task terminal |
