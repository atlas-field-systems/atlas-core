# Assigned-read storage

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**Assigned polls keep full context for finite retries and compact proof for delayed
Resume evidence.** [Protocol](controls.md) owns the execution
rules and ten-second instruction validity. This page owns Core's private retention.

## Live retries and ended identities

Tasks retains the original request and queue/control context for a 60-second read
lifetime. Each newly allocated read reclaims at most 16 expired contexts and their
lifetime rows in its admitted transaction. Indexed ranges locate expired current-run
and previous-run contexts without scanning live contexts. Charge the removed bytes and per-row
SQLite work as well as the new context, because deletion can grow the WAL before
checkpointing. Refusal rolls reclamation back. Exact retries and continuations do
no reclamation writes. Restart ends every live context; later admitted reads reclaim
those contexts with the same bound. Idle storage may retain its last polling window
until later admitted reads. No timer is needed.

Each successful first-page read keeps a Dataset-scoped receipt until Reset. Its
SHA-256 digest binds the original canonical request, including omitted page size.
Changed facts return `identity_conflict`. An exact request whose full context has
ended returns `allocation_expired`, even after Restart. Neither can become a fresh
read. Admission charges the receipt and live context together; refusal rolls both
back. Reads and reclamation produce no public picture or progress event.

## Delayed Resume evidence

A context whose requested control is Resume also retains a digest of the original
Asset, process, read ID, Core run, capture time, instruction expiry, queue revision,
control revision, and control Task ID. Validation compares those exact semantic
facts without requiring a live context or a current-run match. Valid execution
before the original cutoffs remains admissible after token expiry and Restart.
Empty and Move To-only polls need no Resume proof. Proofs remain until Reset so
later reports can still verify the same terminal effect.

## Retained cost and compatibility

Each receipt has 100 bytes of textual identity fields, or 164 with Resume proof,
plus SQLite row/index and WAL overhead. At one new read per second, each Asset
adds 360,000 identity-field bytes per hour without Resume. Queue length affects
only the live context. Aggregate capacity still bounds admissions; choose polling
cadence with this retained cost in mind.

The [build profile](../implementation/build-profile.md) owns compatible private storage formats.
Store refuses incompatible data before Tasks reads its contexts. Within a
compatible Dataset, Restart retains every receipt and does no cleanup writes.
Tasks never changes the storage format or reconstructs missing evidence.
