---
status: accepted
---

# Use live Geofeature geometry in Tasks

The user rejected freezing a Geofeature's geometry when a Task is issued and chose to have existing Tasks adjust to its new geometry. A Task referencing a scan zone therefore follows edits to that zone until Core accepts its valid collection-finished report.

Current rules: [Geofeatures](../topics/tracks-and-geofeatures.md#geofeatures) and, for the Task side, [Live Geofeature geometry](../topics/tasks.md#live-geofeature-geometry).

## Decision

The Task's Command, assignment and input remain immutable. Its input identifies the Geofeature, and the geometry reached through that stable reference changes until the Command's declared geometry cutoff: by default the Task's terminal report, and for a scan its accepted collection-finished report. Entities rejects a geometry edit that would make the input of an unfinished Task invalid before its cutoff.

A disconnected Asset may continue with its last received geometry within the Command's limits and adopts the latest on reconnect. Atlas distinguishes Core's saved geometry from the geometry the Asset reports it applied, and records the revision a terminal report used.

Decision history:

- 28 September 2026: live geometry was accepted in response to Q6. The user added the edit guard the same day.
- 28 September 2026: the user approved disconnection and adoption (Q9 and Q10).
- 28 September 2026: the collection-finished boundary for scans was accepted in response to Q11.
- 28 September 2026: geometry cutoffs and the recorded applied revision were accepted.

## Rationale and alternatives

- Live geometry keeps operator changes relevant to ongoing collection, at the cost of coordinating updated intent with execution over delayed or disconnected links. Freezing geometry at issue was rejected.
- The edit guard mirrors the deletion guard in [ADR-0023](0023-protect-required-entity-references-during-tasks.md).
- Recording the applied revision makes a Task completed against superseded geometry visible in its record rather than rejected or held.

## Consequences

- The Asset client or gateway must deliver updated geometry to affected execution, and the Asset OS owns how the running Command adapts. [ADR-0020](0020-limit-general-sdk-to-http-and-full-sync.md) retains gateway responsibility without introducing a general partial replica.
- An edit accepted by Core is not proof that the Asset received or applied it.
- [ADR-0008](0008-complete-scan-tasks-when-required-results-are-available.md) decides the race between a scan's collection-finished report and an edit.
- Exact geometry correlation, report ordering, transport and revision fields remain engineering work.
