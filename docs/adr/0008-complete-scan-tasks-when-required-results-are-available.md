---
status: accepted
---

# Complete scan Tasks when required results are available

A scan Task reaches Completed when the scan has finished and its required result is available in Atlas. The user chose this over marking completion after physical acquisition alone, so operators can rely on a completed scan having its required result ready for use. Until then the Task retains its applicable nonterminal state, including Paused on confirmed suspension or Cancellation requested when withdrawal is pending; separate Asset-provided progress details can explain that scanning has finished and data is uploading.

The [Task transition table](0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) defines the Task lifecycle statuses. A later Plugin Operation on the result has its own lifecycle and does not delay completion of the scan Task. The `Failed` Task status records unsuccessful outcomes. `Cancellation requested` distinguishes operator intent from confirmed `Canceled`. [Objects appear only when ready](0009-expose-objects-only-when-ready.md); the progress-detail and failure-reason contracts remain to be designed.

Cancellation during acquisition or upload follows [the Task transition rules](0007-reconcile-asset-tasks-after-disconnection.md#task-transitions), with [uploads independent of cancellation](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads).

## Both completion conditions

Core requires both an authenticated completion report from the assigned Asset and the availability of every required result Object declared by that Asset. They may arrive in either order. Core retains the report or ready result until both conditions hold; the final transition still obeys the confirmed-cancellation and terminal-state rules. When publication satisfies the last required result, it identifies the waiting Task so the transition commits with that publication; see [Object publication and recovery ownership](../architecture/system-design.md#object-publication-and-recovery-ownership).

The SDK allocates the eventual Object ID before upload and uses that same ID in the Task completion report and whole-file upload. An unresolved result reference does not publish an Object or satisfy readiness. See [result identity before upload](0009-expose-objects-only-when-ready.md#result-identity-before-upload).

Only the assigned Asset may declare its Task's execution result references, under the existing execution-report authority rule. Uploading or modifying an Object is not an Asset completion report. Object readiness alone cannot complete a Task, and an Asset report alone cannot complete a scan whose required data is still unavailable. This does not add caller ownership restrictions to Object uploads.

Once Core accepts the assigned Asset's required-result declaration, those Object identities are protected until Reset, including while the Task is unfinished and before upload. Object association edits or later Task outcomes cannot remove that protection. Declaration acceptance, publication and deletion must obey the [required-result retention contract](0009-expose-objects-only-when-ready.md#required-result-protection).

## Geometry and collection-finished reports

Accepted on 28 September 2026 when the user approved Q11. For a scan referencing a Geofeature, Core's acceptance of the assigned Asset's valid collection-finished report closes further geometry changes for that scan. This is the collection evidence in the existing completion contract, not a new Task status or another Core permission step. The report must account for the geometry current at acceptance. [ADR-0024](0024-use-live-geofeature-geometry-in-tasks.md) governs delivery, offline execution and adoption.

Serialize acceptance against geometry edits. If an edit commits first, a report for the earlier geometry cannot close collection; preserve valid execution evidence and require the Asset to account for the changed zone before collection can be accepted as finished. Core does not infer failure or issue replacement work. Geometry correlation must distinguish a changed target from unrelated descriptive edits; exact fields remain Protocol work.

If the collection-finished report is accepted first, later edits do not reopen collection. The Asset finishes uploading the declared results for the accepted work, and scanning the changed zone requires another Task. Keep the accepted geometry association with the collection evidence so later edits and delayed reports cannot reinterpret what was finished. Retrying an already accepted report preserves its recorded acceptance, even if the geometry has since changed; it does not reopen collection or establish a new finish boundary.

Required Objects may be ready before or after report acceptance. Once collection is accepted, later Object publication evaluates that accepted evidence and the existing lifecycle conditions, without requiring the scan to adopt subsequent geometry edits. Collection-finished evidence alone is insufficient for Completed; all required results must also be ready. Confirmed cancellation and other terminal outcomes still prevent a later upload from changing the outcome, and required-result protection remains until Reset.

## Upload-first evaluation

On 23 September 2026 the user approved evaluating upload-first as a simplification, not changing the accepted arrival-order contract yet. Compare requiring ready Objects before completion reporting against the current either-order behavior on interrupted links. Check the Asset's need to retain an unreported outcome and the race between Object upload, deletion and declaration. Keep required-result integrity and crash-safe publication in the evaluation.

Until that evaluation supports a successor decision, both arrival orders and declaration-time protection remain required. Either design must preserve the user-facing promise that Completed means the scan's required results are available; finishing physical acquisition alone is insufficient.
