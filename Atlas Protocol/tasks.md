# Tasks and execution

**Core records intent. The Asset runtime schedules and executes it.**
Protocol owns the Command Catalog; each Asset advertises its supported subset.
The initial Catalog contains only Move To, Pause, and Resume. Plugins are not Task
targets and cannot add Asset Commands.

## Creation and state

One Task has immutable Asset, Command, inputs, scheduling choice, and validity
terms. Core validates support, references, and the target Asset's existence. It then
assigns a stable per-Asset submission sequence. Offline or busy does not itself prevent
acceptance. Exact retries allocate neither another Task nor another sequence.

States are `pending`, `acknowledged`, `in_progress`, `paused`,
`cancellation_requested`, `completed`, `failed`, and `cancelled`.
The last three are terminal and immutable. Reading an instruction is not an
acknowledgment. Accepted execution reports establish progress, completion, or failure;
valid reports may skip intermediate states. There is no generic Task edit/delete.

An operator's cancellation request changes a nonterminal Task to
`cancellation_requested`. The external Asset runtime discovers the request, handles
cancellation, and reports `cancelled` once cancellation has taken effect. Core records
`cancelled` only after accepting that report. Receipt alone is not cancellation.

While awaiting confirmation, the Task remains nonterminal, including when the Asset
is offline. Progress reports cannot erase the request. If the Asset completes work
before receiving cancellation, it reports `completed`; Core accepts that outcome
even after recording `cancellation_requested`. Completion supersedes the outstanding
request. Valid failure may also finish the Task before cancellation takes effect.
Core never infers cancellation or completion from a timeout or disconnection.

An explicit cancellation refusal clears the request and restores the last evidenced
execution state. Ordinary progress does not count as refusal.

## Scheduling and controls

The Asset runs one queued Task at a time; supported immediate Commands may run
concurrently. Delayed reports can temporarily make Core's view look different.
Queue edits submit the complete eligible, unstarted order with retry identity and
a revision precondition. Requested order and Asset-confirmed adoption are distinct.

Started, paused-started, cancellation-requested, and terminal Tasks are not
reorderable. An unstarted cancellation-requested Task retains its internal queue
slot so refusal can restore it amid the latest eligible edits. Assigned-work
pagination pins the queue revision and refuses a changed page sequence.

Asset reads and synchronized images embed a bounded `task_queue`, including empty
queues. It contains the complete requested Task IDs in execution order, their
revision, and the last confirmed revision with its confirming process generation.
Confirmation is null before any adoption. An older revision or process is older
evidence, not adoption of the current request. Do not retain a second historical
order list. Submission sequence and Task-list sorting do not define execution order.

Order or eligible-membership changes advance the queue revision and Asset version.
Adoption alone advances the Asset version. Related Task changes and the final Asset
image commit atomically. Qualify the queue bound against page and whole-commit limits
before fixing its numeric limit in the schema.

Assigned-work pages repeat the first page's complete queue and captured adoption,
including empty work. Task bodies page by ID. Changed order or eligibility refuses
`409 queue_changed`; the caller starts a fresh read. Adoption alone leaves the page
sequence valid. Fresh reads and synchronization expose later adoption.

Pause and Resume are immediate Tasks, not an emergency-stop guarantee. Pause
requires actual suspension and keeps queue order. Resume continues the same Task
first; inability to resume fails that Task and leaves the queue paused until another
explicit Resume. Pending cancellation must be resolved before resumption.

Controls follow Core acceptance order, not packet arrival. Superseded controls
cannot later take effect. Pause does not expire; expired Resume cannot unpause or
fall back to an older control. Command-specific deadlines remain explicit.

An Asset that confirms a control never applied reports `failed` with an `expired`
or `superseded` reason. Without that evidence, its outcome remains unresolved.
Accept valid delayed evidence of execution before the cutoff; terminal states remain immutable.

## References and results

Geofeature deletion guards follow [Entity rules](entities.md). Tracks remain retained records.
Commands that target a detected subject reference its shared Track ID, not an
Observation ID. Fusion changes cannot silently replace a Task's immutable inputs.
Asset deletion and retained Tasks follow [Identity](identity.md#deletion-and-revocation).
Removing advertised support does not delete existing Tasks; the Asset reports
an honest unsupported outcome.

**Completion is independent of file availability.** A scan can complete while a
result upload is missing. Append result declarations before or after termination,
including before upload. Invalid declarations do not block a separately valid
completion report. Declared required Objects remain protected until Reset.

## Move To

Queued coordinate **Move To** has no deadline.
Its target is a complete position or a point Geofeature; optional altitude names
its reference. The Asset decides arrival and reports completion. Core cannot infer
success from a map position. Immediate Move To requires advertised support.

[Next: Operations](operations.md)
