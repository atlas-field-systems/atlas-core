---
status: accepted
---

# Protect required Entity references during Tasks

A Track or Geofeature required by an unfinished Task cannot be deleted. The protection preserves the meaning and recoverability of the accepted Task while its assigned Asset is disconnected or retired.

Current rules: [Required Entity references](../topics/tracks-and-geofeatures.md#required-entity-references). Tasks determines which references are required under [Tasks](../topics/tasks.md#required-entity-references).

## Decision

Protocol-defined Commands identify their typed Entity references, and Tasks determines which are required for an accepted Task. While an unfinished Task requires a Track or Geofeature, Entities rejects its deletion and identifies the blocking Tasks. The existing Asset deletion guard remains, and this decision adds the same protection for required Track and Geofeature references.

A disconnected or retired assigned Asset does not release the guard, and Core does not infer an outcome, so it can remain until a terminal outcome or Reset. A terminal Task releases its guard. Required-result Object holds stay separate and remain until Reset. The guard does not freeze editable geometry.

Decision history:

- 28 September 2026: accepted.

## Rationale and alternatives

- Keeping the referenced Entity preserves the meaning and recoverability of an accepted Task while its assigned Asset is disconnected or retired.
- Entities coordinates deletion and Task admission through the existing ownership and write-commit boundaries. The guard is a deletion and admission guard, not a general dependency-publication or Asset hybrid synchronization scope.

## Consequences

- An unresolved Task can keep a Track or Geofeature protected until Reset.
- No new route, Task status or operator-forced outcome is introduced.
- Tests extend the existing Asset deletion, retirement, Task transition and Object protection scenarios without per-Asset synchronization or a second dependency system.
- Exact error fields, reference encoding and private coordination remain implementation work.
