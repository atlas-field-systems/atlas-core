# Asset status

Operational status, Communication state, Contact, check-in and report acceptance are specified in [Asset reporting](topics/asset-reporting.md). This file retains only the Task integration notes until a Tasks topic page replaces them. This is a planning document; no implementation exists in this repository.

## Task integration

Assets fetch their full outstanding Task list, following pagination as needed, and queue Tasks locally. Queued Tasks execute one at a time, oldest submission first by default, following confirmed reordering of eligible, unstarted queued Tasks. Several move-to Tasks can therefore define a path. A busy Asset can receive further Tasks; Core does not reject them merely because another Task is running.

Core assigns a permanent increasing submission sequence per Asset when accepting each Task. The sequence defines default execution order independently of client clocks, and assigned-work reads return that order. Exact field encoding remains to be designed. Retrying Task creation must not create another queue entry or change the original Task's order. Fetching the list does not itself acknowledge or start Tasks.

Communication state does not gate Task creation or change Task scheduling or execution behavior in Core. The Asset controls execution. Core still validates Protocol schemas, supported Commands, and legal Task lifecycle transitions; it does not act as the Asset's scheduler. Losing connectivity does not change existing unfinished Tasks.

Core accepts and retains valid Tasks even when the Asset is offline. Tasks keep their assignment order until the Asset receives them and controls execution. This replaces the earlier offline Task-creation rejection rule.

Planned shutdowns and restarts are expected only after unfinished work has been resolved. If an exceptional interruption occurs, reconcile with the Asset before deciding the outcome of unfinished Tasks. Do not automatically fail them merely because connectivity was lost or the Asset restarted.

Core-facing clients discover assigned work through `GET /entities/{entity_id}/tasks`, using an outstanding-work filter, or through the full synchronized picture and its Task changes. Per-Asset snapshot/feed/replay synchronization is deferred under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). The Asset tracks and executes its queue; its Core-facing client reports those transitions through the Task status endpoint. The Asset reports `acknowledged` when accepting a Task into its local queue and `in_progress` when execution begins. Exact filtering remains to be specified.

Eligible, unstarted queued Tasks, including acknowledged Tasks, can be reordered. Submission sequence stays immutable. Requested queue order is distinct from the order confirmed by the Asset; disconnected Assets can continue their last confirmed order. Started, paused, cancellation-requested and terminal Tasks cannot be moved.

A cancellation request sets Task status to `cancellation_requested` without proving execution stopped. Core records the request whether or not the Asset declares cancellation support. Retain execution facts until the assigned Asset confirms `cancelled`, declines the request, which returns the Task to the execution status its reports establish, or reports another valid outcome. The [Task transition table](adr/0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) owns these rules. Immediate Pause suspends current queued work and places the Asset in `paused`. Supported independent immediate actions can still run without clearing that state. The suspended Task separately reports `paused`; the Pause Task completes when applied. Immediate Resume continues the suspended Task before the remaining queue; an unsafe-to-resume Task reports failure and the Asset stays paused. See the [Pause contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#pause-through-an-immediate-command).

Task reports use `PATCH /tasks/{task_id}/status`, replacing the separate lifecycle action routes without requiring the former execution-session identity. Task IDs, immutable Asset assignment, idempotency, and legal lifecycle transitions still matter. Current status is not a substitute for all of those rules.

The earlier model used a process identity to reject late reports from an older process and to fail outstanding Tasks on restart. A status value alone cannot distinguish an old process reporting `ready` from its replacement reporting `ready`. The accepted [recovery rule](adr/0007-reconcile-asset-tasks-after-disconnection.md#recovery-after-an-unexpected-asset-restart) now selects private process generations and report identities as the direction for replacing that safeguard, without restoring the public execution-session API or automatic Task failure. Reconcile and keep uncertain work back before execution; exact authority-transfer proof, ordering and freshness fields remain engineering work.

Pending decisions:

- The mechanics of reconciling unfinished Tasks after an exceptional interruption, without assuming an outcome from Asset status alone.
- Detailed sequence encoding and Asset behavior after cancellation or failure of a queued Task.
- Exact Task/queue reporting and event fields under the accepted revision contract.
- Report correlation and Command-specific deadline and expiry fields. Newer Pause/Resume intent wins; a failed resumption leaves the Asset paused until another explicit Resume.

## Source

Source snapshot: Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`, read locally. The [earlier Task and execution-session design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md) is retained as historical context for the safeguards that need a replacement decision.
