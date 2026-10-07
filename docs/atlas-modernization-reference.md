# Atlas Modernization reference

Source snapshot: locally available `origin/main` at `8edee4e2743fbf0f85c16dfe638d9222141cf279` in Atlas Modernization. The remote was not refreshed during this review. Findings below describe the earlier design, not implemented behavior in this repository.

Use the earlier design to answer factual questions before asking the user. Established choices there are candidates for reuse; accepted decisions here take precedence, and conflicts or materially new choices require discussion. Current decisions follow the [documentation authority guide](agents/domain.md); the [topic pages](topics/README.md) and [endpoint map](api-endpoints.md) state the reconciled design. The table below records earlier design sources; any remaining proposals are identified in their current design documents.

## Earlier design sources

| Topic | Earlier design and current direction | Source |
| --- | --- | --- |
| Object references | Historical associations, not ownership. Deleting an Entity preserves the Object and its references; clients handle missing related Entities. | [Object reference decision][object-references] |
| File metadata | Separate file content and storage-derived facts from editable descriptive metadata. Task references are included in the approved endpoint contract. | [Object guide][objects] |
| Concurrent edits | The pinned source uses resource versions and ETags with `If-Match` to reject stale writes. The reference review did not establish mandatory coverage across mutation classes. The successor requires matching protection for operator-managed and other descriptive edits, with stale edits conflicting for caller review; Asset reports use their separate acceptance and ordering rules. | [API guide][api], [successor concurrent-edit contract](architecture/system-design.md#concurrent-descriptive-edits) |
| Pagination | Bounded pages with opaque continuation cursors. Exact response shape and limits remain open. | [Pagination][pagination] |
| Movement history | The older implementation has sparse samples, 30-day retention, imports, raw reads, reduced trails and historical inspection. The successor retains a smaller sample store until Reset and one history read, deferring the other features. | [Implementation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/movement-history-implementation.md), [current contract](topics/history.md#movement-history) |
| Client synchronization | The earlier `/queries` and `/feed` inform the successor's [background synchronization](topics/sdk.md#background-synchronization), which now assigns ordered catch-up/live delivery and consistent snapshot continuation to Core. The current [SDK read modes](topics/sdk.md#modes) remain HTTP and Full synchronization mode under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). | [API guide][api] |
| Health | `/health` for process liveness and `/readiness` for dependency readiness are accepted. The older database/storage checks inform the detailed readiness contract, which remains open. | [Health handlers][health] |
| Task lifecycle | The older API used separate acknowledge, start, progress, complete, fail and cancel routes. The successor consolidates them into the Task status endpoint, retains idempotent creation and adds confirmed paused/cancellation-requested states. The removed execution-session mechanism is not carried forward. | [Task contract][tasking] |
| Queued/immediate scheduling | The pinned source permits immediate Tasks to overlap queued work, but enforces a 60-second deadline and Core delivery gates. Carry forward overlapping immediate Tasks; exclude those gates/deadline. Successor Pause suspends and retains work; the older controlled-stop proposal cancelled earlier queued Tasks. | [Scheduling](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L258), [controlled-stop proposal](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L531) |
| Cancellation | Historically, `cancelled` records withdrawal without proving physical stop. The successor instead records Cancellation requested status and waits for assigned-Asset confirmation; see [cancellation requests](topics/tasks.md#cancellation-requests). | [Task contract][tasking] |
| Plugin structure | Versioned declarative release document, container image pinned by digest, and a private manifest/health/operation HTTP contract. Installation, enablement, and runtime availability are separate states. These are candidate defaults, not an adopted package format. The successor separately defines Plugin-scoped uninstall cleanup. | [Plugin design][plugins], [release format][plugin-release], [successor uninstall rules](topics/plugins.md#uninstall-and-reinstall) |
| External service credentials | The private Source Gateway supplies credentials for external services, keeping them outside Plugins. This is a reference for future external integrations, not a requirement to provision API keys for installed Plugins. | [Source Gateway][source-gateway] |

## Earlier Asset reporting design

Atlas Modernization stored Operational status in `components.status.value` and connection state in `components.communications.link_state`. Its check-in refreshed the heartbeat and could report telemetry and Operational status together. Its [Asset status guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/ASSET_STATUS_SYSTEM.md) defines connection states but accepts an Operational status string rather than a complete operational lifecycle table.

Atlas uses that reporting approach as a reference. The four Communication states replace its connected, disconnected, degraded and unknown vocabulary. Operational status reporting replaces the public execution-session API, including its registration, readiness, shutdown and session-scoped Task polling. Host management still runs Plugin containers.

## Earlier SDK design

The Atlas Modernization snapshot at `8edee4e2743fbf0f85c16dfe638d9222141cf279` uses a live feed, HTTP changed-since recovery and a subscription barrier with a version watermark. Those are historical mechanism facts. The successor now selects [Core-owned ordered catch-up/live delivery](topics/sdk.md#background-synchronization), while retaining the separate changed-since capability and its existing read-source guarantees.

The older `AtlasClient` combined typed HTTP access with an optional sync engine. `sync: "all"` selected the full resource subscription, and `client.sync.start()` started synchronization. Covered point reads used the cache only while sync was running and healthy; otherwise they called Core, and `{ fresh: true }` explicitly bypassed the cache. Neither automatic fallback nor the per-call bypass is carried forward. Local list and query behavior is specified separately rather than inferred from point reads.

The old cache was held in memory per client instance, with no disk persistence. It exposed sync health, degradation, subscriptions and a global last-applied version rather than a per-record expiry time. A configurable changed-since poll defaulted to 120 seconds as a reconciliation backstop and could be disabled with `pollIntervalMs: 0`; that interval is historical behavior, not a selected freshness limit. The old SDK also had a separate bounded in-memory file-content cache, which does not imply that file bytes belong in the picture.

- [Change-feed behavior](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md).
- [Initial-load and recovery pagination](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/PAGINATION.md).
- [SDK](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/README.md).
- [Detailed SDK read and synchronization contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-sdk/README.md).
- [Client options and defaults](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/client.ts).
- [Sync engine and read fallback](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts).

## Differences that need care

The [comparison register](architecture/modernization-differences.md) records each confirmed difference and its successor rule. This section keeps only source evidence the register does not.

- Track publisher continuity, silence, corrections and deferred transfers, and live Geofeature geometry, are successor requirements, not claims about the pinned snapshot: D38, D41 and D42.
- The earlier operational-status and check-in design is a reference for [Asset reporting](topics/asset-reporting.md). Its process-identity registration, readiness, shutdown and session-scoped Task delivery routes are superseded, and its automatic Task failures on process replacement are not carried forward: D29 and the Asset-process authority row.
- The old browser login, password and session design does not answer the Operator profile requirement; profiles hold names and settings. Access follows the Access and source credentials and Full-picture read access rows.
- The approved endpoint map defines the selected routes. Source references here explain their origin and do not add unlisted endpoints.
- The older `/command-catalog` API is deliberately omitted: see the Command Catalog access row and [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). Device runtimes follow the shared Command semantics without being required to run the general SDK.
- The older guide documents an intentionally empty production Command Catalog, as the Validation milestones row notes. It establishes a command model, not proof that scan area, move to, takeoff, land, or return to launch already have reusable production schemas.
- The older Plugin design gives installation and container lifecycle to the host-side `atlas-core` CLI and Compose, explicitly withholding host and container-runtime authority from the Core server. The successor ownership is D24.
- The older package format supports query-only Plugins and has no general Plugin settings lifecycle, so it does not establish the successor's durable Operations (D21 to D23), local configuration (Plugin configuration row) or non-taskable Plugins (D20).

[object-references]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md
[objects]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md
[api]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md
[pagination]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/PAGINATION.md
[health]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_health.go
[tasking]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md
[plugins]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md
[plugin-release]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/RELEASE_FORMAT.md
[source-gateway]: https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/SOURCE_GATEWAY.md
