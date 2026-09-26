# API plan

This document records the API planning decisions. The endpoint map was approved on 2026-09-22. The routes describe intended organization and accepted methods, not implemented endpoints. Detailed schemas and explicitly unresolved behavior remain to be designed.

See [the domain glossary](../CONTEXT.md) for the meanings of the resources in this plan.

The [data component catalog](data-components.md) inventories resource components and their proposed applicability and storage mappings. Required Asset status, communications, and heartbeat, plus required Task status, are agreed. Required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and typed storage with validated JSON for variable payloads are also agreed. Detailed physical mappings and other component restrictions remain proposals.

The [approved API endpoint map](api-endpoints.md) records methods, paths, inputs, results, and effects under these families, along with the remaining detailed contract questions.

## Access

Public consumers authenticate and have broad operational read access. There are no operator roles. Core enforces Asset ownership of reported state and assigned Task execution, including generic mutation paths; an arbitrary valid key cannot impersonate an Asset. Asset identity is provisioned automatically during enrollment. Exact enrollment and relay-proof mechanisms remain open. Administrative credentials remain distinct from Asset reporting identity; see [identity and access](architecture/system-design.md#identity-and-access).

Managed Plugins use Core-provided integration identity without individual API-key provisioning or rotation by the operator. They can use SDK operational APIs, but cannot impersonate Assets or administer the installation. Health and documentation remain authenticated.

Operator records represent people and associated data. They do not introduce an authorization model.

## Initial endpoint families

These are the starting families. More can be added as requirements emerge. Their operations are listed in the approved endpoint map.

| Family | Intended scope |
| --- | --- |
| `/entities` | Entity creation, queries, updates, and deletion |
| `/tasks` | Operational instructions and their lifecycle |
| `/objects` | File content, metadata, and references to related entities |
| `/admin` | Core configuration, maintenance, and diagnostics |
| `/admin/auth` | API key management, including creation, listing, and revocation |
| `/admin/activity` | Read-only structured history of selected operational actions |
| `/admin/operators` | Operator identity information and personal settings |
| `/plugins` | Plugin discovery/status and durable Operation submission, outcomes and cancellation |
| `/feed` | Live resource changes |
| `/queries` | Initial state synchronization and recovery of missed changes |

`/admin/auth`, `/admin/activity` and `/admin/operators` are subfamilies of `/admin`, documented separately because they have distinct responsibilities.

## Agreed resource responsibilities

Entities have exactly three types: Asset, Track, and Geofeature. Plugins do not introduce additional Entity types. They will never define or register components; every supported component requires a Protocol-defined schema. Entities have no unrestricted `extra` map; additional Entity data requires named Protocol fields. Tracks cover stationary and moving observed subjects, including houses. Geofeatures represent defined zones, rally points, and similar spatial designations. Their point, line, or polygon geometry is required at creation. Track geometry is optional; Assets use telemetry for position. Entity IDs and types are immutable. Aliases are optional and editable, unique across all Entity types ignoring case; an absent alias is null and relationships use IDs.

Every Asset requires status, communications, and heartbeat components. The [Asset status model](asset-status.md) replaces the earlier execution-session API and reports Asset condition. The agreed operational values are `unknown`, `initializing`, `ready`, `busy`, `paused`, `error`, and `stopped`; initial status defaults to `unknown`. Assets own execution and these reports are not Core scheduling gates. Detailed transition/report validation remains open. Asset status is part of the Entity record and participates in feed/query synchronization.

Operational status and connectivity are separate. Communication states are `high_bandwidth`, `healthy`, `degraded`, and `offline`, with connection type recorded separately. Degraded/offline takes precedence over high bandwidth. Core derives state from Asset/transport observations and configured link expectations. Initial communications is `offline` and heartbeat has `last_seen: null`; exact capacity/quality criteria remain open. Planned Asset shutdowns occur after unfinished work is resolved. Exceptional interruptions require reconciliation before deciding Task outcomes; a restart or lost connection does not automatically fail unfinished Tasks.

Assets register themselves through an SDK operation using `POST /entities`, then check in. Initial registration carries descriptive data, components, and capabilities. The [SDK operations catalog](sdk-operations.md) maps these workflows to existing routes; it is distinct from the Protocol Command Catalog. No separate registration or telemetry endpoint is added. Each Asset retains its ID across restarts. Registration retries reuse the same Asset and request identities; reconnecting resumes current state without reapplying defaults. The SDK operations catalog documents typed methods; machine-readable operation discovery is not planned without a concrete consumer.

Assets author their own reported Entity data. Interfaces send Tasks rather than directly editing Assets. Every accepted fresh Asset-originated update refreshes Core-recorded contact; Core-derived changes do not. Partial component updates preserve omitted fields, merge nested fields, replace scalars and arrays, and use explicit null only to remove optional components or clear nullable fields. Core validates the resulting resource atomically. Fresh Asset-originated Task lifecycle reports also establish contact; interface Task creation/cancellation does not. Duplicate reports and historical backlog do not refresh contact, and delayed reports cannot overwrite newer values. Continuous, near-real-time telemetry is the expected operating model; exact ordering fields, freshness windows, and relay-origin details remain open.

Tasks are operational instructions, such as scan area, move to, takeoff, land, and return to launch. They are not a general-purpose abstraction for software jobs.

Each Task records one execution of one Command assigned to one Asset. The assigned Asset never changes. Core accepts and retains valid Tasks even when the assigned Asset is offline; existing unfinished Tasks survive disconnection without an inferred outcome. Assets fetch their full outstanding Task list and execute queued work locally one at a time, oldest submission first by default, following confirmed queue reordering. Multiple move-to Tasks can form a path. Core assigns a permanent increasing submission sequence per Asset at Task acceptance; retries retain it and default reads follow it. Assets acknowledge Tasks when accepting them into their local queue and report in progress when execution starts. Core validates lifecycle reports; it does not reject additional work because an Asset is busy or gate Task creation on communication state. The Asset controls execution when it receives the Tasks. Tasking three Assets creates three Tasks; grouping Tasks remains a separate design question. Eligible, unstarted queued Tasks, including acknowledged Tasks, can be reordered. Submission sequence remains immutable; requested queue order is distinct from Asset-confirmed order. Started, paused, cancellation-requested and terminal Tasks cannot move, and disconnected Assets can continue their last received order. Whole-list reorder requests use expected revisions; assigned Assets confirm adoption or report conflicts, following the [queue contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions). Cancellation sets nonterminal `cancellation_requested`; only the assigned Asset confirms `cancelled`. Late progress cannot clear the request, and completion/failure can still win before cancellation is confirmed. A scan completes only after both the assigned Asset's completion report and its required ready Objects are available, following [ADR-0008](adr/0008-complete-scan-tasks-when-required-results-are-available.md).

Task creation selects supported queued/immediate scheduling. Immediate actions remain tracked Tasks and can overlap queued movement without changing its path. Pause is an immediate Command that interrupts current queued work, puts the Asset into its own paused idle/holding behavior and suspends the current Task. An immediate Resume Command continues the interrupted Task before the remaining queue; a Task that cannot safely resume reports failure. [Scheduling and Pause](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling).

Atlas Protocol owns the Command Catalog and its schemas. Assets declare which Commands they support and cannot invent new Commands outside that catalog.

The SDK exposes a local function that returns the Command Catalog from the installed Protocol package. Assets and command interfaces already include Protocol, so catalog access requires no Core request or network connection. There is no `/command-catalog` endpoint in this design. The SDK function's name and signature remain to be designed. An Asset's advertised support is separate from the catalog of all defined Commands. Core, Assets and SDK clients may use different supported compatible versions. Core advertises supported compatibility ranges and explicitly rejects unsupported clients; exact negotiation fields remain open. Task creation also validates the Asset's advertised Command support. See [ADR-0005](adr/0005-allow-compatible-client-versions.md).

Objects hold file content of arbitrary types together with metadata. Only ready Objects are visible to consumers or synchronization. Upload identity, staged metadata and progress remain separate from public Objects; see [ADR-0009](adr/0009-expose-objects-only-when-ready.md). A photograph's file content lives in Objects, and its JSON metadata can reference zero or more related Entities. The metadata allows additional file-specific information. The first successful upload fixes the Object's file content; different content requires a new Object ID, while descriptive metadata remains editable. Upload retries must recognize prior success without overwriting it. Exact field names, schemas, and retry verification remain to be designed.

Failed Object uploads restart from the beginning; successful-request retries return the existing Object or an explicit deleted-result error after an allowed deletion. Resumable transfers are deferred. Temporary staging is cleaned up rather than retained as an inspectable transfer store. See [ADR-0009](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries).

Declared required result Objects are protected from declaration acceptance until Reset, including while the Task is unfinished or the upload is pending. Core derives protection from immutable Task result references, independently of editable Object associations. Completed Task records themselves have no delete operation, even if interfaces hide past work. [Result retention](adr/0009-expose-objects-only-when-ready.md#required-result-protection).

Movement history uses a small Core sample store for explicitly reported position, speed and altitude, separate from current telemetry. Retain until Reset and expose one paginated historical read. Backfill, sample editing, reduced trails and historical-state reconstruction are deferred. A minimal activity log records Task issuance/cancellation and Plugin, credential and configuration changes, including local actions, with authenticated attribution and no secrets. See [movement](architecture/system-design.md#movement-history) and [activity](architecture/system-design.md#activity-history).

Operator records contain information such as a name and personal settings. Exact fields remain open.

Core owns Plugin lifecycle policy. Installation, configuration, enablement and process administration are local CLI/TUI actions through private management interfaces, with no public management routes or SDK methods. Docker deployment is selected; the private integration details remain open. See [local administration](architecture/system-design.md#local-administration).

Plugins expose durable Operations, not Asset Tasks. Accepted Operations have stable attempt identities and queryable progress/outcomes, survive caller disconnection, and can create Objects or other operational data. Retries retrieve the existing attempt; reruns are explicit. Plugins may issue Tasks to real Assets through existing Commands without becoming Assets themselves. See [ADR-0002](adr/0002-core-manages-installed-plugins.md).

Plugin configuration requires a declared schema with required fields and defaults. Core validates settings; saving desired settings is separate from applying them. Applying to a running Plugin follows the active-Operation stopping procedure before restart. Applying to a disabled Plugin prepares settings for its next start without enabling it or claiming startup validation. Unrelated Asset Tasks do not block Plugin management. The authoritative configuration and recovery policy lives in [ADR-0006](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md).

### Definition sources

Atlas Modernization is the reference for earlier design work. Consult its documentation and matching source before asking questions it already answers. Established choices there are candidates for reuse; explicitly accepted decisions here take precedence, and conflicts or materially new choices require discussion.

See [the reference review](atlas-modernization-reference.md) for earlier answers, proposed defaults, and differences that affect this plan.

Definitions were checked against Atlas Modernization's locally available `origin/main` at commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`:

- [Entity terminology](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/CONTEXT.md#L5-L25).
- [Command and Task terminology](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L7-L25).

This design retains the one-Command, one-Asset Task rule and Protocol-owned Command Catalog. It deliberately changes the older moving-only Track definition and building-footprint Geofeature example: a house is a Track, while a zone or rally point is a Geofeature. The three-type Entity restriction is an explicit decision for this repository; Atlas Modernization's schema does not enforce that restriction.

## Health and documentation

| Endpoint | Intended purpose |
| --- | --- |
| `/health` | Process liveness |
| `/readiness` | Dependency readiness, separate from process liveness |
| `/docs` | Interactive API documentation |
| `/openapi.json` | Machine-readable OpenAPI specification for documentation and developer tools |

Core readiness depends on required infrastructure, including SQLite and the private Object file storage. Individual Plugin failures are reported on the affected Plugin and do not make an otherwise functioning Core globally unready. Exact dependency probes remain open.

OpenAPI describes the API contract. A documentation tool renders it at `/docs`; Swagger UI is a candidate. These route names are project choices, not routes automatically provided by OpenAPI.

As contracts are designed, capture them in OpenAPI. Documentation must distinguish proposed operations from implemented ones.

## Endpoint map format

For each endpoint, record:

- HTTP method and path.
- Purpose and expected callers.
- Inputs and results.
- State changes and emitted events.
- Design status and unresolved questions.

Expected callers explain usage. Enforced report ownership and administrative boundaries follow [identity and access](architecture/system-design.md#identity-and-access).

Map subscriptions and asynchronous completion alongside requests so clients can determine when an operation finishes and how to receive updates.

## SDK read modes

The SDK exposes the same resource-read, query, and feed-subscription methods in three agreed modes:

- HTTP passes reads, queries, and feed subscriptions through to Core's API.
- Full synchronization serves reads and queries only from the local picture and retained history; feed subscriptions emit applied local changes. It has no API fallback or per-call bypass.
- Asset hybrid synchronizes the Asset's own Entity, outstanding Tasks and subsequent outcomes, cancellation requests, queue-order changes, and directly referenced Entities/Object metadata needed for those Tasks. In-scope reads use the local picture; out-of-scope reads make one-off API requests without widening the subscription. Its local feed describes only applied subset changes.

Core filters hybrid initial queries, recovery, and feed delivery before transmission. File bytes remain explicit downloads. Background synchronization maintains the picture independently of application reads. All writes go to Core in every mode. HTTP failures and in-scope local misses do not trigger cross-source fallback.

Pictures are held in memory without persistence and rebuilt on SDK restart. Full synchronization contains the entire operational dataset; hybrid contains its defined subset. Before local readiness, reads return not-ready. During an interruption, they retain the last known picture and expose its stale/disconnected state. Local change history is bounded and configurable, with explicit cursor expiry and cursors scoped to one instance, picture generation, and coverage. Writes return Core's confirmed result after response and Dataset validation without waiting for the local picture, following [ADR-0018](adr/0018-confirm-writes-when-core-commits.md). Only snapshot loading, feed delivery and replay recovery update the picture; write responses do not. Picture application and local notifications remain ordered and deduplicated. Resource limits must never silently truncate a supposedly complete picture.

Hybrid scope limits transmission, not read permissions. All modes enforce the [dataset Reset boundary](sdk-data-access.md#dataset-reset-boundary). Exact hybrid dependency fields, terminal-Task retention, scope-entry/removal events, and query/cursor metadata remain to be specified. See [SDK data access](sdk-data-access.md) for the agreed modes and remaining engineering details. No additional endpoint family is needed for these modes. Explicit movement/activity history methods use their APIs in every mode, outside the synchronized picture; see [historical reads](sdk-data-access.md#historical-reads).

## Further planning

Start with workflows and resource ownership, then map them to endpoints. Establish coverage across the families before detailing every schema.

The following decisions remain open:

- Entity relationships and lifecycle behavior.
- Communication-state criteria, detailed report validation, and delayed-report/freshness mechanisms.
- Exact Task/queue field encodings, report ordering and failure behavior during sequential Asset execution; Pause/Resume report correlation, deadline/clock fields and execution-recovery proof remain implementation details under the accepted policy.
- Detailed Asset-supported Command reporting, stale-report handling, and restart reconciliation under the accepted Task lifecycle.
- Local SDK Command Catalog function name/signature and SDK operation names, including the detailed registration deduplication contract for stable Asset and request identities.
- Exact Object metadata schema and reference representation; historical associations are retained when a related Entity is removed.
- Fields and lifecycle of operator records.
- Plugin manifest/distribution and private Docker coordination details; Docker deployment and local administration are selected.
- Plugin configuration schema format, startup success criteria, and detailed reporting of saved, active, failed and last working settings. Recovery after failed startup is explicitly manual under ADR-0006.
- API key transport details, local first-key provisioning commands, and how browser documentation authenticates.
- Health check criteria and response format.
- Shared conventions for errors, pagination, concurrent edits, retries, and subscriptions.
- Detailed methods, paths, request and response schemas, and asynchronous behavior.
- Documentation renderer selection.
