# Assigned-read storage

**Assigned polls keep full context for finite retries and compact proof for delayed
Resume evidence.** [Protocol](../Atlas%20Protocol/task-controls.md) owns the execution
rules and ten-second instruction validity. This page owns Core's private retention.

## Live retries and ended identities

Tasks retains the original request and queue/control context for a 60-second read
lifetime. Successful assigned reads reclaim expired contexts and lifetime rows in
their transaction. Restart discards all full contexts. Idle storage may retain the
last polling window until the next successful read or Restart; polling cannot
accumulate full contexts from earlier windows. No additional timer is needed.

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

On first opening private format 1, Tasks derives receipts from the retained original
facts, discards full contexts, and marks format 2 in one transaction. Failure leaves
the original contexts and format intact. This compaction preserves evidence and
ended identities; older Core binaries reject format 2 rather than resurrect reads.
Subsequent Restart needs no conversion. This is a specific private representation
upgrade, not a general operational-data migration facility.
