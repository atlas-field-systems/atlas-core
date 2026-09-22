# API endpoint map

> Planning-session record, pending reconciliation with the architecture merged in PR #1. "Approved" and "agreed" below describe this session; they do not supersede existing ADRs. See [conflicts and document authority](planning-reconciliation.md).

Approved endpoint map as of 2026-09-22, based on [the API plan](api-plan.md) and Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`. The methods, paths, and described behavior are accepted as the design baseline. Items explicitly left open still need detailed contracts. Approval does not mean implementation; no endpoints are implemented in this repository yet.

Use [the glossary](api-glossary.md) for resource meanings. Protocol owns resource and Command schemas; the descriptions below identify inputs and results without freezing every field.

See [the data component catalog](data-components.md) for the proposed component applicability and database inventory that will guide detailed schemas.

## Reading the tables

- **Retain**: method and path exist in the older router and are retained with the described behavior.
- **Adapt**: an older capability has a new path or changed contract.
- **New**: added to satisfy a requirement established in this planning session.

These labels describe provenance; all listed routes are approved. Expected callers describe usage, not permissions. Any valid API key can use every public endpoint. Installed Plugins use Core's managed internal integration and need no individual API keys.

In the effects column, `create`, `update`, and `delete` mean committed resource changes delivered through `/feed` and `/queries/changed-since`. Failed validation produces no resource change. The initial synchronized resource set is Entities, Tasks, and Objects, following the older design. Plugin management, operator profiles, settings, and API keys are read through their own endpoints; their notification behavior remains open.

## Entities

Only `asset`, `track`, and `geofeature` are valid Entity types. An Entity's ID and type are immutable. Houses are Tracks; zones and rally points are Geofeatures. Every Asset requires status, communications, and heartbeat components. A returned Asset includes these components and advertised Command support, which is distinct from the complete catalog available locally through the SDK.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities` | Interfaces and data consumers list Entities | Filters, limit, cursor → Entity page | None | Retain |
| `POST /entities` | Assets register themselves; interfaces and integrations create Tracks/Geofeatures | Identity, type, initial descriptive data/components and optional Asset Command support → Entity | `create` Entity | Adapt: restrict types |
| `GET /entities/{entity_id}` | Any consumer reads one Entity | ID → full Entity, including advertised support for an Asset | None | Retain |
| `GET /entities/alias/{alias}` | Interfaces resolve a known alias | Case-insensitive alias → one Entity | None | Retain |
| `PATCH /entities/{entity_id}` | Assets report their own changes; interfaces/integrations update other Entity types | ID, partial fields/components, version precondition → Entity | `update` Entity; Asset reports refresh Core-recorded contact | Retain; detailed mutable-field schema remains open |
| `DELETE /entities/{entity_id}` | Interfaces remove an Entity | ID → no body | `delete` Entity; retain historical Object associations | Retain |
| `POST /entities/{entity_id}/checkin` | Assets and their transport integrations report current state | ID, partial component data, optional supported-Command declaration → updated Entity | `update` Entity and Core-recorded contact; use shared validation | Adapt: status-based reporting |
| `GET /entities/{entity_id}/tasks` | Assets and interfaces inspect assigned work | Asset ID, outstanding/status filter, pagination → Task page with submission/current queue order and confirmation state | None; listing does not accept or start work | Adapt: replace separate execution-session polling |
| `GET /entities/{entity_id}/objects` | Interfaces find associated files | Entity ID, pagination → Object metadata page | None | Retain |

Deletion rule retained from the older design: reject Asset deletion while it has nonterminal Tasks. Retain completed Task records and historical Object references after an allowed deletion. Aliases are optional, editable, and unique across all Entity types ignoring case. Store an absent alias as null; relationships use immutable Entity IDs. Entity types never change. Every Geofeature must have valid point, line, or polygon geometry at creation; unfinished drawings remain in the interface. Track geometry is optional, and Assets use telemetry for position. Exact Entity filters remain open.

