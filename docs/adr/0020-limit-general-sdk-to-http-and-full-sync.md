---
status: accepted
---

# Limit the general SDK to HTTP and full synchronization

Accepted on 28 September 2026. The general Atlas SDK serves IP-connected applications, Command Interfaces, Plugins and radio gateways. Its supported read modes are HTTP pass-through and full synchronization. Remove Asset hybrid from the current SDK scope and defer Core's matching Asset-scoped snapshot, feed and replay contract. The expected constrained link is between a radio gateway and Assets; the gateway's IP connection to Core has sufficient bandwidth for the full operational picture.

## Deployment and responsibilities

A gateway usually runs separately from Core and may also run on the Core machine. It need not share Core's local network. Adequate IP bandwidth is a deployment assumption, not a throughput guarantee or a requirement for internet access. The ordinary offline operating model still applies when consumers can reach Core.

The general SDK is not required on Asset firmware or in an Asset OS. Device execution and constrained transport belong to the Asset/gateway integration. A future deployment with a constrained IP link may use a dedicated SDK or integration designed for it; this decision does not add that deliverable to the current scope.

Gateways use the general SDK to interact with Core and can obtain the full picture, then select what crosses their radio link. The SDK's Core-facing Asset client still concentrates enrollment, report identity, retries and reconciliation for gateway software and simulated-Asset fixtures. It does not implement the Asset OS or a radio protocol. A gateway must preserve authenticated Asset origin, process authority and execution evidence; a gateway connection or generic Plugin identity is not permission to impersonate an Asset. Concrete relay proof and transport messages remain engineering work.

## What changes

Keep one public resource-read, query and feed interface for the two modes. HTTP uses Core directly; full synchronization uses its local picture with no hidden HTTP fallback. Both modes write to Core and return its committed result under [ADR-0018](0018-confirm-writes-when-core-commits.md). Local history, cursor expiry, ordered reconciliation, readiness and Dataset Reset behavior remain required.

The SDK no longer routes reads between an Asset subset and out-of-scope HTTP requests. Core no longer needs automatic per-Asset dependency membership, scope-entry/removal events, filtered hybrid snapshots/replay or continuation proofs for excluded changes. The corresponding hybrid-only test requirements are deferred. Merely hiding the SDK mode while retaining those obligations in Core would not deliver the selected simplification.

This removes a synchronization mechanism, not Task meaning. Keep assigned-work reads, requested/confirmed queue state, cancellations, terminal-record retention, typed Command references and required-result protection. Full synchronization must still deliver coherent queue state and updates to referenced resources. A future radio integration must deliver current instructions and the changing data required by its Commands, with appropriate recovery; a one-time Task download is not sufficient for a Command that needs live Track updates. Its specialized delivery contract does not require a general partial replica in the SDK.

## Superseded planning

This supersedes the earlier three-mode plan, automatic Asset hybrid coverage and Task dependency publication used solely to maintain that coverage. The [SDK data-access plan](../sdk-data-access.md) owns the current two-mode behavior. Earlier hybrid decisions remain historical context in the [reconciliation record](../planning-reconciliation.md#sdk-and-gateway-decisions-28-september-2026).

The tradeoff is deliberate: the general SDK gives up a bandwidth-optimized maintained subset for simpler Core/SDK synchronization. Reconsider specialized filtering only with a concrete consumer, rather than carrying it for a hypothetical constrained IP deployment. Full-picture capacity, bounded recovery and the [real integration evidence](../testing-strategy.md) still need measurement and implementation.
