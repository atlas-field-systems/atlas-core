---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

Reconciliation applies within a Core run. Core is assumed to remain running while Assets operate. A [Core restart starts empty](0013-start-each-core-run-with-empty-data.md) and ends the operating session; continuation of prior-run Tasks is outside scope.

This requires reconciliation of both actual execution and current operator intent; replaying every historical instruction as executable work would be wrong. Cancellation cannot undo work already performed while disconnected. If an Asset reports completion before receiving a cancellation, Core records Completed, retains the result and preserves the cancellation attempt in activity history. Completion must satisfy the Command’s result requirements, including [required result availability for scans](0008-complete-scan-tasks-when-required-results-are-available.md). Continued execution, interruption and onboard queue ordering belong to the Asset operating system, outside this Core design. Remove the old 60-second immediate-start deadline. The old implementation's execution-order rules and live runtime-readiness gate are not inherited as Core Task-creation requirements. Core still validates its Command and target contracts; connection loss alone does not prevent tasking.

While cancellation awaits Asset confirmation, Core records Cancellation requested rather than claiming the Task is Canceled. This additional Task status retains the operator instruction while distinguishing it from the Asset’s reported execution outcome.
