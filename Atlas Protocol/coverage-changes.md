# Coverage change controls

An optional addition joins the existing picture at one complete commit boundary.
Its staged data is unreadable until that join. Failure leaves existing ready
coverage available. Coverage change is temporary subscription work, not a domain write.

## Stage and align

`BeginCoverageChange` requires `subscription_id`, stable `change_id`,
`expected_coverage_revision`, `target_coverage`, and an addition's `baseline_cursor`.
The client first pages a capture containing exactly the added coverage. Dataset
and limits must match. Its release does not prevent catch-up from the retained
baseline. Narrowing coverage omits `baseline_cursor`.
Core permits one change at a time per subscription and returns `coverage_staging`
with `change_id`, `target_coverage_revision`, and the capture's `baseline_cursor`
when adding. An exact control retry repeats the existing result, never another load.
Change identity is scoped to the expected revision. Retain one active and one most
recent finalized receipt per subscription. Older expected revisions return
`409 coverage_changed`; pruned receipts cannot restart an old change.

Core sends `staged_batch` and `staged_progress` with `subscription_id`, `change_id`,
and the same cursor/change fields as ordinary data, projected only to the addition.
The existing projection continues independently. The client reserves staged data,
buffering, and a full combined-message allowance before accepting the change.
All bounds include the existing picture and its update reserve.

After staged catch-up, `RequestCoverageCutover` requires `subscription_id`,
`change_id`, and `expected_coverage_revision`. Core fixes barrier B at its current
committed log end. It sends existing and staged streams through B, then emits
`coverage_barrier` with `subscription_id`, `change_id`, and `barrier_cursor`.
It pauses that subscription after B and buffers later whole commits within its
existing connection budget. It never pauses Core writes or other subscriptions.

The client applies both streams through B and validates the resulting combined
projection. It sends `CommitCoverageChange` with `subscription_id`, `change_id`,
`barrier_cursor`, and `expected_coverage_revision`. Core replies `coverage_changed`
with `subscription_id`, `change_id`, new `coverage_revision`, `coverage`, and
`start_cursor: B`. Subsequent batches use that revision and start strictly after B.
Only on this matching reply does the client atomically publish the addition.
The existing picture never rolls back to the capture baseline.

## Abort, expiry, and disable

The barrier wait is at most ten monotonic seconds. A timeout, unfit combined commit,
or full buffer aborts the pending change with `coverage_change_failed`, naming
`subscription_id`, `change_id`, `reason`, and `last_complete_cursor`.
`last_complete_cursor` is Core's last completely emitted original-projection cursor,
not proof of client application. Core continues that ordered projection from there
if the retained/buffered range is available; otherwise it emits an ordinary gap.
The client discards staged data, keeps the requested addition unavailable, and
releases the capture. It does not silently change the requested options.

`AbortCoverageChange` requires `subscription_id` and `change_id` and returns
`coverage_change_aborted` with those IDs. It is idempotent and cannot undo a completed
join. After a lost completion reply, the retry recovers `coverage_changed` for the
same change while the connection exists. Connection loss ends pending server state.
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
