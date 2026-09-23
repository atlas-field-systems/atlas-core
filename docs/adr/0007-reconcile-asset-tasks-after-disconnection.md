---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

The disconnected-Asset workflow applies while Core remains running. Retention and the exclusion of whole-Core mission resumption follow [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history. Completion must meet the Command's result requirements, including [scan result availability](0008-complete-scan-tasks-when-required-results-are-available.md).

The Asset OS owns execution, interruption and the confirmed onboard queue. Core assigns immutable per-Asset submission sequence and records operator-requested order separately from Asset-confirmed order. Assets execute sequentially, oldest submission first by default, following confirmed reordering. Unstarted Tasks, including acknowledged Tasks, may be reordered; running and terminal Tasks may not. A disconnected Asset can continue its last confirmed order. Core does not start Tasks or enforce a live readiness gate. Remove the inherited 60-second immediate-start deadline and server-controlled delivery scheduling. Core still validates Command/target contracts and [assigned-Asset report authority](../architecture/system-design.md#identity-and-access); connection loss alone does not prevent tasking. These checks do not require runtime registration or server scheduling.

On 22 September 2026 the user revised the earlier six-status decision: cancellation intent is the nonterminal Task status `cancellation_requested`, followed by `cancelled` only when the assigned Asset confirms it. This supersedes the separate-field-only representation. Retain request identity/details and execution facts such as started time and progress; the status alone does not prove execution has stopped. Plugin Operations retain their separate lifecycle in [ADR-0002](0002-core-manages-installed-plugins.md).

On 21 September 2026 the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary. Core does not infer the Asset's knowledge from wall-clock timestamps. The Asset OS decides how to respond to cancellation; Core validates and records its reported outcome.

## Task transitions

Core records transitions from validated instructions and reports. The specified wire statuses are `pending`, `acknowledged`, `in_progress`, `cancellation_requested`, `completed`, `failed` and `cancelled`. Server interruption adds no Task status. A requested `paused` extension is tracked below; its transition rules are not yet specified. "Assigned Asset" uses the [report-authority rule](../architecture/system-design.md#identity-and-access).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset accepts the Task into its local queue |
| In progress | Pending, Acknowledged | Assigned Asset reports execution has started |
| Cancellation requested | Pending, Acknowledged, In progress | Tasking client requests withdrawal; Core records intent and notifies the Asset |
| Completed | Pending, Acknowledged, In progress, Cancellation requested | Assigned Asset reports completion and the Command's required results are ready |
| Canceled | Cancellation requested | Assigned Asset confirms the identified cancellation request |
| Failed | Pending, Acknowledged, In progress, Cancellation requested | Assigned Asset reports a definitive unsuccessful outcome |

Core records a cancellation request by setting `cancellation_requested`. Acknowledgement, progress and start reports can update validated execution facts but cannot clear that status. Reports may skip intermediate execution states when messages arrive late or are missed, but cannot move execution backward. A completion report awaiting required data leaves the Task `in_progress`, or `cancellation_requested` if withdrawal is pending, until the [scan completion conditions](0008-complete-scan-tasks-when-required-results-are-available.md) hold or another terminal outcome is confirmed.

Cancellation intent alone does not win a race against completion or failure. Once a terminal outcome is confirmed, retain the cancellation attempt as history and do not present it as still awaiting action. Require assigned-Asset confirmation even when Core has no acknowledgement: missing acknowledgement does not prove non-delivery. An offline Task can remain `cancellation_requested` until contact resumes. A confirmation identifies the request; matching retries have no new effect and conflicting terminal outcomes fail. Exact wire fields remain schema work.

Reading or caching an assigned Task does not acknowledge or start it. Queue changes follow the revision contract below.

Completed, Canceled and Failed are terminal. A repeated matching terminal report has no new effect; a conflicting report cannot change the recorded terminal outcome. Connection loss and Core Stop/Restart do not establish any Asset outcome. Automatic lost-Asset failure and an operator-forced terminal override are not part of this transition table.

## Status update API

Use `PATCH /tasks/{task_id}/status` for lifecycle reports, progress-only updates, cancellation requests and confirmation. This replaces separate lifecycle action endpoints. Core validates the authenticated actor and transition-specific payload: tasking clients request cancellation; the assigned Asset supplies execution reports and cancellation confirmation. It is not a generic field-edit endpoint. Return the actual recorded Task when required Objects or cancellation outcome are still pending. Named SDK helpers may share this route. Wire fields and ordering/precondition details remain schema work.

## Queue revisions

Use `PUT /entities/{entity_id}/task-order` to submit a complete ordered list of eligible unstarted Task IDs, the expected queue revision and stable request identity. Core validates assignment, uniqueness, eligibility and completeness against that revision atomically. Preserve immutable submission sequence. A matching retry returns the original acceptance; conflicting reuse or an obsolete expected revision fails explicitly. New queue membership, eligibility changes and accepted edits invalidate older edit bases. New Tasks append by submission order unless a later accepted edit changes their position.

Use `POST /entities/{entity_id}/task-order/confirm` for the assigned Asset to report whether it adopted a particular requested revision. Store requested order/revision separately from Asset-confirmed order/revision. Repeated matching reports are harmless; an older confirmation cannot acknowledge a newer request or roll back a later confirmation. A report that the Asset could not apply the revision records conflict and its relevant execution facts rather than implying adoption. Clients reconcile before submitting a new revision.

Only Tasks that have never started and remain eligible for execution can be reordered. Cancellation-requested and terminal Tasks are excluded. Started Tasks stay excluded even if future pause behavior allows their execution to suspend. If a Task starts on the Asset before it sees a reorder, it reports that conflict and actual execution; Core must not reject reality merely because operator intent changed. Disconnected Assets can continue their last adopted order. Confirmation means the Asset adopted an order at that point, not that the queue stops changing afterward.

The Task-list response carries requested/confirmed revisions and an edit revision with the relevant ordered list; pagination must detect an invalidated view before accepting a full-list edit. Queue updates and confirmations must reach synchronized clients through the Task/assigned-queue contract, atomically enough to avoid presenting mixed revisions as a confirmed order. Concrete event envelopes and paging fields remain schema work. No Core readiness gate or execution scheduler is introduced.

## Paused and immediate execution follow-up

The user requested a `paused` Task status and immediate execution of selected Commands, such as lights or landing gear, while retaining the option to queue them. These are planned extensions requiring a follow-up decision before adding transitions, endpoints or execution guarantees. Distinguish pausing one Task from pausing an Asset's queue, define who requests and confirms pause/resume, and settle effects on running work, cancellation and pending results. A Task that has started remains ineligible for reorder.

Immediate means an execution policy to be defined by the Asset OS, not a zero-latency delivery guarantee. Define which Commands support it and whether they run alongside, interrupt or wait for running work. The accepted sequential queue is the current baseline, not a rejection of the requested future immediate mode. Record both queued and immediate invocations as Tasks if that proposed model is selected; do not invent an untracked bypass during implementation.

[Task cancellation does not cancel result uploads](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads). Data arriving later cannot reopen a terminal Task.
