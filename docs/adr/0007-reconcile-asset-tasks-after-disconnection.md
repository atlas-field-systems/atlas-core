---
status: accepted
---

# Reconcile Asset Tasks after disconnection

Operators can issue Tasks and cancel outstanding Tasks while an Asset is disconnected, and Assets retain an onboard Task queue. The user selected this behavior to support intermittent field and radio connections, including cancelling outstanding work and issuing a return Task. Atlas Modernization instead required a registered, ready execution runtime for Task creation, failed immediate Tasks outside a 60-second start window, filtered delivery in Core and wrote terminal `cancelled` as soon as cancellation was requested; see rows D11 to D14 of the [comparison register](../architecture/modernization-differences.md).

[ADR-0020](0020-limit-general-sdk-to-http-and-full-sync.md) limits the general SDK to HTTP and full synchronization and defers Core per-Asset snapshot/feed/replay coverage. IP-connected Assets without bandwidth limits use the general SDK and its Asset client directly; bandwidth-limited Assets reach Core through a gateway that uses the Asset client. Constrained transport remains separate from the general SDK. Gateway placement requires an adequate IP link to Core, not the same host or LAN. This changes delivery scope, not Asset report authority, execution ownership or the reconciliation guarantees below. The disconnected-Asset workflow applies while Core remains running; retention and the exclusion of whole-Core mission resumption follow [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Current rules: [Tasks](../topics/tasks.md).

## Decision

Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work. During reconnect reconciliation, Core accepts reports of work performed while away and supplies the current Tasks, including cancellations and new instructions, for reconciliation with the Asset's onboard queue. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history.

The Asset OS owns execution, interruption and the confirmed onboard queue. Core assigns immutable per-Asset submission sequence, records operator-requested order separately from Asset-confirmed order, and validates Command/target contracts and assigned-Asset report authority. Core does not start Tasks, enforce a live readiness gate or treat connection loss as a reason to refuse tasking.

Cancellation intent is the nonterminal Task status `cancellation_requested`, followed by `cancelled` only when the assigned Asset confirms it. Every request is recorded regardless of declared cancellation support, and an Asset that cannot withdraw the Task declines the request. Confirmed cancellation, not the Asset's inferred knowledge, is the boundary. Core validates and records the Asset's reported outcome; the Asset OS decides how to respond.

Every invocation is a Task with immutable queued or immediate scheduling. Immediate Tasks bypass the queue, and Pause and Resume are immediate Commands: Pause suspends current queued work and retains the queue, and Resume continues the suspended Task first. Newer Pause or Resume intent, compared by Core acceptance order, wins over delayed older controls. Pause never expires; Resume carries a declared expiry.

After an unexpected Asset-process restart, retained Tasks are reconciliation input. The Asset reports what its execution evidence establishes and keeps uncertain work back for explicit recovery. A private, Core-issued process generation with stable report identities prevents an obsolete process from rewriting reconciled state.

Decision history:

- 21 September 2026: the user replaced the earlier "before the Asset learned of cancellation" condition with confirmed cancellation as the boundary.
- 22 September 2026: the user revised the earlier six-status decision, making cancellation intent the nonterminal status `cancellation_requested`. This supersedes the separate-field-only representation. Queued and immediate scheduling was accepted the same day.
- 23 September 2026: the user accepted a private reporting-authority mechanism as a prerequisite for implementing recovery.
- After the Pause clarification, the user accepted immediate Resume; control ordering was accepted after the latest design review.
- 28 September 2026: the user accepted recording every cancellation request regardless of declared support, added cancellation declined, and set Pause to never expire and Resume to carry a declared expiry.

## Rationale and alternatives

- Reconcile actual execution and current operator intent rather than replaying every historical instruction as executable work.
- Server scheduling, the universal 60-second immediate-start deadline and Core-controlled release of immediate Tasks are removed; the Asset OS owns execution. Command-specific validity rules and optional deadlines replace them.
- Cancellation intent is a nonterminal status, superseding both a terminal status on request and a separate-field-only representation. Cancelled requires Asset confirmation; a decline records the refusal without an outcome.
- Core does not infer the Asset's knowledge of a request from wall-clock timestamps; confirmation is the boundary.
- The earlier Modernization controlled-stop proposal cancels earlier queued work. Pause instead suspends and retains it.
- Pause never expires because stopping late is still safe. Resume expires because restarting work late is the dangerous direction.
- A status value or newly claimed process ID cannot distinguish an old process from its replacement, so recovery uses Core-issued process generations. The public execution-session API and automatic failure on restart are not reinstated.
- Automatic lost-Asset failure and an operator-forced terminal override are excluded.

## Consequences

- Assets need an onboard queue, local execution decisions and the ability to report outcomes of work performed while away.
- A Task can remain `cancellation_requested` for as long as its Asset stays out of contact, and several Tasks may be in progress on one Asset while only one Queued Task executes.
- Operational status, suspended-Task status and control-Task outcomes arrive separately, and reads must not present them as one atomic confirmation.
- The private report-authority mechanism is a prerequisite for implementing recovery; exact authority-transfer proof and report ordering remain engineering work.
- Wire fields, report correlation, deadline and expiry fields and recovery messages remain Protocol and engineering work.
- Duplicate deliveries and ordinary reordering must pass the integration scenarios before the control contract is implemented.

## Task transitions

The Task status set and transition table are specified in [Task status and transitions](../topics/tasks.md#task-status-and-transitions).

## Modernization reference

The locally inspected pinned source at `8edee4e2743fbf0f85c16dfe638d9222141cf279` already distinguishes [queued and overlapping immediate Tasks](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L258). Its [Core start-order validation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_transition.go#L363) and [delivery filtering](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/actions/task_runtime.go#L356) impose server scheduling that is not carried forward. The earlier [controlled-stop proposal](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L531) cancels earlier queued work; it does not establish this successor's pause-and-retain semantics. No implemented Pause/Resume contract was established by the reviewed source sections.
