# API planning reconciliation

The API planning session approved the endpoint map and developed the component, Asset status and SDK contracts. While that work was in progress, [PR #1](https://github.com/atlas-field-systems/atlas-core/pull/1) merged a separate architecture plan at `7d075a2`. This change preserves both records for review rather than silently choosing between conflicting decisions.

The [documentation guide](agents/domain.md) still defines document authority. Existing ADRs and architecture documents remain intact. The new planning documents record this session's approvals, not an implicit supersession of those ADRs. Their [planning glossary](api-glossary.md) is separate from the canonical [domain glossary](../CONTEXT.md) for the same reason. No implementation or generated contract is introduced.

## Decisions that need reconciliation

| Topic | API planning session | Merged architecture |
| --- | --- | --- |
| Access and administration | Any API key can use every public endpoint, including administration; managed Plugins need no individual API keys | [System design](architecture/system-design.md#identity-and-access) requires authenticated Asset identity and reporting restrictions; Plugin administration is local CLI/TUI only |
| Plugin management routes | Public installation, configuration and lifecycle endpoints, with asynchronous management results | [Local administration](architecture/system-design.md#local-administration) excludes those endpoints and SDK methods |
| Taskable Plugins | Component associations and lifecycle guards can refer to a Plugin-hosted Asset | [ADR-0004](adr/0004-core-owns-commands-and-assets-execute-tasks.md) excludes taskable Plugins; Plugins expose Operations |
| Plugin Operations | Initial operation invocation is bounded and read-only | [ADR-0002](adr/0002-core-manages-installed-plugins.md) supports durable Operations, cancellation, effects and outcomes beyond a request |
| Task cancellation | Six execution statuses with a separate cancellation request | [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) includes Cancellation requested as a seventh status |
| Task scheduling | Default sequential execution and Core-visible requested/confirmed reordering | [System design](architecture/system-design.md#core-tasking-and-asset-execution) places scheduling and queue order with the Asset OS; the proposed Core guarantees need review against that boundary |
| Object visibility | Metadata may exist before the first content upload | [ADR-0009](adr/0009-expose-objects-only-when-ready.md) hides Objects until ready, keeping partial transfers private |
| Protocol compatibility | Matching Protocol schema revisions are required | [ADR-0005](adr/0005-allow-compatible-client-versions.md) allows supported compatibility ranges; the revision restriction needs reconciliation |
| Storage and generation | Proposed mappings mention JSONB and Protocol-generated database artifacts | [ADR-0016](adr/0016-use-go-sqlite-and-openapi-tooling.md) selects SQLite, private SQL schemas and sqlc, with OpenAPI owning the public contract rather than database schemas |
| Resource vocabulary | Tracks can be stationary, Geofeatures are defined designations with geometry, and Objects center on files | The [canonical glossary](../CONTEXT.md) describes moving Tracks and broader Objects/Geofeatures; these definitions need one agreed home |

## Integration work still needed

- Apply the [dataset Reset boundary](adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary) to all three proposed SDK modes, retries, writes and cursors. Per-picture generations alone do not satisfy the dataset contract.
- Cross-check Task reporting and Object routes against the [scan completion conditions](adr/0008-complete-scan-tasks-when-required-results-are-available.md). An Asset completion report alone may not complete a scan Task.
- Reconcile Plugin apply/rollback proposals with the accepted [active-work and fault handling](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md).
- Confirm whether hybrid feed filtering is only a bandwidth choice, as intended here, while preserving the architecture's full-picture read access for every authenticated client.

Resolve these items explicitly before treating the endpoint map as the implementation contract. Preserve the session record, update authoritative documents together when a decision changes, and record confirmed source differences in the [Modernization comparison](architecture/modernization-differences.md). Exact schemas, route bindings and implementation details remain open in the linked plans.
