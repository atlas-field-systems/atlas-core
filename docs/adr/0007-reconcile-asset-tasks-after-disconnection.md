---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

The disconnected-Asset workflow applies while Core remains running. Retention and the exclusion of whole-Core mission resumption follow [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history. Completion must meet the Command's result requirements, including [scan result availability](0008-complete-scan-tasks-when-required-results-are-available.md).

The Asset OS owns continued execution, interruption and onboard queue order. Remove the inherited 60-second immediate-start deadline, execution-order rules and live runtime-readiness gate from Core Task creation. Core still validates Command/target contracts and [assigned-Asset report authority](../architecture/system-design.md#identity-and-access); connection loss alone does not prevent tasking. These checks do not require runtime registration or server scheduling.

While cancellation awaits Asset confirmation, Core records Cancellation requested rather than claiming the Task is Canceled. This additional Task status retains the operator instruction while distinguishing it from the Asset’s reported execution outcome.

On 21 September 2026 the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary. Core does not infer the Asset's knowledge from wall-clock timestamps. The Asset OS decides how to respond to cancellation; Core validates and records its reported outcome.

## Task transitions

Core records transitions from validated instructions and reports. The table defines the seven main statuses; no additional Task status is introduced for a server interruption. “Assigned Asset” uses the existing [report-authority rule](../architecture/system-design.md#identity-and-access).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset acknowledges the Task |
| In progress | Pending, Acknowledged | Assigned Asset reports execution has started |
| Cancellation requested | Pending, Acknowledged, In progress | Core accepts a cancellation request |
| Completed | Pending, Acknowledged, In progress, Cancellation requested | Assigned Asset reports completion and the Command's result requirements are satisfied |
| Canceled | Cancellation requested | Assigned Asset confirms cancellation |
| Failed | Pending, Acknowledged, In progress, Cancellation requested | Assigned Asset reports a definitive unsuccessful outcome |

Reports can skip intermediate acknowledgement/progress states because those reports may arrive late or be missed. They cannot move a Task backward. While Cancellation requested, acknowledgement or progress reports retain that main status. A completion report awaiting required data retains Cancellation requested, or records In progress if cancellation is not pending, until the [scan completion conditions](0008-complete-scan-tasks-when-required-results-are-available.md) are met.

Completed, Canceled and Failed are terminal. A repeated matching terminal report has no new effect; a conflicting report cannot change the recorded terminal outcome. Connection loss and Core Stop/Restart do not establish any Asset outcome. Automatic lost-Asset failure and an operator-forced terminal override are not part of this transition table.

[Task cancellation does not cancel result uploads](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads). Data arriving later cannot reopen a terminal Task.
