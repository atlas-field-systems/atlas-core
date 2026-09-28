---
status: accepted
---

# Protect required Entity references during Tasks

Accepted on 28 September 2026. A Track or Geofeature required by an unfinished Task cannot be deleted. The protection preserves the meaning and recoverability of the accepted Task while its assigned Asset is disconnected or retired.

## Decision

Protocol-defined Commands identify their typed Entity references. Tasks owns the meaning of those references and determines which references are required for an accepted Task. When an unfinished Task requires a Track or Geofeature, Entities rejects deletion of that Entity and explains which unfinished Task or Tasks block the operation. The existing Asset deletion guard remains in force for assigned Assets; this decision adds the same protection for required Track and Geofeature references.

The guard applies while the Task is nonterminal, including while it is pending, paused or waiting on cancellation or required results. A disconnected or retired assigned Asset does not release the protection and does not cause Core to infer cancellation, completion or failure. The condition can therefore remain until the Task reaches a terminal outcome or the Dataset is Reset. When the Task reaches a terminal outcome, its required Entity-reference guard is released and an otherwise permitted Entity deletion may proceed.

Required Entity-reference protection is separate from required-result Object protection. A terminal Task may release its Track or Geofeature reference for deletion while its required Object holds remain until Reset under [ADR-0009](0009-expose-objects-only-when-ready.md). Entity deletion cannot release those Object holds.

This deletion guard does not freeze editable geometry. [ADR-0024](0024-use-live-geofeature-geometry-in-tasks.md) requires a Task to adapt to changes in its referenced Geofeature while preserving its Task identity and reference. For scans, accepted collection-finished evidence closes geometry changes before uploads necessarily finish. Before the Task's geometry cutoff, a geometry edit that would make its Command input invalid is rejected under the same ADR. Required-reference deletion protection still lasts until a terminal Task outcome.

Entities coordinates deletion and Task admission/reference validation through the existing ownership and write-commit boundaries. If a Task requiring an Entity commits first, deletion is rejected; if deletion commits first, a new Task requiring that Entity is rejected. This is a deletion and admission guard, not a general dependency-publication or Asset-hybrid synchronization scope.

Exact error fields, reference encoding and private coordination remain implementation work. No new route, Task status or operator-forced outcome is introduced.

## Required implementation evidence

Extend the real SDK–Core workflows in the [testing strategy](../testing-strategy.md):

- Reject Track and Geofeature deletion while each has an unfinished Task-required reference, and identify the blocking Task records.
- Exercise both commit orders for deletion against Task admission/reference validation. A committed Task keeps its reference; a committed deletion prevents a new required reference.
- Retire or disconnect the assigned Asset while a required Track or Geofeature remains referenced. Keep the Entity protected without inventing a Task outcome. Exercise later valid terminal evidence separately from unresolved work that stays protected until Reset.
- When several unfinished Tasks require the same Entity, completing one does not permit deletion while another still requires it. Preserve the guard across same-release Restart and clear it with the Dataset on Reset.
- After terminal release, allow an otherwise valid Entity deletion while preserving any required Object hold through Reset.

These cases supplement the existing Asset deletion, retirement, Task transition and Object protection scenarios. They do not require per-Asset synchronization or a second dependency system.