Core validates components against Protocol-defined schemas and applicability. Entities have no unrestricted `extra` metadata map. Plugins will never define or register components. Required components cannot be removed through an update. Partial updates preserve omitted fields, replace supplied scalars, merge nested fields, and replace arrays completely. Explicit null removes an optional component or clears a nullable field. Validate the entire resulting resource and commit atomically.

Assets author their own reported Entity data; command interfaces send Tasks rather than editing Asset state. Core owns derived communications, heartbeat, timestamps, and versions. Every accepted fresh Asset-originated update refreshes Core-recorded contact, including telemetry patches and status reports. Core-derived changes do not refresh contact. This authorship rule does not add API-key roles; the precise relay-origin and report-ordering fields remain open. Fresh reports establish contact; duplicates and historical backlog do not. Delayed updates cannot overwrite newer component values. Continuous, near-real-time telemetry is expected; exact freshness windows remain open.

The SDK provides Asset registration through `POST /entities`, followed by check-in. Initial data can include descriptive fields, components, and Command support. Before the first report, defaults are operational status `unknown`, communications `offline`, and heartbeat `last_seen: null`. See the [SDK operations catalog](sdk-operations.md). No separate registration or telemetry endpoint is needed. Assets retain stable IDs across restarts. Registration retries use the same Asset ID and request identity; reconnects resume the existing record without overwriting it with startup defaults. Exact deduplication retention, response semantics, and report-ordering fields remain open.

### Asset status

The [Asset status model](asset-status.md) replaces the former execution-session API. Status is part of the Asset's Entity record and is synchronized through the ordinary Entity feed. Operational status and connectivity remain separate, and exceptional interruption requires Task reconciliation. Communication states are `high_bandwidth`, `healthy`, `degraded`, and `offline`, with connection type recorded separately. Degraded/offline takes precedence over high bandwidth. Core derives state from Asset/transport observations and link-specific expectations; initial communications is `offline`. Exact criteria remain open. The operational statuses are `unknown`, `initializing`, `ready`, `busy`, `error`, and `stopped`. Assets own sequential Task execution; these reports are not Core scheduling gates.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities/{entity_id}/status` | Interfaces and integrations inspect an Asset's condition | Asset ID → status, report times, and reason/details | None | New |
| `PATCH /entities/{entity_id}/status` | Assets and relays report Asset-originated operational status | Asset ID, status/reason/details, version precondition → updated status | `update` Entity and contact; no Task outcome inferred | New |

Status-specific routes apply to Asset Entities. Status supplied through check-in or any permitted Entity patch uses the same validation and transition rules. Command support is reported on the Entity/check-in contract; it is not bound to a public execution-session registration. Managed taskable Plugins use the same status model without Plugin API keys. Mechanics for stale reports, restart reconciliation, and active Tasks remain open and must be settled before execution is implemented.

## Tasks

Task creation assigns one Protocol-defined Command to one Asset and begins in `pending`. Core assigns a permanent increasing submission sequence within that Asset's queue when accepting it. Assignment, Command, and input are immutable. The lifecycle is `pending`, `acknowledged`, `in_progress`, `completed`, `failed`, or `cancelled`, following the older contract. Terminal Tasks are permanent execution records, so there is no generic Task patch or delete endpoint.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /tasks` | Interfaces inspect work | Filters, pagination → Task page | None | Retain |
| `POST /tasks` | Tasking client requests execution | Asset ID, Command, input, idempotency key → created or previously created Task | `create` Task on first successful request | Retain |
| `GET /tasks/{task_id}` | Interfaces and Assets inspect one execution | Task ID → Task | None | Retain |
| `POST /tasks/{task_id}/acknowledge` | Assigned Asset confirms acceptance into its local queue | Task ID → Task, subject to Task lifecycle validation | `update` Task to acknowledged | Adapt: remove execution-session identity |
| `POST /tasks/{task_id}/start` | Assigned Asset starts execution | Task ID → Task, subject to Task lifecycle validation | `update` Task to in progress | Adapt: remove execution-session identity |
| `POST /tasks/{task_id}/progress` | Assigned Asset reports progress | Task ID, progress → Task | `update` Task | Adapt: stale-report contract open |
| `POST /tasks/{task_id}/complete` | Assigned Asset reports completion | Task ID, Command-defined output when required → Task | `update` Task to completed | Adapt: stale-report contract open |
| `POST /tasks/{task_id}/fail` | Assigned Asset reports failure | Task ID, failure details → Task | `update` Task to failed | Adapt: stale-report contract open |
| `POST /tasks/{task_id}/cancel` | Tasking client requests withdrawal of work | Task ID, cancellation request details → Task | Record request and notify Asset; accepted work retains its execution state until an outcome is confirmed | Adapt: distinguish request from confirmed cancellation |
| `GET /tasks/{task_id}/objects` | Interfaces inspect associated files | Task ID, pagination → Object metadata page | None | Retain |

