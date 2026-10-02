---
status: accepted
---

# Core manages installed Plugins and their Operations

Atlas owns starting and stopping installed Plugins rather than requiring the operator to run their processes separately. The user selected this so removable extensions can live in separate repositories while Atlas manages their availability. Plugin invocation previously used a request-bound invocation with a universal 25-second timeout.

Current rules: [Plugins](../topics/plugins.md).

## Decision

Core's Plugins module owns installed Plugin lifecycle policy and reported state. [ADR-0017](0017-deploy-core-and-plugins-as-docker-containers.md#ownership-and-lifecycle) places the Docker actions in the host-side local management module, and [local administration](../architecture/system-design.md#local-administration) defines the CLI/TUI boundary. Installing, updating, removing, enabling or disabling a Plugin leaves Core and unrelated Plugins running.

Accepted Operations have a Core-owned identifier, queryable state and outcome, and their own lifecycle separate from Task statuses, ending in Completed, Cancelled, Failed or Interrupted. Caller disconnection does not cancel accepted work. A retried submission returns the original Operation; a deliberate rerun is a new Operation. A failed Operation keeps its known effects and outputs, and Core neither undoes them nor reruns the Operation automatically.

[ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md) governs active-work protection and fault handling. [ADR-0005](0005-allow-compatible-client-versions.md) governs Plugin compatibility and startup validation. [ADR-0015](0015-separate-start-stop-restart-and-reset.md) governs retained setup and Operation records, and [ADR-0021](0021-manage-plugin-operational-storage-through-reset.md) governs Plugin-scoped cleanup on uninstall.

Decision history:

- 20 September 2026: the user selected Core management of installed Plugins.
- 21 September 2026: the user accepted the Operation submission and failure rules.

## Rationale and alternatives

- Core management lets removable extensions live in separate repositories while Atlas manages their availability.
- Placing Docker actions in the host-side management module lets Plugins be stopped even when Core has failed.
- Independent lifecycle management does not require in-process code replacement.
- A Core-owned Operation lifecycle separates server-owned processing from the lifetime of the operator's connection. The old request-bound invocation and universal 25-second timeout do not define it.
- Submission identity scoped to the current Dataset keeps Reset from turning an old retry into a new invocation.

## Consequences

- Plugins release independently of Core.
- Failure does not imply that nothing happened. Handling existing results on a rerun belongs to the Plugin, and Core does not promise a complete inventory of arbitrary external effects or a transaction spanning Plugin behavior and external systems.
- Published Atlas resources and Core Operation records keep their own lifetimes when a Plugin is uninstalled.
- Private Docker-control coordination, installation metadata, distribution and invocation fields remain open.
- This decision does not select a marketplace, automatic updates or separately operated remote Plugins.
