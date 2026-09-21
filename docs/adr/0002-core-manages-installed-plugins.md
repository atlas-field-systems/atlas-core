---
status: accepted
---

# Core manages installed Plugins

Core owns starting and stopping installed Plugins, rather than requiring the operator to run their processes separately. The user selected this lifecycle on 20 September 2026. Plugin management is a responsibility of the Core system, while Plugin implementations may remain in separate repositories.

Accepted Plugin Operations have a Core-owned attempt identifier and queryable state/outcome retained until Reset. The caller can request cancellation, but caller disconnection does not cancel accepted work. Request-bound invocation and the old universal 25-second timeout do not define this lifecycle. Stop/Start and Restart preserve Operation records; Reset clears them. Execution continuity across a whole-Core restart is outside scope; retaining Operation records does not require resumption or rerun of their execution. Installed Plugin selections, credentials, configuration and artifacts survive both startup and Reset; startup reapplies that setup.

The Plugins module owns the lifecycle policy and reported state. The CLI and TUI are local administrative interfaces using internal management mechanisms, not the public Atlas API or SDK. Plugin installation, removal, updates, configuration, enable/disable, process start/stop/restart and force stop are local-only management actions. They have no public API endpoints or SDK methods. CLI and TUI share the local management implementation; the internal coordination mechanism remains an implementation choice. The runtime mechanism, process or container supervision and installation format still need design. On Plugin failure, Core reports a fault and supports an operator-requested restart, including for continuous-source Plugins; automatic restart is not required for the first version. [Planned stops and updates protect active Plugin work](0006-protect-active-plugin-work-during-lifecycle-changes.md). This decision does not select a marketplace, automatic updates, or support for separately operated remote Plugins.

Installing, updating, removing, enabling or disabling a Plugin must leave Core and unrelated Plugins running, without a Core restart or interruption of its APIs and Asset connections. Planned lifecycle changes still respect active-work protection. This specifies independent lifecycles, not an in-process code-replacement mechanism.

The user accepted these submission and failure rules on 21 September 2026:

- The SDK gives a submission a stable identity. Retrying the same submission after a lost acceptance response returns the original Operation and its current state. An explicit rerun uses a new submission identity and creates a new Operation. Submission identity is scoped to the current dataset; Reset must not turn an old retry into a new invocation.
- A failed Operation keeps the Atlas resources and effects it successfully produced. Core makes known outputs attributable to the Operation. Failure does not imply that nothing happened, and Core does not automatically undo effects or rerun the attempt.
- A deliberate rerun may produce additional results. Handling existing results belongs to the Plugin. Core does not promise a complete inventory of arbitrary external effects or a transaction spanning Plugin behavior and external systems.

Plugins release independently of Core. Their packaging and distribution mechanisms remain implementation choices. Startup validates retained setup: incompatible Plugins remain installed but disabled with an explanation; compatible enabled Plugins start normally. See [compatibility](0005-allow-compatible-client-versions.md).

This clarifies the earlier management-interface proposal. Core still owns installed Plugin lifecycle behavior, but the local CLI/TUI provides its administrative controls. Public consumers may discover available Plugin capabilities and status, invoke Operations, inspect outcomes and request Operation cancellation through the SDK. Canceling an Operation is distinct from stopping its Plugin process. The earlier Command Interface Plugin restart action is superseded by local-only administration.
