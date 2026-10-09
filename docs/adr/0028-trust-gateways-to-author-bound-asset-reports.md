---
status: accepted
---

# Trust gateways to author reports for bound Assets

Accepted on 6 October 2026. The user described constrained radio grammars that cannot be assumed to carry the Core-facing Asset API and confirmed the resulting trust boundary and current gateway scope. This revises the originating-signature requirement for gateway reporting, while retaining the Task reconciliation and process-authority guarantees in [ADR-0007](0007-reconcile-asset-tasks-after-disconnection.md) and the adequate-IP SDK boundary in [ADR-0020](0020-limit-general-sdk-to-http-and-full-sync.md).

Current rules: [Report authority and relay](../topics/asset-reporting.md#report-authority-and-relay), [process authority](../topics/asset-reporting.md#process-authority-establishment-and-replacement) and [Radio gateways](../topics/identity-and-access.md#radio-gateways).

## Context

The earlier reporting design required gateways to forward an Asset's Core-format signed facts, including process replacement and freshness evidence. That makes the originating Asset responsible for a cryptographic envelope shaped around an unrestricted IP API. A constrained radio integration may instead encode compact device messages that its gateway interprets and turns into Core-facing reports.

Translation requires a deliberate reporting authority. An authenticated gateway can be trusted for its explicit downstream bindings, or each radio Asset must independently produce signatures Core can verify. The user selected gateway authority for the constrained path.

## Decision

Core authenticates a gateway as itself and checks its explicit binding to each downstream Asset it reports for. The gateway may translate, reconstruct and submit Core-facing reports from the Asset's evidence. Core does not independently verify an originating Asset's Core-format signature on that path. The radio grammar need not carry Core JSON, report envelopes, process-signing keys or the direct IP recovery proof.

Each downstream Asset remains a distinct participant with its own Asset ID, Tasks and outcomes. The shared acceptance guarantees remain: stable report identities and retries, ordering without regression, Dataset boundaries, Core-issued process generations and rejection of obsolete processes. A gateway restart is a communication interruption, not replacement of every downstream Asset process. Historical evidence remains distinct from fresh Contact; a gateway's live Core connection does not prove its downstream Assets are currently reachable.

Direct IP Assets retain their own authentication, signed reports and process-replacement rules. This decision does not defer their report security or replace it with a process identifier alone.

Gateways are relay integrations and are not taskable Assets in the current scope. Future gateway taskability is open. This neither prohibits a future Asset identity for a gateway nor assumes such an integration would require no Core changes.

## Rationale and alternatives

- Trust belongs at the translation boundary that creates Core-facing facts from the constrained radio grammar.
- Requiring originating Core-format signatures on every radio path would constrain device protocols and carry IP-oriented machinery over the edge link.
- Treating a gateway as the downstream Asset would erase separate Task ownership and execution evidence, and conflate gateway restart with Asset restart.
- The gateway can attest facts supported by Asset evidence. It must not manufacture physical outcomes or relabel historical traffic as fresh Contact. Core records trusted reports; it does not independently verify physical execution.

## Consequences

- A compromised or faulty gateway can submit false reports for its bound Assets. Core verifies gateway authority and contract validity; it no longer provides cryptographic proof of independent radio-Asset authorship on this path.
- Enrollment and registration must retain distinct downstream identity bindings without requiring Core credentials or Core-format signing keys at every radio Asset.
- Gateway integrations must preserve evidence correlation across retries and restart, and distinguish actual downstream process replacement from gateway lifetime changes.
- Concrete gateway attestation, delegation and authority-transfer fields, radio encoding and freshness evidence remain engineering work. This decision selects no new wire protocol or gateway implementation.
- Gateway integration evidence must exercise unauthorized and unbound submissions, duplicate and historical reports, gateway restart, downstream replacement and obsolete-process rejection. Emulator evidence establishes only its exercised conditions; physical radio and Asset execution claims retain their separate validation requirements.

The corresponding [testing requirements](../testing-strategy.md#external-systems-and-future-radio-gateways) qualify translation and Core acceptance without reinstating an originating Core-format signature requirement.
