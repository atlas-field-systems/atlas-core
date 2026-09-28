---
status: accepted
---

# Use live Geofeature geometry in Tasks

Accepted on 28 September 2026 in response to Q6. The user rejected freezing a Geofeature's geometry when a Task is issued and chose to have existing Tasks adjust to its new geometry. A Task referencing a scan zone therefore follows edits to that zone until Core accepts its valid collection-finished report, as clarified in Q11 below. This keeps operator changes relevant to ongoing collection, at the cost of coordinating updated intent with execution over delayed or disconnected links.

The Task's Command, assignment and input remain immutable. Its input identifies the Geofeature; the geometry reached through that stable reference changes. Updating the Geofeature does not create a replacement Task or resend the original invocation as new work. A terminal Task retains its recorded outcome and is not reopened by later geometry edits. Geometry updates do not implicitly Resume paused work or clear a cancellation request.

Entities validates and commits the geometry edit under the [concurrent-edit contract](../architecture/system-design.md#concurrent-descriptive-edits). Committed updates reach the full operational picture through the existing synchronization contract. The Asset client or gateway must deliver updated geometry to affected execution, and the Asset OS owns how the running Command adapts its physical work. An edit accepted by Core is not proof that the Asset received or applied it. [ADR-0020](0020-limit-general-sdk-to-http-and-full-sync.md) retains gateway responsibility without introducing a general partial replica.

[ADR-0023](0023-protect-required-entity-references-during-tasks.md) protects the required Geofeature from deletion while the Task is unfinished. It does not freeze the geometry.

On 28 September 2026 the user added one edit guard. Entities rejects a geometry edit that would make the Command input invalid for an unfinished Task that has not reached its geometry cutoff, such as redrawing a scan polygon as a point or exceeding the Command's declared limits, and names the blocking Tasks. This mirrors the deletion guard in ADR-0023. Valid edits remain live. Ready result Objects and accepted execution evidence keep their existing retention rules; the edit does not erase work already performed.

## Disconnection and adoption

Accepted on 28 September 2026 when the user approved Q9 and Q10. A disconnected Asset may continue with its last received geometry within the Command's existing execution limits. Loss of contact alone does not stop otherwise valid work. On reconnect, affected execution adopts the latest geometry; it does not execute each intervening edit as another instruction. Existing pause, cancellation, terminal-outcome and reconnect-reconciliation rules still apply.

Atlas distinguishes Core's saved geometry from the geometry the assigned Asset reports it has applied to the Task. Core or gateway receipt is not adoption. An older adoption report cannot establish that a newer edit has been applied. The Asset may adjust execution before Core receives that report; confirmation is evidence, not an additional Core permission step. Exact geometry correlation, report ordering and transport fields remain engineering work.

## Collection finished and result upload

Accepted on 28 September 2026 in response to Q11. Core's acceptance of a valid assigned-Asset collection-finished report closes a scan's geometry changes. An edit committed before that acceptance must be accounted for by the scan. An edit afterward does not demand further collection from the same Task, even while required results are still uploading; scanning the changed area requires another Task. [ADR-0008](0008-complete-scan-tasks-when-required-results-are-available.md#geometry-and-collection-finished-reports) owns the report/edit race and preserves the promise that Completed means all required results are ready.

## Geometry cutoff and applied revision

Accepted on 28 September 2026. Every Command that references a Geofeature declares the event after which geometry edits no longer apply to its Task. The default is the Task's terminal report; a scan's cutoff is its accepted collection-finished report, as above. Core accepts a valid terminal report as what happened, even if it was made against geometry an operator has since edited, and records the geometry revision the Asset reports having used. A Task completed against superseded geometry is therefore visible in its record rather than rejected or held. A Command whose cutoff is an earlier report, such as a scan's collection-finished report, follows that report's own acceptance rules under ADR-0008. Exact revision fields remain engineering work.

The [testing strategy](../testing-strategy.md#required-scenario-coverage) must exercise same-Task adaptation, disconnected execution, confirmation separate from permission, both report/edit commit orders, pending uploads, rejection of edits that invalidate an unfinished Task, the recorded applied revision, unchanged cancellation/pause rules and terminal immutability. These are required implementation scenarios, not executed tests.
