---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

The disconnected-Asset workflow applies while Core remains running. Retention and the exclusion of whole-Core mission resumption follow [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history. Completion must meet the Command's result requirements, including [scan result availability](0008-complete-scan-tasks-when-required-results-are-available.md).

The Asset OS owns execution, interruption and the confirmed onboard queue. Core assigns immutable per-Asset submission sequence and records operator-requested order separately from Asset-confirmed order. Assets execute sequentially, oldest submission first by default, following confirmed reordering. Unstarted Tasks, including acknowledged Tasks, may be reordered; running and terminal Tasks may not. A disconnected Asset can continue its last confirmed order. Core does not start Tasks or enforce a live readiness gate. Remove the inherited 60-second immediate-start deadline and server-controlled delivery scheduling. Core still validates Command/target contracts and [assigned-Asset report authority](../architecture/system-design.md#identity-and-access); connection loss alone does not prevent tasking. These checks do not require runtime registration or server scheduling.

On 22 September 2026 the user selected a separate Task cancellation request instead of the seventh status chosen earlier. Preserve the six execution statuses and record cancellation intent independently. A Task can remain In progress while cancellation is pending. This supersedes only the earlier representation of cancellation intent, not the requirement for confirmation. Plugin Operations retain their separate lifecycle in [ADR-0002](0002-core-manages-installed-plugins.md).

On 21 September 2026 the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary. Core does not infer the Asset's knowledge from wall-clock timestamps. The Asset OS decides how to respond to cancellation; Core validates and records its reported outcome.

## Task transitions

Core records transitions from validated instructions and reports. The six wire statuses are `pending`, `acknowledged`, `in_progress`, `completed`, `failed` and `cancelled`; no extra Task status is introduced for cancellation intent or server interruption. "Assigned Asset" uses the [report-authority rule](../architecture/system-design.md#identity-and-access).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset accepts the Task into its local queue |
| In progress | Pending, Acknowledged | Assigned Asset reports execution has started |
| Completed | Pending, Acknowledged, In progress | Assigned Asset reports completion and the Command's required results are ready |
| Canceled | Pending, Acknowledged, In progress | Assigned Asset confirms the cancellation request for accepted work |
| Failed | Pending, Acknowledged, In progress | Assigned Asset reports a definitive unsuccessful outcome |

Core records a cancellation request without changing execution status. Acknowledgement, progress and start reports do not clear that request. Reports may skip intermediate states when messages arrive late or are missed, but cannot move execution backward. A completion report awaiting required data records In progress and retains any cancellation request until the [scan completion conditions](0008-complete-scan-tasks-when-required-results-are-available.md) hold or another terminal outcome is confirmed.

Cancellation intent alone does not win a race against completion or failure. Once a terminal outcome is confirmed, retain the cancellation attempt as history and do not present it as still awaiting action. Never-accepted work, delivery races and the cancellation-confirmation API remain detailed contract work; do not infer non-delivery merely from a missing acknowledgement.

Queue revision/conflict handling and reorder-confirmation APIs remain to be designed. Reading or caching an assigned Task does not acknowledge or start it.

Completed, Canceled and Failed are terminal. A repeated matching terminal report has no new effect; a conflicting report cannot change the recorded terminal outcome. Connection loss and Core Stop/Restart do not establish any Asset outcome. Automatic lost-Asset failure and an operator-forced terminal override are not part of this transition table.

[Task cancellation does not cancel result uploads](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads). Data arriving later cannot reopen a terminal Task.
