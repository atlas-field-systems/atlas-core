---
status: accepted
---

# Core manages installed Plugins

Core owns starting and stopping installed Plugins, rather than requiring the operator to run their processes separately. The user selected this lifecycle on 20 September 2026. Plugin management is a responsibility of the Core system, while Plugin implementations may remain in separate repositories.

Accepted Plugin Operations have a Core-owned attempt identifier and queryable state/outcome retained until Reset. The caller can request cancellation, but caller disconnection does not cancel accepted work. Request-bound invocation and the old universal 25-second timeout do not define this lifecycle. Stop/Start and Restart preserve Operation records; Reset clears them. Record retention does not imply automatic resumption or rerun of interrupted execution. Installed Plugin selections, credentials, configuration and artifacts survive both startup and Reset; startup reapplies that setup.

The Plugins module owns the lifecycle policy and reported state. The runtime mechanism, process or container supervision and installation format still need design. On Plugin failure, Core reports a fault and supports an operator-requested restart, including for continuous-source Plugins; automatic restart is not required for the first version. [Planned stops and updates protect active Plugin work](0006-protect-active-plugin-work-during-lifecycle-changes.md). This decision does not select a marketplace, automatic updates, or support for separately operated remote Plugins.

Installing, updating, removing, enabling or disabling a Plugin must leave Core and unrelated Plugins running, without a Core restart or interruption of its APIs and Asset connections. Planned lifecycle changes still respect active-work protection. This specifies independent lifecycles, not an in-process code-replacement mechanism.