Retained lifecycle rules: Task creation validates the local Protocol catalog, Command input, and the Asset's advertised support. Core accepts and retains valid Tasks even when the assigned Asset is offline; their assignment order is preserved until the Asset receives them. Existing unfinished Tasks are unchanged by a loss of connectivity. Assets queue assigned Tasks and execute them one at a time, oldest submission first by default, subject to confirmed queue reordering. A busy Asset can receive more Tasks. Communication state does not gate Task creation or change Core scheduling behavior; Core is not the Asset scheduler. Repeating an idempotency key with the same request returns the same Task; different tasking data conflicts. A Command whose lifecycle permits starting without separate acknowledgement still follows queue order; skipping acknowledgement does not authorize skipping earlier Tasks. The first valid terminal transition wins; identical retries are no-ops and conflicting retries fail. A cancellation request does not prove that physical execution stopped. For work already accepted by the Asset, keep its execution state until the Asset confirms cancellation or reports another valid outcome. Cancelling in-progress work depends on declared Asset support. The request alone does not win the terminal-state race. Asset status changes alone do not currently define terminal Task outcomes.

Fresh Asset-originated acknowledgements, starts, progress, and outcomes also update the assigned Asset's Core-recorded contact and publish the corresponding Entity change. Duplicate reports and historical backlog do not refresh contact. Interface-originated Task creation and cancellation do not establish Asset contact. Task lifecycle validation still applies independently of contact freshness.

Core assigns Tasks a permanent increasing submission sequence per Asset in acceptance order. Assigned-work reads return that order by default. Assets fetch the full outstanding list across pages and deduplicate by Task ID. Idempotent retries preserve the original Task and sequence. The Asset reports `acknowledged` when accepting a Task into its local queue and `in_progress` only when execution begins. Exact sequence field encoding remains a schema detail.

Task reordering is agreed for Tasks that have not started, including acknowledged Tasks. Submission sequence stays immutable; current queue order is separate. Running and terminal Tasks cannot be moved. Expose requested order separately from the order confirmed by the Asset. A disconnected Asset can continue its last received order. Exact revision/conflict rules, confirmation messages, and the mutation endpoint remain to be designed; no reorder route has been selected yet.

Cancellation requests and terminal cancellation are separate data. The six Task status values are unchanged. For Asset-accepted work, `cancelled` records a confirmed cancellation rather than merely the interface's request. The confirmation API, handling of never-accepted work, and delivery/acknowledgement races remain to be specified.

## Objects

