---
status: accepted
---

# Confirm writes when Core commits

An earlier SDK rule withheld successful in-scope write results until the local picture reached the complete write commit boundary, with a separate committed-but-not-yet-synchronized outcome if that wait failed.

Current rules: [SDK writes](../topics/sdk.md#writes).

## Decision

Confirm a write when Core has committed it, without waiting for the SDK's synchronized picture to catch up. All SDK modes return Core's authoritative result after validating the response and Dataset. For Task creation, acceptance means Core recorded the request; it does not mean the Asset received, acknowledged or executed it.

Keep write responses entirely out of picture updates. Snapshot loading, feed delivery and replay recovery are the only data inputs to the Local operational picture. A validated write response confirms the write and returns its result to the caller; it does not update picture reads, append local history, emit picture notifications or advance a picture cursor.

Decision history:

- 23 September 2026: the user chose to confirm a write when Core has committed it, superseding the wait-for-picture rule.
- 26 September 2026: the user chose to keep write responses entirely out of picture updates.

## Rationale and alternatives

- Feed delays must not delay confirmation of an already-confirmed Core commit.
- Keeping write responses out of the picture removes a second reconciliation input while preserving immediate write confirmation.

## Consequences

- Local reads can briefly show older state, so applications must distinguish the returned write result from the picture's independently reported synchronization state. Ordinary write success promises no immediate local read-after-write visibility.
- The picture can remain behind until synchronization delivers the change, including when the response carries a resource newer than the local copy.
- Losing synchronization after a successful write does not undo acceptance or cause automatic resubmission. A lost HTTP response still uses the operation's existing retry identity, and Dataset changes keep the rejection rules of [ADR-0015](0015-separate-start-stop-restart-and-reset.md).
- Exact response envelopes and any separate opt-in convergence-wait helper remain engineering choices.
