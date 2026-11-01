# Queue Pause and Resume

> Retained current design for review. [Planning status](../../../README.md#planning-status).

Pause persists until a valid Resume takes effect. An empty queue does not clear
the gate. Tasks appended while paused wait. Core records intent and Asset evidence
separately; a later accepted Pause is not proof of physical suspension.

## Observed control order

Each accepted Pause or Resume advances the Asset's `control_revision`, starting
from `"0"`. `task_control` in Asset reads and synchronized images contains:

| Field | Meaning |
| --- | --- |
| `revision` | Latest Core-accepted control revision |
| `requested` | Null initially, otherwise `{task_id, command, expires_at}`. Pause uses null expiry |
| `confirmed` | Null initially, otherwise `{revision, task_id, process_generation, queue_state}` from Asset evidence |

`queue_state` is `paused` or `running`. Confirmation describes that process's
observed effect. A confirmation for an older revision or process is not confirmation
of the latest request. Null means unconfirmed, not running. A successful control
report commits its Task outcome and Asset confirmation together.
`ConfirmTaskOrder` can [reaffirm an inherited effect](execution-evidence.md#result-and-queue-payloads)
under a new process without reexecuting or changing its completed control Task.

The runtime persists its highest observed revision within the Dataset and acts in
Core order. It never applies a lower revision after observing a higher one.
It does not apply a superseded control or fall back to an older control after
expiry or failure. Execution outcomes of old controls remain evidence of what
actually happened. They cannot roll back a newer accepted confirmation.

## Fresh Resume

Before clearing a pause gate, the Asset starts a new `GetAssignedTasks` read with
a fresh `read_id` and its current `process_generation`. The first response echoes
those fields and returns `core_run_id`, `captured_at`, `instructions_valid_until`,
`task_queue`, and `task_control`. Core sets instruction validity to ten seconds
from capture. All continuation pages repeat that captured context.

The runtime requires all of these conditions:

1. A trusted Core response matches the pending read, Dataset, exact Protocol version,
   Asset, and process. A gateway preserves this response and does not answer from cache.
2. It obtains all pages without `queue_changed`. The round trip from read start
   is under ten monotonic seconds, and current UTC precedes `instructions_valid_until`.
3. The captured latest request is this Resume, its revision is no lower than the
   runtime's highest observed revision, and no newer control has since been observed.
4. Resume is nonterminal, not already applied, and unexpired at the physical
   unpause boundary. Pending cancellation is resolved; remaining work is reconciled.

Failure leaves the gate paused. A fresh read can retry reconciliation while the
Resume remains valid. A new process reconstructs paused/executing work from its
durable evidence and current instructions. Process replacement alone cannot unpause
or repeat uncertain work. An old Core-run response cannot satisfy a new-run read.

These checks prove a recent instruction observation, not knowledge of a later
unseen Core commit. A Pause accepted after capture may still be in transit when
Resume takes effect. The runtime applies that Pause when observed and reports the
actual effects in order. Core never presents acceptance as a remote execution lock.

## Execution evidence

The [execution envelope](execution-evidence.md) carries source identity and ordering.
A completed control payload includes `control_revision`, `queue_state`, and
`applied_at`. Other states omit those effect fields; never invent an effect time.
A completed Resume also echoes `read_id`, `core_run_id`, `captured_at`,
`instructions_valid_until`, and `queue_revision` from its read. Its applied time
must follow capture and precede both instruction and Resume expiry. Retain those
facts as evidence of the observed boundary, without asserting unseen control state.

An Asset that proves a control never applied reports `failed` with `expired`,
`superseded`, or `resume_failed` as applicable. Core cannot generate that physical
conclusion from its own clock or acceptance order. Valid delayed execution before
the applicable cutoff remains admissible. Terminal Task states stay immutable.

## Required examples

| Event | Required behavior |
| --- | --- |
| Apply Pause with no work, then append two Move To Tasks | Both wait in appended order until valid Resume |
| Pause a running Move To, then Resume | Continue that Task before the next one |
| Cancel the paused Task, then Resume | Start the next eligible Task |
| Receive old Resume after observing a newer Pause | Keep the pause gate |
| Resume cannot continue the remaining paused Task | Fail both Tasks and keep the gate paused |
| Core accepts Pause after the last fresh instruction read | Show intent until Asset evidence confirms its actual effect |

[Tasks](tasks.md)
