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
- 7 October 2026: in the execution-bookkeeping design interview, the user said, "I agree with your recommendations," accepting live duplicate detection with durable unacknowledged evidence and prompt Interrupted classification after confirmed runtime loss.
- 7 October 2026: in round two, the user said, "I agree with recommendations," accepting refusal before fresh acceptance when receipt capacity is full, nonterminal same-runtime reconnection and a separate public Recovered outcome with its typed result/error.

### Execution evidence

Replace the required durable Plugin acceptance/running ledger and inspection exchange with live duplicate receipts and durable unacknowledged outcomes and known-effect evidence. Core's durable acceptance, exposure-before-send and runtime/Core-run fencing remain. After confirmed Plugin runtime loss, Core promptly classifies exposed unresolved work Interrupted using its already-confirmed evidence; it does not wait for manual replacement. Later retained evidence supplements that terminal record without reopening it. Current rules live in [private dispatch and reconciliation](../topics/plugins.md#private-operation-dispatch-and-reconciliation).

The durable acceptance ledger was considered because it preserves dispatch history after a crash. The smaller contract removes those per-Operation writes and inspection obligations while preserving durable evidence and the prohibition on replacement execution. Live receipts survive evidence acknowledgement, so their capacity is a runtime admission bound: refuse fresh invocations before acceptance when full and leave capacity recovery to an explicit protected Plugin restart. A Pending queue waiting for that restart was rejected because it accepts work that needs an administrator to proceed.

Private-channel loss while the original runtime remains alive pauses new admission without making existing Operations terminal. Verified authenticated reconnection retains that runtime's receipts; connection loss alone establishes neither death nor stopped effects. Existing reads expose [Recovered outcomes](../topics/plugins.md#recovered-outcomes) separately from Interrupted rather than hiding the saved typed result or returning ordinary success. Host supervision and lifetime leases are separate and retain their current rules. Numeric budgets and representation details remain engineering work.

The [prototype at 6c311233365f155f40d52a90d94973d12993313a](https://github.com/atlas-field-systems/atlas-core/blob/6c311233365f155f40d52a90d94973d12993313a/docs/architecture/atlas-review.prototype.html) and [#64 context comment](https://github.com/atlas-field-systems/atlas-core/issues/64#issuecomment-6021152923) provide research context, including the duplicate-execution counterexample when acknowledgement deletes a live receipt. User acceptance establishes this decision; the prototype is not production or qualification evidence. S3 owns the real workflow and fault evidence, with S7 extending host/storage and capacity coverage.

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
