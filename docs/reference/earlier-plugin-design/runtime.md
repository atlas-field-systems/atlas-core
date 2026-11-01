# Private Plugin execution

> Historical design for review, not approved. [Planning status](../../README.md#planning-status).

This Core-owned contract lets an independently built trusted Plugin execute finite
[Operations](operations.md). It is not a public SDK API or Command Catalog.
Use HTTP/1.1 JSON over a manager-mounted Unix socket. Private POST routes are
`/challenge`, `/ready`, `/poll`, `/report`, and `/recover`. Bodies carry `dispatch_version`
equal to `1`; the runtime token uses Bearer authentication. Poll returns one tagged
`execute`, `cancel`, or `idle` body; report/recover replies carry `ack` or explicit refusal.
Core owns dispatch/acknowledgments. The Plugin owns receipts, effects, and report retries.

## Verified runtime

The manager creates a fresh process-generation UUID and 32-byte random private
token for each launch. It supplies the token through a protected file, never logs
or command arguments. Core authenticates the token and the socket peer, then checks
the manager's independently observed container ID, host boot ID, PID, and start marker.
Container names, Plugin claims, open channels, and elapsed silence prove no continuity.

Readiness binds installation ID, principal ID, Dataset ID, Core run ID, process
generation, manifest digest, image digest, configuration revision/digest, and the
exact enabled capability set. Core issues a single-use challenge valid for 10 seconds;
the response echoes that context. A mismatch refuses readiness and dispatch.
Recheck the current binding after every poll wait and before recording exposure.
Public API credentials alone grant no private dispatch authority.

A broken channel preserves the runtime until the manager verifies exit or replacement.
Manager-channel loss suspends new dispatch, not ordinary Core services. Existing
processing can finish and persist reports. The manager reconciles identities on
return under [manager recovery](manager-recovery.md); it never guesses continuity.

## Poll, execute, and cancel

The Plugin initiates `poll` with its runtime binding and available receipt slots.
Core holds it at most 30 seconds. One poll is active per runtime.
Reconnecting replaces the old poll, not the runtime.

Before admission, Core reserves a receipt slot and evidence space for each Operation.
Complete dispatch and result images must fit their message limits.
Before returning `execute`, Core commits possible exposure with the complete binding,
Operation ID, capability ID, package version, and input digest. It retains the exact
input bytes and their SHA-256 digest. Redelivery uses those same bytes and identity.
The Plugin flushes an atomic receipt with that tuple and digest before any effect.
An existing matching receipt joins or returns the original work; it never executes
again. Conflicting reuse is a fault. A receipt-store failure prevents effects.

Core sends `cancel` with Operation ID and the committed cancellation revision.
The Plugin deduplicates it, persists the outcome, and reports actual cancellation,
completion, or failure under Protocol. Poll receipt is neither start nor cancellation.
Cancellation and exact retries remain usable when fresh admission is full.

Retain every receipt, including completed and acknowledged work, until verified
runtime exit. At cumulative exhaustion, refuse new Operations with `resource_limit`.
No automatic eviction or restart recovers slots. A protected manual restart may
reclaim ended-runtime receipts only after preserving their unacknowledged evidence.

## Evidence and exact acknowledgment

A `report` names the Operation, original exposure binding, stable evidence UUID,
and positive revision encoded as a decimal uint64 string. Revisions start at `1`
and increase by one. Each carries complete cumulative known effects, result links,
and state `in_progress`, `completed`, `failed`, or `cancelled`. Completed reports
carry schema-valid output; failed reports carry a bounded failure code. Other states
omit output. Protocol owns public states, payload equality, and result meanings.

The Plugin flushes each report and its known effects before sending it. Core checks
current installation authority, the exposure tuple, payload schemas, and transition.
It commits evidence and public changes together before returning `ack` with the
Operation ID, evidence ID, accepted revision, and `recorded_as` of `normal` or `recovered`.
Core retains this exact acknowledgment with the original lossless report facts.
Lost acknowledgments cause the same report to be resent, never processing again.
Exact repeats return the original acknowledgment without another change or activity.
Conflicting identity reuse or a skipped revision is an explicit refusal.

After acknowledgment, retain the receipt and latest evidence; the outbound copy may go.
A terminal report fixes its result. Reserve its evidence space before admitting work,
including when progress reporting exhausts its budget. Later reports cannot rewrite it.

## Replacement and recovered outcomes

Confirmed exit fences the old runtime before replacement readiness. Core applies
[Operation recovery](operations.md#runtime-loss-and-recovery)
before any new dispatch. Same-Core-run never-exposed pending work may receive its
first dispatch. Possibly exposed unfinished work becomes `interrupted`. Whole-Core
restart interrupts all unfinished Operations, including never-exposed ones.

The replacement may submit old unacknowledged evidence as `recover`, authenticated
under its current installation binding and naming the original exposure binding.
It reads the retained receipt store in recovery-only mode before fresh execution.
Core accepts only the next evidence revision or an exact repeat. Terminal recovered
evidence becomes one immutable recovered outcome with known effects and result links.
Its acknowledgment is stable across retries and later replacements. The Operation
stays `interrupted`; original reads expose recovery without a new execution or ID.
Progress may add known effects but cannot restore execution. Public `outcome_id`
is the terminal evidence UUID; its `revision` is the exact accepted positive revision.

Keep unacknowledged evidence across Plugin and Core restarts until accepted or Reset.
Uninstall preserves it in Core-owned recovery storage before deleting Plugin state.
If that transfer or cleanup cannot be verified, uninstall remains incomplete.
Private refusals distinguish context, version, identity, revision, schema, capacity,
and unavailable-runtime failures. They never authorize automatic reruns.
