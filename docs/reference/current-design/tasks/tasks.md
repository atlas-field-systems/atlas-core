# Tasks and execution

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**Core records intent. The Asset runtime schedules and executes it.**
The [initial Command Catalog](commands.md) contains queued Move To and
immediate Pause and Resume. An Asset advertises its supported subset. Commands
remain Protocol-defined. Task targets must be registered Assets.

## Creation and state

A [Task read image](read-format.md) has immutable `task_id`, `asset_id`, `command`, `inputs`, `scheduling`, and
validity facts. Core validates support, references, and the live target Asset, then
assigns `submission_sequence`. Offline or busy does not prevent acceptance.
Exact retries allocate neither another Task nor another sequence.

States are `pending`, `acknowledged`, `in_progress`, `paused`,
`cancellation_requested`, `completed`, `failed`, and `cancelled`.
The last three are terminal and immutable. Reading instructions is not acknowledgment.
Accepted Asset evidence establishes execution state and may skip intermediate states.
Core never infers physical effect, cancellation, or completion from silence or position.
There is no generic Task edit or deletion.

Cancellation sets a nonterminal Task to `cancellation_requested` and retains its
last evidenced execution state. Progress can update that evidence without clearing
its request. An accepted `cancelled` report confirms that cancellation took effect.
`completed` or `failed` may finish work before cancellation takes effect, even
after Core recorded the request. A terminal Task cannot later become cancelled.

An explicit refusal must name the outstanding cancellation request and evidence
the actual execution state. Only that refusal clears the request and restores the
evidenced state. Ordinary progress, expiry, or disconnection cannot clear it.
The [Task message payloads](messages.md#execution-and-cancellation-evidence)
define matching and retry behavior.

## Scheduling and controls

An Asset runs one queued Task at a time. Pause and Resume use the separate
[control contract](controls.md). Two accepted Move To Tasks run sequentially.
Core does not reject overlapping movement intent or choose a diversion policy.

`task_queue` in every Asset read and synchronized image contains
`requested_task_ids`, `revision`, and `confirmed`. The ID list includes every
unstarted queued Task in requested execution order, including a cancellation-held
slot. `confirmed` is null or `{revision, process_generation}` from accepted
adoption evidence. An old revision or process is not adoption of the current order.
Initially the list is empty, `revision` is `"0"`, and `confirmed` is null.
There is no second historical order list. Submission sequence and Task-list sort
order do not define execution order.

New queued Tasks append after the current requested order, including while paused.
`SetTaskOrder` supplies every eligible unstarted ID exactly once and
`expected_queue_revision`. Started, paused-started, cancellation-requested, and
terminal Tasks cannot be reordered. A cancellation-held unstarted slot stays fixed
while eligible IDs fill the other slots. Refusal restores that Task in its slot.
Starting or terminating work removes its slot. A cancelled held Task also loses its slot.

Order, membership, or reorder-eligibility changes advance queue revision and Asset
version. This includes cancellation requests and refusals for held unstarted slots.
Adoption alone advances Asset version. Related Task changes and the final Asset image
commit atomically. The initial limit is 1,000 nonterminal Tasks per Asset, including
immediate controls. Admission reserves room for cancellation and terminal evidence.
An admission limit never blocks an already accepted Task's terminal report.

Assigned-work pages repeat the first page's complete queue and captured adoption,
including an empty list. Task bodies sort by ID. Tokens bind queue revision and
the captured control revision. Changed order, eligibility, or control refuses
`409 queue_changed`; start a fresh read. Adoption alone leaves the sequence valid.
Fresh reads and synchronization expose later adoption. No paged response proves
that a later unseen control does not exist.

## References and results

Geofeature guards follow [Entity rules](../entities/structure.md#geometry-and-references).
Track-targeting Commands use the shared Track ID. Fusion cannot rewrite immutable
Task inputs. The initial Catalog has no Track-targeting Command.
Asset deletion follows [Identity](../support/identity.md#deletion-and-revocation).
Removing advertised support preserves existing Tasks. The Asset reports `unsupported`
when it cannot execute them.

**Completion is independent of file availability.** Result declarations can arrive
before upload or after termination. Their append-only set contains
`{object_id, required}` entries, at most 128 per Task. Repeating an entry is harmless.
Changing its `required` value conflicts. A declaration cannot resurrect a deleted Object.
Invalid declarations do not block a separately valid completion report.
Required declarations create [Object holds](../objects/objects.md#metadata-references-and-deletion)
until Reset. Completion, cancellation, or Asset deletion does not release those holds.

`GetTaskObjects` returns the deduplicated union of ready Objects declared by the
Task and ready Objects whose metadata associates them with that Task. Upload
metadata need not repeat a declaration's Task association. Removing an association
cannot hide a declared ready result. Missing uploads remain declarations in
`GetTask`, not public Object placeholders or successful empty downloads.

## Move To

Move To is queued only, with no deadline. Its target and altitude use the
[Catalog inputs](commands.md#move-to). The Asset decides arrival and reports
completion. Core acceptance or a map position never proves arrival.

[Next: Objects](../objects/objects.md)
