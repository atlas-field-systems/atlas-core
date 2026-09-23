---
status: accepted
---

# Confirm writes when Core commits

On 23 September 2026 the user chose to confirm a write when Core has committed it, without waiting for the SDK's synchronized picture to catch up. All SDK modes return Core's authoritative result after validating the response and Dataset. For Task creation, acceptance means Core recorded the request; it does not mean the Asset received, acknowledged or executed it.

This supersedes the earlier SDK rule that withheld successful in-scope write results until the local picture reached the complete write commit boundary, with a separate committed-but-not-yet-synchronized outcome if that wait failed. Feed delays must not delay confirmation of an already-confirmed Core commit. Local reads can briefly show older state, so applications must distinguish the returned write result from the picture's independently reported synchronization state.

The local picture still applies committed changes in order, without duplicate notifications, stale overwrites or skipped changes. A write response alone cannot advance its recovery cursor or stand in for other resources changed by the same commit. Losing synchronization after a successful write does not undo acceptance or cause automatic resubmission. A lost HTTP response still uses the operation's existing retry identity; Dataset changes retain the rejection rules in [ADR-0015](0015-separate-start-stop-restart-and-reset.md#dataset-boundary).

[SDK data access](../sdk-data-access.md#writes) owns reconciliation details. Exact response envelopes and any separate opt-in convergence-wait helper remain engineering choices; ordinary write success promises no immediate local read-after-write visibility.
