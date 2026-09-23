---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. On reconnect, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset’s onboard queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task.

The disconnected-Asset workflow applies while Core remains running. Retention and the exclusion of whole-Core mission resumption follow [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history. Completion must meet the Command's result requirements, including [scan result availability](0008-complete-scan-tasks-when-required-results-are-available.md).

The Asset OS owns execution, interruption and the confirmed onboard queue. Core assigns immutable per-Asset submission sequence and records operator-requested order separately from Asset-confirmed order. Assets execute queued Tasks sequentially, oldest submission first by default, following confirmed reordering. Immediate Tasks bypass that queue under the scheduling contract below. Unstarted queued Tasks, including acknowledged Tasks, may be reordered; running and terminal Tasks may not. A disconnected Asset can continue its last confirmed order. Core does not start Tasks or enforce a live readiness gate. Remove the inherited 60-second immediate-start deadline and server-controlled delivery scheduling. Core still validates Command/target contracts and [assigned-Asset report authority](../architecture/system-design.md#identity-and-access); connection loss alone does not prevent tasking. These checks do not require runtime registration or server scheduling.

On 22 September 2026 the user revised the earlier six-status decision: cancellation intent is the nonterminal Task status `cancellation_requested`, followed by `cancelled` only when the assigned Asset confirms it. This supersedes the separate-field-only representation. Retain request identity/details and execution facts such as started time and progress; the status alone does not prove execution has stopped. Plugin Operations retain their separate lifecycle in [ADR-0002](0002-core-manages-installed-plugins.md).

On 21 September 2026 the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary. Core does not infer the Asset's knowledge from wall-clock timestamps. The Asset OS decides how to respond to cancellation; Core validates and records its reported outcome.

## Task transitions

Core records transitions from validated instructions and reports. The specified wire statuses are `pending`, `acknowledged`, `in_progress`, `paused`, `cancellation_requested`, `completed`, `failed` and `cancelled`. Server interruption adds no Task status. Paused is nonterminal and requires Asset-confirmed suspension, as defined below; Resume uses an immediate Command under the same contract. "Assigned Asset" uses the [report-authority rule](../architecture/system-design.md#identity-and-access).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset accepts the Task into its local queue |
| In progress | Pending, Acknowledged, Paused | Assigned Asset reports execution has started, or confirms explicit Resume of the suspended Task |
| Paused | Pending, Acknowledged, In progress | Assigned Asset confirms suspension of already-started work after executing immediate Pause; report includes execution facts if Core missed the start |
| Cancellation requested | Pending, Acknowledged, In progress, Paused | Tasking client requests withdrawal; Core records intent and notifies the Asset |
| Completed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports completion and the Command's required results are ready |
| Canceled | Cancellation requested | Assigned Asset confirms the identified cancellation request |
| Failed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports a definitive unsuccessful outcome |

Core records a cancellation request by setting `cancellation_requested`. Acknowledgement, progress and start reports can update validated execution facts but cannot clear that status. Reports may skip intermediate execution states when messages arrive late or are missed, but cannot move execution backward. A completion report awaiting required data preserves the applicable nonterminal state, including `paused` or `cancellation_requested`, until the [scan completion conditions](0008-complete-scan-tasks-when-required-results-are-available.md) hold or another terminal outcome is confirmed.

Cancellation intent alone does not win a race against completion or failure. Once a terminal outcome is confirmed, retain the cancellation attempt as history and do not present it as still awaiting action. Require assigned-Asset confirmation even when Core has no acknowledgement: missing acknowledgement does not prove non-delivery. An offline Task can remain `cancellation_requested` until contact resumes. A confirmation identifies the request; matching retries have no new effect and conflicting terminal outcomes fail. Exact wire fields remain schema work.

Reading or caching an assigned Task does not acknowledge or start it. Queue changes follow the revision contract below.

Completed, Canceled and Failed are terminal. A repeated matching terminal report has no new effect; a conflicting report cannot change the recorded terminal outcome. Connection loss and Core Stop/Restart do not establish any Asset outcome. Automatic lost-Asset failure and an operator-forced terminal override are not part of this transition table.

## Status update API

Use `PATCH /tasks/{task_id}/status` for lifecycle reports, progress-only updates, cancellation requests and confirmation. This replaces separate lifecycle action endpoints. Core validates the authenticated actor and transition-specific payload: tasking clients request cancellation; the assigned Asset supplies execution reports and cancellation confirmation. It is not a generic field-edit endpoint. Return the actual recorded Task when required Objects or cancellation outcome are still pending. Named SDK helpers may share this route. Wire fields and ordering/precondition details remain schema work.

## Queue revisions

Use `PUT /entities/{entity_id}/task-order` to submit a complete ordered list of eligible unstarted queued Task IDs, the expected queue revision and stable request identity. Core validates assignment, uniqueness, eligibility and completeness against that revision atomically. Preserve immutable submission sequence. A matching retry returns the original acceptance; conflicting reuse or an obsolete expected revision fails explicitly. New queue membership, eligibility changes and accepted edits invalidate older edit bases. New queued Tasks append by submission order unless a later accepted edit changes their position. Immediate Tasks keep submission identity/sequence but do not enter this reorderable queue.

Use `POST /entities/{entity_id}/task-order/confirm` for the assigned Asset to report whether it adopted a particular requested revision. Store requested order/revision separately from Asset-confirmed order/revision. Repeated matching reports are harmless; an older confirmation cannot acknowledge a newer request or roll back a later confirmation. A report that the Asset could not apply the revision records conflict and its relevant execution facts rather than implying adoption. Clients reconcile before submitting a new revision.

Only queued Tasks that have never started and remain eligible for execution can be reordered. Cancellation-requested and terminal Tasks are excluded. Started Tasks stay excluded while paused; suspension does not make a Task unstarted. If a Task starts on the Asset before it sees a reorder, it reports that conflict and actual execution; Core must not reject reality merely because operator intent changed. Disconnected Assets can continue their last adopted order. Confirmation means the Asset adopted an order at that point, not that the queue stops changing afterward.

The Task-list response carries requested/confirmed revisions and an edit revision with the relevant ordered list; pagination must detect an invalidated view before accepting a full-list edit. Queue updates and confirmations must reach synchronized clients through the Task/assigned-queue contract, atomically enough to avoid presenting mixed revisions as a confirmed order. Concrete event envelopes and paging fields remain schema work. No Core readiness gate or execution scheduler is introduced.

## Queued and immediate scheduling

Accepted on 22 September 2026. Every invocation remains a Task. Creation selects immutable `scheduling`: `queued` or `immediate`, permitted by both the Protocol Command definition and the Asset's advertised support. A Command may support both, allowing the caller to queue a lights change or request it immediately. Pause and Resume require immediate scheduling. Default selection and exact capability fields remain schema work; unsupported combinations fail validation rather than silently changing scheduling.

Queued Tasks execute sequentially in the Asset's confirmed queue order. Immediate Tasks do not wait for a queued Task to finish and are not inserted into or reordered within that queue. Independent immediate actions may execute alongside current work: turning lights on during Move To leaves that movement and the remaining queued path unchanged. Immediate does not imply interrupting all work; the Command defines its effect and the Asset implementation coordinates its hardware resources. Conflicting simultaneous immediate Commands require declared behavior; their arbitration is not a new generic Core priority scheduler.

Core accepts, stores and publishes Tasks through the ordinary API; the Asset OS decides execution locally. An outstanding-Task read or hybrid subscription must include immediate Tasks independently of queued-work position, including while the Asset is paused. Immediate Tasks retain ordinary retry identity, report authority, lifecycle and outcomes. Multiple Tasks may therefore be in progress on an Asset while only one queued Task actively executes. The queued one-at-a-time restriction must not be applied globally.

Immediate means prompt Asset handling once received, not guaranteed zero latency or guaranteed delivery during disconnection. The older universal 60-second start deadline and Core-controlled release of the next immediate Task remain excluded. Late delivery, expiry policy and arbitration between conflicting immediate Commands require further contract work before implementation; do not silently assume indefinite delayed execution or inherit the older deadline.

## Pause through an immediate Command

The caller creates an ordinary Task for the Protocol-defined Pause Command using immediate scheduling. Core records the request; it does not directly set the Asset's state. The Asset handles Pause without waiting for its running queued Task to finish, interrupts that work, enters its Asset-defined idle or holding behavior, reports operational status `paused`, and waits. Starting the next queued Task would violate that paused condition. Queued Tasks and their order are retained. Pausing an already idle Asset simply establishes the same paused condition without inventing an interrupted Task.

The Pause Task and the interrupted Task are distinct. The Pause Task records execution of the control action; it completes once the Asset confirms it has entered the paused condition, rather than remaining in progress for the entire wait. A suspended current Task reports nonterminal `paused`, with execution/progress information preserved. It does not become failed, cancelled or completed merely because Pause was requested. The Asset may keep reporting telemetry and handle supported independent immediate actions while paused; those actions do not clear pause or release the queued path.

Asset status, interrupted-Task status and Pause-Task outcome use their existing authenticated reporting paths. Core cannot infer one from another. Reports can arrive separately, and reads must not falsely claim all confirmations arrived together. A failed Pause attempt must not manufacture a paused Asset or suspended Task. A duplicate delivery of the same accepted Pause Task must not reapply the control effect after it has completed; an intentional later Pause is a new Task.

A pending cancellation remains `cancellation_requested` even if the Asset physically suspends the work; record suspension as an execution fact without clearing cancellation intent. Valid completion or failure may still win a race before suspension is confirmed. A late pre-pause start/progress report must not resume a paused Task, and a late pause report cannot reopen a terminal Task. If a completion report was already accepted and its required Objects later become ready, normal completion conditions may resolve the Task without unpausing the Asset or releasing its queue.

## Resume through an immediate Command

Accepted after the Pause clarification: the caller submits a distinct immediate Resume Task. The Asset continues the interrupted Task before the remaining queued work, preserving the Task ID and progress rather than creating a new execution. It reports the suspended Task back to `in_progress`, reports its operational condition as `busy`, and completes the Resume Task when the control action has been applied; Resume completion does not mean the interrupted work has finished. A delayed pre-pause start report cannot serve as resume confirmation. The report must establish that it belongs to the applied Resume action; exact control/report correlation fields remain schema work.

If the interrupted Task cannot safely resume, the Asset reports that Task `failed` with a reason instead of pretending to continue it or automatically rerunning it from the beginning. The Resume attempt must accurately report what it achieved. Whether the Asset then advances to later queued work after that failure follows its failure/reconciliation policy, which remains to be specified; no silent successful-resume claim or new Core scheduler is introduced. If the suspended Task was already cancelled, completed or failed, Resume cannot reopen it.

When there is no suspended Task, Resume releases the paused queue and the Asset reports `ready` or `busy` according to its actual work. Resume never bypasses unresolved cancellation intent on a suspended Task. That cancellation must be reconciled with the Asset before treating the work as resumable. Duplicate delivery of the same completed Resume Task has no further control effect; an intentional later Resume uses a new Task identity.

No timeout, reconnect, new queued Task, unrelated immediate action or caller status edit implicitly resumes execution. Requesting Resume alone does not clear a reported pause. Asset reports may arrive separately; Task/Asset reads preserve that distinction rather than manufacture atomic confirmation. Exact arbitration for conflicting or stale Pause/Resume deliveries and control/report ordering must be settled before implementation.

## Modernization reference

The locally inspected pinned source at `8edee4e2743fbf0f85c16dfe638d9222141cf279` already distinguishes [queued and overlapping immediate Tasks](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L258). Its [Core start-order validation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_transition.go#L363) and [delivery filtering](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_runtime.go#L356) impose server scheduling that is not carried forward. The earlier [controlled-stop proposal](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L531) cancels earlier queued work; it does not establish this successor's pause-and-retain semantics. No implemented Pause/Resume contract was established by the reviewed source sections.

[Task cancellation does not cancel result uploads](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads). Data arriving later cannot reopen a terminal Task.
