---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

Task records survive ordinary Stop/Start and Restart and are cleared by [Reset](0015-separate-start-stop-restart-and-reset.md). The disconnected-Asset workflow applies while Core remains running. Core is not restarted while Assets participate in a mission. Reconciling continuing Asset execution across a whole-Core restart is outside scope; retained Task records do not require automatic reexecution or mission resumption.

This requires reconciliation of both actual execution and current operator intent; replaying every historical instruction as executable work would be wrong. Cancellation cannot undo work already performed while disconnected. Until cancellation is confirmed, Core may accept Completed when its result requirements are met, or Failed when the Asset reports an unsuccessful outcome. Core retains the result and cancellation attempt in activity history. Once Core records confirmed Canceled, a later completion report or arriving data cannot change that Task to Completed. Objects already created remain available. Completion must satisfy the Command’s result requirements, including [required result availability for scans](0008-complete-scan-tasks-when-required-results-are-available.md). Continued execution, interruption and onboard queue ordering belong to the Asset operating system, outside this Core design. Remove the old 60-second immediate-start deadline. The old implementation's execution-order rules and live runtime-readiness gate are not inherited as Core Task-creation requirements. Core still validates its Command and target contracts; connection loss alone does not prevent tasking. Core authenticates the reporting Asset and accepts execution reports only for its assigned Tasks, as specified by [identity and access](../architecture/system-design.md#identity-and-access). This report-authority check does not require runtime registration, server scheduling or an execution-readiness gate.

While cancellation awaits Asset confirmation, Core records Cancellation requested rather than claiming the Task is Canceled. This additional Task status retains the operator instruction while distinguishing it from the Asset’s reported execution outcome.

On 21 September 2026 the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary. Core does not infer the Asset's knowledge from wall-clock timestamps. The Asset OS decides how to respond to cancellation; Core validates and records its reported outcome.

| Situation | Core outcome |
| --- | --- |
| Cancellation requested during acquisition or upload; no final outcome confirmed | Keep Cancellation requested |
| Asset reports completion while cancellation remains unconfirmed, with required Object ready | Record Completed and retain the cancellation attempt |
| Asset confirms cancellation | Record Canceled; preserve already-created Objects |
| Asset reports definitive failure while cancellation remains unconfirmed | Record Failed |
| Completion or data arrives after confirmed Canceled | Keep Canceled; data arrival does not reopen the Task |

This retains the seven main Task statuses. Physical acquisition alone never satisfies a scan's completion rule.