Objects hold arbitrary file types and flexible JSON metadata. Entity references are zero-to-many. Objects also support Task references. References are historical associations, not ownership links that cascade-delete files.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /objects` | Interfaces and integrations list files | Filters, pagination → Object metadata page | None | Retain |
| `POST /objects` | File producers create descriptive metadata | Object identity, metadata, associations → Object | `create` Object metadata; no file upload | Retain |
| `POST /objects/upload` | File producers upload an Object's first content | Multipart file, Object ID, optional descriptive fields → Object with storage-derived metadata | Store first content; create or populate Object and emit corresponding change; no overwrite | Retain |
| `GET /objects/{object_id}` | Consumers inspect a file record | Object ID → full metadata and associations | None | Retain |
| `PATCH /objects/{object_id}` | Interfaces and integrations edit metadata | Object ID, changed metadata/associations, version precondition → Object | `update` Object metadata | Retain |
| `DELETE /objects/{object_id}` | Interfaces remove an Object | Object ID → no body | `delete` Object; arrange stored-content removal | Retain |
| `GET /objects/{object_id}/download` | Consumers retrieve file content | Object ID → attachment stream | None | Retain |
| `GET /objects/{object_id}/view` | Interfaces preview supported content | Object ID → inline stream, attachment, or unsupported-type error | None | Retain; supported preview formats need review |

Storage facts such as byte size and storage location come from the upload process, not arbitrary metadata edits. The older upload endpoint accepts content separately from references; references are created or patched through metadata endpoints. Keep that as the starting contract. After the first successful upload, file content is immutable. Changed content requires a new Object ID; descriptive metadata remains editable. A retry must recognize an already-successful upload without overwriting it. Exact retry identity/content verification, transfer limits, deletion completion, and preview formats remain open. Arbitrary upload types do not imply arbitrary inline rendering.

## Administration

All routes here use the same public API key rule. Operator profiles do not introduce roles, login permissions, or per-operator access limits.

### Core configuration and diagnostics

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/config` | Administrative clients inspect Core settings | No body → documented public configuration fields | None | New |
| `PATCH /admin/config` | Administrative clients change supported Core settings | Changed fields, version precondition → configuration and apply requirements | Persist accepted settings; restart/apply rules remain open | New |
| `GET /admin/resources` | Administrative clients inspect service resources | No body → host/process diagnostics | None | Adapt from `/resources` |

The editable Core settings and their application rules must be defined before the configuration write route is implemented. The Plugin save/apply policy is not automatically a policy for Core itself. No generic maintenance or restart endpoint is proposed without a specific operation to support.

### API keys

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/auth/api-keys` | Administrative clients list keys | Pagination → key metadata, never key secrets | None | Adapt from `/admin/api-keys` |
| `POST /admin/auth/api-keys` | Administrative clients provision a key | Name/description → key metadata and secret returned once | Create a full-access key | Adapt from `/admin/api-keys` |
| `DELETE /admin/auth/api-keys/{key_id}` | Administrative clients revoke a key | Key ID → no body | Revoke the key | Adapt from `/admin/api-keys/{key_id}` |

Unlike the older implementation, these routes accept any valid API key and require no browser-admin session. Bootstrap: local deployment setup provisions the first key outside HTTP and stores it for the operator; subsequent keys use these routes. Recovery after loss or revocation of every key is also a local setup responsibility. Exact setup commands remain open.

### Operator records

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/operators` | Interfaces select or display Operators | Pagination → Operator page | None | New |
| `POST /admin/operators` | Interfaces create a profile | Name and settings → Operator with stable ID | Create profile | New |
| `GET /admin/operators/{operator_id}` | Interfaces load a profile | Operator ID → Operator and settings | None | New |
| `PATCH /admin/operators/{operator_id}` | Interfaces edit a profile | Changed name/settings, version precondition → Operator | Update profile | New |
| `DELETE /admin/operators/{operator_id}` | Interfaces remove a profile | Operator ID → no body | Delete profile; historical attribution policy remains open | New |

Use explicit Operator IDs rather than a `/me` route: an API key does not currently identify a person. Profile selection and any connection to activity attribution remain open. Deleting a profile does not imply deleting operational Entities, Tasks, or Objects.

## Plugins

