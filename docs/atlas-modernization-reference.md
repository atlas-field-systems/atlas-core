# Atlas Modernization reference

> Planning-session record, pending reconciliation with the architecture merged in PR #1. "Approved" and "agreed" below describe this session; they do not supersede existing ADRs. See [conflicts and document authority](planning-reconciliation.md).

Source snapshot: locally available `origin/main` at `8edee4e2743fbf0f85c16dfe638d9222141cf279` in Atlas Modernization. The remote was not refreshed during this review. Findings below describe the earlier design, not implemented behavior in this repository.

Use the earlier design to answer factual questions before asking the user. The [API plan](api-plan.md) and [approved endpoint map](api-endpoints.md) take precedence. The table below records earlier design sources; any remaining proposals are identified in their current design documents.

## Earlier design sources

| Topic | Earlier design and current direction | Source |
| --- | --- | --- |
| Object references | Historical associations, not ownership. Deleting an Entity preserves the Object and its references; clients handle missing related Entities. | [Object reference decision][object-references] |
| File metadata | Separate file content and storage-derived facts from editable descriptive metadata. Task references are included in the approved endpoint contract. | [Object guide][objects] |
| Concurrent edits | Resource versions and ETags, with `If-Match` to reject stale writes. Whether preconditions are mandatory remains open. | [API guide][api] |
| Pagination | Bounded pages with opaque continuation cursors. Exact response shape and limits remain open. | [Pagination][pagination] |
| Client synchronization | `/queries`, `/feed`, and their documented baseline recovery behavior are accepted in the endpoint map. SDK read policies and exact limits remain open. | [API guide][api] |
| Health | `/health` for process liveness and `/readiness` for dependency readiness are accepted. The older database/storage checks inform the detailed readiness contract, which remains open. | [Health handlers][health] |
| Task lifecycle | Explicit acknowledge, start, progress, complete, fail, and cancel operations, with idempotent creation, are accepted in the endpoint map. The removed execution-session mechanism is not carried forward. | [Task contract][tasking] |
| Cancellation | `cancelled` means Atlas withdrew the Task; it does not prove physical execution stopped. In-progress cancellation depends on advertised Asset support. | [Task contract][tasking] |
| Plugin structure | Versioned declarative release document, container image pinned by digest, and a private manifest/health/operation HTTP contract. Installation, enablement, and runtime availability are separate states. These are candidate defaults, not an adopted package format. | [Plugin design][plugins], [release format][plugin-release] |
| External service credentials | The private Source Gateway supplies credentials for external services, keeping them outside Plugins. This is a reference for future external integrations, not a requirement to provision API keys for installed Plugins. | [Source Gateway][source-gateway] |

## Differences that need care

The new [Asset status model](asset-status.md) replaces the older execution-session API. The earlier operational-status/check-in design is a reference, while its process-identity registration, readiness, shutdown, and session-scoped Task delivery routes are superseded. Status definitions, Task admission, and restart/late-report behavior need explicit rules; the old automatic Task failures on process replacement are not silently carried forward.

The old browser login, password, and session design is not an answer to the new operator-profile requirement. Here, operator records hold names and settings, and API keys grant access to all endpoints. First-key provisioning and browser access mechanics still need a design compatible with that rule.

The approved endpoint map defines the selected routes. Source references here explain their origin and do not add unlisted endpoints.

The older `/command-catalog` API is deliberately omitted. The SDK will return the catalog locally from its installed Protocol package, which Assets and command interfaces already share. This preserves Protocol ownership without a network request. See the API plan for the accepted contract.

The older guide also documents an intentionally empty production Command Catalog. It establishes a command model, not proof that scan area, move to, takeoff, land, or return to launch already have reusable production schemas.

The older plugin design gives installation and container lifecycle to the host-side `atlas-core` CLI and Compose, explicitly withholding host and container-runtime authority from the Core server. The accepted new design keeps host operations in a host manager, while Core owns configuration and desired state through its public `/plugins` API. The remaining work is to define that delegation contract, not to choose who owns plugin management.

The older package format supports query-only Plugins and has no general Plugin settings lifecycle. The new configuration contract requires a declared settings schema, Core validation, separate save and apply actions, and restoration of the last working configuration when applying settings prevents startup; see the API plan for failure reporting and retained pending settings. Installed Plugins do not need individual Atlas API keys. Taskable-plugin lifecycle management is also deferred in the older design, so its package format alone does not satisfy the new execution requirements.

[object-references]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md
[objects]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md
[api]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md
[pagination]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/PAGINATION.md
[health]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_health.go
[tasking]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md
[plugins]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md
[plugin-release]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/RELEASE_FORMAT.md
[source-gateway]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/SOURCE_GATEWAY.md
