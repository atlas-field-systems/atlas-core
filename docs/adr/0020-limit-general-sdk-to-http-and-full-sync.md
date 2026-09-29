---
status: accepted
---

# Limit the general SDK to HTTP and full synchronization

The earlier plan gave the general Atlas SDK three read modes, including an Asset hybrid mode that maintained an Asset's Tasks and dependencies locally while reading unrelated data through HTTP. Core would have supported it with automatic per-Asset dependency membership, scope-entry and removal events, filtered hybrid snapshots and replay, and continuation proofs for excluded changes. The expected constrained link, however, is between a radio gateway and Assets; the gateway's IP connection to Core has sufficient bandwidth for the full operational picture.

Current rules: [SDK](../topics/sdk.md).

## Decision

The general Atlas SDK serves participants on IP links without bandwidth limits: applications, Command Interfaces, Plugins, IP-connected Assets and radio gateways. Its supported read modes are HTTP mode and Full synchronization mode, behind one public resource-read, query and feed interface. HTTP uses Core directly; full synchronization uses its local picture with no hidden HTTP fallback. Both modes write to Core and return its committed result under [ADR-0018](0018-confirm-writes-when-core-commits.md).

Remove Asset hybrid from the current SDK scope and defer Core's matching Asset-scoped snapshot, feed and replay contract, including automatic per-Asset dependency membership and Task dependency publication used solely for that coverage.

The boundary is bandwidth, not whether the participant is an Asset. Bandwidth-limited Assets do not run the general SDK; their execution and constrained transport belong to the Asset OS and a radio gateway. Gateways use the general SDK, can obtain the full picture and select what crosses their radio link. Each gateway authenticates with its own gateway identity, which may read and may relay only for the Assets bound to it.

This removes a synchronization mechanism, not Task meaning. Assigned-work reads, requested and confirmed queue state, cancellations, terminal-record retention, typed Command references and required-result protection remain.

Decision history:

- 26 September 2026: the user accepted one SDK Asset client for Core-facing Asset interactions; this decision later revised its consumer scope.
- 27 September 2026: the unified-interface decision kept one public resource-read, query and feed interface. It remains in force for the two modes.
- 28 September 2026: accepted. This supersedes the earlier three-mode plan, automatic Asset hybrid coverage and Task dependency publication used solely to maintain that coverage. The same day the user clarified that the boundary is bandwidth, so an IP-connected Asset without bandwidth limits uses the general SDK like any other consumer, and that the SDK remains TypeScript only for now.

## Rationale and alternatives

- The tradeoff is deliberate: the general SDK gives up a bandwidth-optimized maintained subset for simpler Core/SDK synchronization.
- Merely hiding the SDK mode while retaining the hybrid obligations in Core would not deliver the selected simplification.
- Reconsider specialized filtering only with a concrete consumer, rather than carrying it for a hypothetical constrained IP deployment. A future deployment with a constrained IP link may use a dedicated SDK designed for it; this decision does not add that deliverable to the current scope.
- The extra traffic of the general SDK is acceptable for IP-connected Assets without bandwidth limits.
- A Command that needs live data, such as Track updates, is not served by a one-time Task download, but its specialized radio delivery contract does not require a general partial replica in the SDK.
- Making gateways Assets in their own right is a recorded future proposal, not an accepted direction.

## Consequences

- The hybrid-only test requirements are deferred.
- Full synchronization must still deliver coherent queue state and updates to referenced resources. A future radio integration must deliver current instructions and the changing data required by its Commands, with appropriate recovery.
- [ADR-0024](0024-use-live-geofeature-geometry-in-tasks.md) also requires delivery of changing Geofeature geometry to existing Tasks. The full picture carries the committed Entity updates; the Asset client or gateway delivers them to execution, without restoring Core hybrid filtering.
- An IP-connected Asset's software either uses TypeScript or runs the SDK in a companion process; another SDK language would be a separate decision.
- Adequate IP bandwidth is a deployment assumption, not a throughput guarantee or a requirement for internet access; the ordinary offline operating model still applies when consumers can reach Core. Full-picture capacity, bounded recovery and the [real integration evidence](../testing-strategy.md) still need measurement and implementation.
- Concrete relay proof and transport messages remain engineering work.
- Earlier hybrid decisions remain historical context in the [decision log](../planning-reconciliation.md#sdk-and-gateway-decisions-28-september-2026).