The public API owns desired state and configuration. A host manager performs installation and container operations. The paths below extend the older discovery/invocation API to cover the management behavior already agreed.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /plugins` | Interfaces discover installed Plugins and availability | Pagination → Plugin summary page | None | Adapt: include installation and management state |
| `GET /plugins/catalog` | Administrative clients discover installable releases | Filters/pagination → available Plugin releases and compatibility metadata | None | New API for an older CLI capability |
| `GET /plugins/{plugin_id}` | Interfaces inspect and monitor a Plugin | Plugin ID → release, enabled/available state, pending settings and latest management result | None | New |
| `POST /plugins/{plugin_id}/install` | Administrative clients request installation | Selected release → accepted management receipt | Host manager installs selected release | New API for an older CLI capability |
| `POST /plugins/{plugin_id}/enable` | Administrative clients request that a Plugin run | Plugin ID → accepted management receipt | Enable and start through host manager | New API for an older CLI capability |
| `POST /plugins/{plugin_id}/disable` | Administrative clients request that a Plugin stop | Plugin ID → accepted management receipt | Disable and stop through host manager; retain installation | New API for an older CLI capability |
| `POST /plugins/{plugin_id}/update` | Administrative clients request a release change | Selected release → accepted management receipt | Host manager updates Plugin; restart may be required | New API for an older CLI capability |
| `POST /plugins/{plugin_id}/uninstall` | Administrative clients remove an installed Plugin | Plugin ID → accepted management receipt | Host manager removes installation | New API for an older CLI capability |
| `GET /plugins/{plugin_id}/config/schema` | Interfaces discover settings | Plugin ID → declared settings schema, required fields and defaults | None | New |
| `GET /plugins/{plugin_id}/config` | Interfaces inspect settings | Plugin ID → saved settings, active settings, revisions and pending-change state | None | New |
| `PUT /plugins/{plugin_id}/config` | Interfaces save a complete settings document | Schema-valid settings, version precondition → saved settings and pending state | Save desired configuration; do not restart | New |
| `POST /plugins/{plugin_id}/config/apply` | Administrative clients apply saved settings | Saved configuration revision → accepted management receipt | For running Plugin, restart and restore last working configuration on startup failure; for disabled Plugin, prepare settings for next start without enabling | New |
| `POST /plugins/{plugin_id}/operations/{operation_id}` | Interfaces invoke a Plugin's declared bounded read-only capability | Declared operation input → synchronous operation result | No durable Atlas resource changes | Retain |

Management response: return `202 Accepted` with a request ID and a status URL at `GET /plugins/{plugin_id}`. That resource exposes the current request ID, phase, result or failure, and active/saved configuration revisions. Permit one management action at a time per Plugin, rejecting overlapping actions with a conflict. Retain the result after uninstall so the initiating client can observe completion. These management mechanics are part of the approved baseline.

An accepted management request is not completion. Completion comes from host-manager reports. Installation is distinct from enablement and runtime availability. Configuration rollback reports the failed apply while keeping the proposed settings pending. Reject disable, uninstall, update, or configuration-apply actions when they would interrupt unfinished Tasks on an Asset implemented or run by that Plugin. Resolve those Tasks before retrying. Saving configuration without applying it remains allowed. Unrelated Assets' Tasks do not block Plugin management, and this rule does not imply that Plugins assign Tasks. Applying settings to a disabled Plugin validates and retains them for its next start without enabling it. Report that startup has not tested this revision; do not mark it active or replace the last startup-validated configuration merely because validation succeeded.

Plugin management requests and bounded read-only Plugin capabilities are not operational Tasks. A taskable Plugin participates through an Asset and the ordinary Task contract. Durable resource changes use Core's ordinary resource actions through the managed integration. The private Core-to-Plugin and Core-to-manager routes belong in separate internal contracts; this document does not invent public management credentials for them.

## Synchronization

The SDK exposes resource reads, queries, and feed subscriptions through the same methods in all three modes. HTTP mode passes all three through to Core's API. Full-synchronization mode uses local resource/query results and subscriptions to changes applied to the local picture, with no direct pass-through, fallback, or per-call bypass. The endpoints below are called by HTTP-mode operations or privately by the background synchronizer; full-synchronization application query/feed calls resolve locally. Asset hybrid serves its related subset locally and makes one-off API reads outside that scope without expanding its subscription; its feed describes applied local subset changes. HTTP-mode failures do not fall back to cached data. See [SDK data access](sdk-data-access.md) for scope, freshness, recovery, and open read-policy decisions.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /queries/full` | SDK clients load the operational dataset | Full or Asset scope, per-resource pagination → scoped Entities, Tasks, Objects, continuation cursors and a baseline version | None | Retain |
| `GET /queries/changed-since` | SDK clients recover missed changes | Full or Asset scope, baseline version and cursor → scoped ordered change events and next recovery boundary | None | Retain |
| `GET /feed` | SDK clients subscribe to live changes | WebSocket upgrade, API-key authentication, subscription filters → hello and resource events | Maintain connection/subscriptions; no resource writes | Retain |

