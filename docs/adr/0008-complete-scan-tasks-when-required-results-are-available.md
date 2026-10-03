---
status: superseded by ADR-0026
---

# Complete scan Tasks when required results are available

Superseded on 3 October 2026 by [ADR-0026](0026-record-asset-completion-independently-of-result-availability.md). This record preserves the earlier decision and evaluation; its readiness gate and edit-first scan-finish rule are no longer current requirements.

A scan Task reaches Completed when the scan has finished and its required result is available in Atlas. The user chose this over marking completion after physical acquisition alone, so operators can rely on a completed scan having its required result ready for use. A later Plugin Operation on the result has its own lifecycle and does not delay completion of the scan Task. [Objects appear only when ready](0009-expose-objects-only-when-ready.md).

Current rules: [Scan completion](../topics/tasks.md#scan-completion).

## Decision

Core requires both an authenticated completion report from the assigned Asset and the availability of every required result Object declared by that Asset, in either arrival order. Until both hold, the Task keeps its applicable nonterminal state, and the final transition still obeys the confirmed-cancellation and terminal-state rules in the [Task transition table](../topics/tasks.md#task-status-and-transitions). Object readiness alone cannot complete a Task, and an Asset report alone cannot complete a scan whose required data is still unavailable.

Accepted on 28 September 2026 when the user approved Q11: for a scan referencing a Geofeature, Core's acceptance of the assigned Asset's valid collection-finished report closes further geometry changes for that scan. It is collection evidence in the completion contract, not a new Task status or another Core permission step, and it is serialized against geometry edits. [ADR-0024](0024-use-live-geofeature-geometry-in-tasks.md) governs delivery, offline execution and adoption.

## Consequences

- A completion submission may return a nonterminal Task, and clients must read Core's recorded status rather than assume success. Asset-provided progress details can explain that scanning has finished and data is uploading; the progress-detail and failure-reason contracts remain to be designed.
- Core must retain an early completion report or an early ready result until the other arrives. When publication satisfies the last required result, it identifies the waiting Task so the transition commits with that publication; see [Object publication and recovery ownership](../architecture/system-design.md#object-publication-and-recovery-ownership).
- Result Object IDs allocated before upload, Required-result protection from declaration acceptance and uploads that continue after cancellation follow [Objects](../topics/objects.md); a later upload cannot reopen a terminal Task.
- Once collection is accepted, later geometry edits require another Task to scan the changed zone, even while uploads keep the scan nonterminal.

## Upload-first evaluation

On 23 September 2026 the user approved evaluating upload-first as a simplification, not changing the accepted arrival-order contract yet. Compare requiring ready Objects before completion reporting against the current either-order behavior on interrupted links. Check the Asset's need to retain an unreported outcome and the race between Object upload, deletion and declaration. Keep required-result integrity and crash-safe publication in the evaluation.

Until that evaluation supports a successor decision, both arrival orders and declaration-time protection remain required. Either design must preserve the user-facing promise that Completed means the scan's required results are available; finishing physical acquisition alone is insufficient.
