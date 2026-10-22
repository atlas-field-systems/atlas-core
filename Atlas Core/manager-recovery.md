# Manager continuity and local activity

One systemd manager owns an installation's process control, destructive actions,
and stopped-state activity. Its control directory is outside operational, Plugin,
and diagnostic storage. Core never edits its authority record. The manager never
edits Core's live database. [Lifecycle](lifecycle.md) owns action meanings.

## Action authority

The manager holds an installation-scoped Linux `flock` for its entire ownership.
A replacement acquires that same lock before acting. A PID file or expired timer
cannot transfer ownership. Loss of the lock stops new effects immediately.
First-use local setup creates a stopped authority record before any launch.
Missing authority after setup is damage, not permission to initialize over old data.

`authority.json` is bounded UTF-8 JSON with schema version `1`, installation UUID,
record revision, owner epoch, action UUID, kind, phase, predecessor/successor UUIDs,
old and intended Dataset UUIDs, activity epoch UUID, and requested final state.
Revisions and owner epochs are canonical uint64 decimal strings. Nullable IDs use
explicit null. Kinds are Start, Stop, Restart, Reset, Hard Reset, update, uninstall,
or configure. The record also holds selected artifact/configuration digests,
process identities, completed steps, and bounded primary/cleanup failure codes.
Owned storage labels resolve through installation configuration, never caller paths.

Phases are `intent`, `draining`, `writers_stopped`, `clearing`, `dataset_established`,
`starting`, `completed`, `failed`, or `superseded`. An action skips irrelevant phases.
Completed-step IDs never disappear. A failed action retains a separate verified phase
and unfinished steps. Repair resumes that action; it does not infer successful cleanup.
Every write checks the previous record revision under the lock, writes a new private
file, flushes it, atomically renames it, and flushes the directory before effects.
Missing/corrupt authority blocks mutation and unsafe Start; inspection exposes repair.

A force request records its confirmation and target action before terminating a
process. The same owner continues the original action after verified exit. A confirmed
whole-installation takeover first records the successor action and superseded
predecessor in one replacement. Only the successor can continue. Late callbacks
check owner epoch, action ID, and revision before changing state. Handoff preserves
verified steps, remaining cleanup, process IDs, and Dataset-establishment guards.

## Restart and process reconciliation

Manager restart acquires the lock, increments the flushed owner epoch, reads the
action, then inspects the recorded immutable Docker container IDs and Linux boot/PID
start markers. Matching live processes retain their identities and Core run.
A container name or a new process under the same PID is a different runtime.
Unavailable inspection means unknown exit and blocks destructive continuation.
Verified absence fences that runtime; it never proves that exposed work had no effect.

Reattach collectors and private channels only after identity verification. Pause new
Plugin dispatch until reconciliation completes. Stop managed Plugins after confirmed
Core loss, verify their writers exited, and preserve their evidence before cleanup.
No automatic Core/Plugin relaunch follows manager recovery. An outstanding explicit
Start/Restart action may finish its recorded launch step after reconciliation.

Core establishes a planned Dataset once, recording the action UUID, intended Dataset,
and activity epoch in its establishment transaction. It then flushes independent
establishment proof into the protected control directory before serving. Recovery
checks that proof and Core's retained marker without opening an ordinary writer.
If interrupted between commit and proof, Core may regenerate proof only from the
matching marker. Unavailable or conflicting establishment facts block unsafe Start
and require repair; they never permit another wipe. Proof allows only old cleanup.

## Local activity journal

The manager appends required local-action activity to `activity.journal` before
acknowledging it. Each record is a four-byte big-endian payload length, exact UTF-8
JSON payload, and 32-byte SHA-256 of that payload. The length excludes framing.
Flush each append. Atomic file replacement and directory flush apply to compaction.

Each payload has schema version `1`, installation UUID, activity-epoch UUID, stable
event UUID, contiguous positive uint64 sequence string, action UUID, UTC timestamp,
action kind, outcome, and `local_actor` with kind `local_admin` and a decimal uint32
host UID string. It invents no API key or operator. Dataset UUID is explicit null
before first establishment. Otherwise it names the recorded action's Dataset.
Outcomes are `started`, `succeeded`, `failed`, or `superseded`. Optional safe primary
and cleanup codes preserve both failures. No secrets, arbitrary errors, or payloads.

The manager exposes a flushed immutable prefix for import while later appends continue.
Core imports before serving and on private maintenance calls while already running.
Core validates framing, checksum, sequence, epoch, and payload. It imports bounded
chunks with activity and frontier in one transaction, unique by installation,
epoch, and event UUID. Exact repeats recover the same import result; changed facts
under an event ID fail. A missing sequence, torn tail, bad checksum, or inaccessible
journal blocks successful import and ordinary startup until explicit repair.
The manager compacts only through Core's durable acknowledgment of a contiguous
frontier. Compaction preserves sequence numbers. Lost acknowledgment resends the same IDs.

Admission reserves journal room for final outcomes before effects. At its finite
[limit](limits.md), reject new actions that cannot retain required evidence. Keep
inspection and confirmed stop reachable using the reserved authority record; an
activity-storage failure remains visible and cannot become successful import.

Reset first records its new activity epoch under action authority, stops writers,
and clears the old journal and imported activity. New-Dataset establishment binds
the new epoch. Import only that epoch before serving. Retained authority and
establishment proof do not become post-Reset activity. Reset completion may create
a new-epoch event. Hard Reset removes setup and old activity but retains minimal
in-progress authority until verified completion, then initializes first-use control.