Asset hybrid requires matching Core-side scope filters across initial queries, recovery, and feed delivery. Its scope includes the Asset's own Entity, outstanding Tasks and subsequent outcomes, cancellation requests, queue-order changes, and directly referenced Entities/Object metadata needed for those Tasks. Filter before transmission; do not download the full dataset and discard unrelated data locally. Out-of-scope reads use ordinary API requests without widening the subscription. Exact scope fields, dependency declarations, scope-entry/removal events, and cursor semantics remain to be specified. See [Asset hybrid](sdk-data-access.md#asset-hybrid-mode).

Recovery contract: finish initial dataset pagination, then recover changes since its baseline before treating the dataset as current. The paginated read is not a frozen database snapshot. Keep the baseline stable across its pages; do not substitute the largest version seen in individual resources. On feed reconnect or a version gap, recover through changed-since. If retained history no longer covers the requested version, return an explicit cursor-expired response and require a new initial load. Retention duration and subscription filters remain reviewable.

Browser WebSockets cannot rely on custom upgrade headers. Use first-message API-key authentication when upgrade headers are unavailable; authenticate before delivering events. No browser-session authentication is assumed. All application requests remain authenticated; CORS preflight is transport negotiation and needs separate handling.

## Health and documentation

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /health` | Monitors check that Core is serving | API key → liveness status | None | Adapt: now authenticated |
| `GET /readiness` | Monitors check required dependencies | API key → readiness status and dependency checks | None | Adapt: now authenticated |
| `GET /docs` | Developers browse interactive documentation | API key → documentation interface | None | New |
| `GET /openapi.json` | SDK/tooling and docs read the HTTP contract | API key → OpenAPI document | None | New |

Core readiness depends on required infrastructure, including its database and configured object store. An unavailable Plugin is reported on that Plugin and does not make an otherwise functioning Core globally unready. Exact dependency probes and timeout thresholds remain to be specified. Browser access to protected documentation needs a concrete key-entry/bootstrap mechanism without making documentation anonymously accessible by accident.

## Shared contract baseline

| Concern | Accepted starting rule | Still to settle |
| --- | --- | --- |
| API key transport | Carry forward `Authorization: Bearer` and `X-API-Key` for public HTTP calls | Choose whether both are needed; browser docs entry flow |
| Lists | Bounded cursor pagination, following older list contracts | Filters, limits, and headers versus body pagination metadata |
| Errors | Stable error code and human-readable message with appropriate HTTP status | One consistent error envelope for handlers and authentication |
| Concurrent changes | Resource versions and ETags; use `If-Match` to reject stale writes | Which writes require rather than merely accept it |
| Retryable mutations | Stable Asset/request identities for registration retries, Task creation idempotency, and request deduplication for Plugin management | Identity formats, retention, and exact response behavior |
| Protocol compatibility | Require matching Protocol schema revisions for Core, Assets, and SDK clients before operational exchange; explicit mismatch errors; package versions may differ | Revision advertisement and checking fields; catalog lookup remains local |
| Change events | Committed Entity, Task, and Object writes publish versioned changes; identical no-op retries do not create another execution | Administrative/Plugin notifications and retention limits |

## Remaining contract details

1. Define exact request/response schemas, filters, limits, and status codes for the approved routes.
2. Resolve the specific open choices in the shared contract table, including mandatory write preconditions and how matching Protocol revisions are advertised.
3. Define Task reorder/confirmation APIs, cancellation confirmation and delivery races, report validation, and reconciliation mechanics without reintroducing the removed execution-session API.
4. Define the private host-manager contract and management outcomes, including first-apply and rollback failures.

## Sources

Route existence was checked against the router, not inferred only from prose. This is a local source review, not a claim that the older service was run or that its current remote state was fetched.

- [Registered routes](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go).
- [API guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md).
- [Earlier Task contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md); its execution-session design is superseded here by [Asset status](asset-status.md).
- [Object contracts](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md).
- [Historical Object references](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md).
- [Plugin design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md).
- [Plugin management](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md).
