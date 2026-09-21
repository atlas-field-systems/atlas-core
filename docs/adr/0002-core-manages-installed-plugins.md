---
status: accepted
---

# Core manages installed Plugins and their Operations

Core owns starting and stopping installed Plugins rather than requiring the operator to run their processes separately. The user selected this on 20 September 2026 so removable extensions can live in separate repositories while Atlas manages their availability. Plugins owns lifecycle policy and reported state; [local administration](../architecture/system-design.md#local-administration) defines the CLI/TUI boundary.

Installing, updating, removing, enabling or disabling a Plugin must leave Core and unrelated Plugins running, without restarting Core or interrupting its APIs and Asset connections. This is independent lifecycle management, not a requirement for in-process code replacement. [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md) governs active-work protection and fault handling. Plugins release independently of Core; [ADR-0005](0005-allow-compatible-client-versions.md) governs compatibility and startup validation. [ADR-0015](0015-separate-start-stop-restart-and-reset.md) governs retained setup and Operation records.

## Operation submission and effects

Accepted Operations have a Core-owned attempt identifier and queryable state/outcome. The caller can request cancellation, but disconnection does not cancel accepted work. The old request-bound invocation and universal 25-second timeout do not define this lifecycle. This separates server-owned processing from the lifetime of the operator's connection.

The user accepted these submission and failure rules on 21 September 2026:

- The SDK gives a submission a stable identity. Retrying after a lost acceptance response returns the original Operation and its current state. An explicit rerun uses a new identity and creates a new Operation. Identity is scoped to the current dataset; Reset must not turn an old retry into a new invocation.
- A failed Operation keeps its successful Atlas resources and effects, with known outputs attributable to the attempt. Failure does not imply that nothing happened. Core does not automatically undo effects or rerun the attempt.
- A deliberate rerun may produce additional results. Handling existing results belongs to the Plugin. Core does not promise a complete inventory of arbitrary external effects or a transaction spanning Plugin behavior and external systems.

[ADR-0017](0017-deploy-core-and-plugins-as-docker-containers.md) selects sibling Docker containers for installed Plugins. Private Docker-control coordination, installation metadata, distribution and invocation fields remain open. This decision does not select a marketplace, automatic updates or separately operated remote Plugins.

## Operation transitions

Operations use their own lifecycle, separate from the Task statuses. Core owns the recorded state; Plugin reports supply execution outcomes.

| New state | Allowed previous state | Trigger |
| --- | --- | --- |
| Pending | No Operation | Core accepts the submission |
| In progress | Pending | Plugin reports processing has started |
| Cancellation requested | Pending, In progress | Core accepts an Operation cancellation request |
| Completed | Pending, In progress, Cancellation requested | A successful outcome is confirmed |
| Canceled | Pending, In progress, Cancellation requested | Cancellation is confirmed, including Core confirming that undispatched work will not be started |
| Failed | Pending, In progress, Cancellation requested | A definitive unsuccessful outcome is confirmed |
| Interrupted | Pending, In progress, Cancellation requested | Core can no longer establish the attempt's completion or cancellation, including interrupted work at Stop/Restart or an unconfirmed outcome after Plugin loss |

Progress cannot clear Cancellation requested. Completed, Canceled, Failed and Interrupted are terminal for that attempt; matching repeated reports have no new effect and conflicting reports cannot rewrite the terminal state. Interrupted records uncertainty, not proof that all external effects stopped or that nothing happened. Preserve confirmed outcomes and known effects before classifying remaining work as interrupted.

Retrying a submission returns its original attempt and state, including Interrupted. A deliberate rerun creates a new attempt; neither Plugin restart nor Core restart reruns it automatically. [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md) governs planned stops and faults; [ADR-0015](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart) governs whole-Core interruption.
