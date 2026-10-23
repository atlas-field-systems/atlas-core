# Coverage change controls

An optional addition joins the existing picture at one complete commit boundary.
Its staged data is unreadable until that join. Failure leaves existing ready
coverage available. Coverage change is temporary subscription work, not a domain write.
Every control, result, and staged event below includes `change_sequence` in `data`.
It uses the [positive sequence domain](limits.md#exact-numeric-domains), scoped to
one subscription and independent of `coverage_revision`. Core orders control-state
changes by arrival on that connection. Async work rechecks the active sequence.

## Stage and align

`BeginCoverageChange` requires `subscription_id`, `change_sequence`,
`expected_coverage_revision`, `target_coverage`, and an addition's `baseline_cursor`.
The client first pages a capture containing exactly the added coverage. Dataset
and limits must match. Its release does not prevent catch-up from the retained
baseline. Narrowing coverage omits `baseline_cursor`.
Core permits one change at a time per subscription and returns `coverage_staging`
with `subscription_id`, `change_sequence`, `target_coverage_revision`, and the capture's `baseline_cursor`
when adding. An exact control retry repeats the existing result, never another load.
The highest admitted sequence starts at zero. Core admits a higher sequence only when no attempt
is active and the expected coverage revision matches. Gaps are harmless. Admission
records the high-water mark and active receipt together; refused Begins change
neither. Resolve active or most-recent finalized receipts before those preconditions.
A stale `expected_coverage_revision` returns `409 coverage_changed` without admission.
Conflicting facts for an already accepted control return `409 change_conflict`.
Earlier pruned sequences return `410 change_ended`. A concurrent new attempt returns
`409 coverage_change_busy`. Other controls for an unknown sequence return `404 change_not_found`.

Core retains the highest admitted sequence, one active receipt, and one most-recent
finalized receipt. Abort and failure end the attempt without changing the working
coverage revision. A control for a finalized attempt returns its recorded final
outcome, including Abort after a successful join whose reply was lost.
A new connection/subscription starts a new sequence scope; never attach old controls
to it. This bounds receipts without losing the fence after repeated failures.

Core sends `staged_batch` and `staged_progress` with `subscription_id`, `change_sequence`,
and the same cursor/change fields as ordinary data, projected only to the addition.
The staged chain uses that subscription and sequence. Its `coverage_revision` equals
the returned `target_coverage_revision`; its initial cursor is the addition's baseline.
Its `previous_cursor` matches its own last completely
applied cursor. The existing projection keeps its separate cursor. A commit may
appear in both chains; neither advances the other's cursor or counts as its duplicate.
Reserve staged data, buffering, and a full combined-message allowance within the
existing picture and update budgets before accepting the change.

After staged catch-up, `RequestCoverageCutover` requires `subscription_id`,
`change_sequence`, and `expected_coverage_revision`. Core fixes barrier B once at its current
committed log end. It sends existing and staged streams through B, then emits
`coverage_barrier` with `subscription_id`, `change_sequence`, and `barrier_cursor`.
This barrier replies to `RequestCoverageCutover` and echoes its top-level `request_id`.
It pauses that subscription after B and buffers later whole commits within its
existing connection budget. It never pauses Core writes or other subscriptions.

The client applies both streams through B and validates the resulting combined
projection. It sends `CommitCoverageChange` with `subscription_id`, `change_sequence`,
`barrier_cursor`, and `expected_coverage_revision`. Core replies `coverage_changed`
with `subscription_id`, `change_sequence`, new `coverage_revision`, `coverage`, and
`start_cursor: B`. Subsequent batches use that revision and start strictly after B.
Only on this matching reply does the client atomically publish the addition.
The new combined chain starts at B. Late results must match the pending attempt
before changing staging or published coverage.
The existing picture never rolls back to the capture baseline.

## Abort, expiry, and disable

The barrier wait is at most ten monotonic seconds. A timeout, unfit combined commit,
or full buffer aborts the pending change with `coverage_change_failed`, naming
`subscription_id`, `change_sequence`, `reason`, and `last_complete_cursor`.
A failure answering a control echoes its top-level `request_id`; an unsolicited
failure event omits it, under the [framing rules](synchronization-messages.md#authentication-and-framing).
`last_complete_cursor` is Core's last completely emitted original-projection cursor,
not proof of client application. Core continues that ordered projection from there
if the retained/buffered range is available; otherwise it emits an ordinary gap.
The client discards staged data, keeps the requested addition unavailable, and
releases the capture. It does not silently change the requested options.

`AbortCoverageChange` requires `subscription_id` and `change_sequence`. An active
attempt ends as `coverage_change_failed` with reason `aborted`; a completed join
returns its original `coverage_changed`. It cannot undo or misreport that join.
Exact retries recover the recorded final outcome while the connection exists.
Connection loss ends pending server state.
The client reconnects from its last complete published cursor with its published
coverage. It can discard staging and explicitly retry; no uncertain join is assumed.

Disabling uses the same barrier and completion without addition staging. At the
matching reply, release removed local coverage and invalidate its dependent views,
cursors, and subscriptions. Late events with the old change/revision cannot restore
it. Unrelated coverage and HTTP history tokens retain their original meanings.
Re-enabling uses a fresh addition load.

If a ready optional addition fails during ordinary operation, the client marks it
unavailable at its last complete cursor and starts a narrower subscription there.
It applies no selected effect past that cursor until the narrower projection is
established. The addition stays requested; no automatic HTTP fallback occurs.
Base synchronization can continue only while its own bounds permit it.

[Synchronization](synchronization.md#changing-coverage)
