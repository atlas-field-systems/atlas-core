# Tasks and execution

**Core records intent. The Asset runtime schedules and executes it.**
Protocol owns the Command Catalog; each Asset advertises its supported subset.
Plugins are not Task targets and cannot add Asset Commands.

## Creation and state

One Task has immutable Asset, Command, inputs, scheduling choice, and validity
terms. Creation validates support, references, and retirement status, then assigns
a stable per-Asset submission sequence. Offline or busy does not itself prevent
acceptance. Exact retries allocate neither another Task nor another sequence.

States are `pending`, `acknowledged`, `in_progress`, `paused`,
`cancellation_requested`, `completed`, `failed`, and `cancelled`.
The last three are terminal and immutable. Reading an instruction is not an
acknowledgment. Only authorized Asset execution evidence establishes its outcome;
valid reports may skip intermediate states. There is no generic Task edit/delete.

Cancellation records an operator request, even when an Asset is offline or cannot
cancel. It becomes `cancelled` only when confirmed. A refusal restores the evidenced
execution state; progress alone cannot erase cancellation intent. Valid completion
or failure may win before cancellation is confirmed. Never invent a stopping outcome.

## Scheduling and controls

The Asset runs one queued Task at a time; supported immediate Commands may run
concurrently. Delayed reports can temporarily make Core's view look different.
Queue edits submit the complete eligible, unstarted order with retry identity and
a revision precondition. Requested order and Asset-confirmed adoption are distinct.

Started, paused-started, cancellation-pending, and terminal Tasks are not reorderable.
An unstarted cancellation-pending Task retains its internal queue slot so refusal
can restore it amid the latest eligible edits. Assigned-work pagination pins the
queue revision and refuses a changed page sequence.

Pause and Resume are immediate Tasks, not an emergency-stop guarantee. Pause
requires actual suspension and keeps queue order. Resume continues the same Task
first; inability to resume fails that Task and leaves the queue paused until another
explicit Resume. Pending cancellation must be resolved before resumption.

Controls follow Core acceptance order, not packet arrival. Superseded controls
cannot later take effect. Pause does not expire; expired Resume cannot unpause or
fall back to an older control. Command-specific deadlines remain explicit.

## References and results

Live geometry and deletion guards follow [Entity rules](entities.md). An Asset
records the geometry revision actually used. Removing advertised support does not
delete existing Tasks; the Asset reports an honest unsupported outcome.

**Completion is independent of file availability.** A scan can complete while a
result upload is missing. Append result declarations before or after termination,
including before upload. Invalid declarations do not block a separately valid
completion report. Declared required Objects remain protected until Reset.

## First Command

Queued coordinate **Move To** is the first execution workflow, with no deadline.
Its target is a complete position or a point Geofeature; optional altitude names
its reference. The Asset decides arrival and reports completion. Core cannot infer
success from a map position. Immediate Move To requires advertised support.

[Next: objects](objects.md)
