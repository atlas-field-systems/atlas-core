# API plan

> Planning-session record, pending reconciliation with the architecture merged in PR #1. "Approved" and "agreed" below describe this session; they do not supersede existing ADRs. See [conflicts and document authority](planning-reconciliation.md).

This document records the API planning decisions. The endpoint map was approved on 2026-09-22. The routes describe intended organization and accepted methods, not implemented endpoints. Detailed schemas and explicitly unresolved behavior remain to be designed.

See [the domain glossary](api-glossary.md) for the meanings of the resources in this plan.

The [data component catalog](data-components.md) inventories resource components and their proposed applicability and storage mappings. Required Asset status, communications, and heartbeat, plus required Task status, are agreed. Required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and typed storage with validated JSON for variable payloads are also agreed. Detailed physical mappings and other component restrictions remain proposals.

The [approved API endpoint map](api-endpoints.md) records methods, paths, inputs, results, and effects under these families, along with the remaining detailed contract questions.

## Access

A valid API key grants access to every public API endpoint. There are no roles or endpoint-specific permissions, including for administrative endpoints. This rule also covers health checks and documentation.

Installed Plugins do not require individual Atlas API keys. Core integrates them through its managed internal contract, without per-Plugin key provisioning, rotation, or configuration. The public API key rule remains the client access model.

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
| `/admin/operators` | Operator identity information and personal settings |
| `/plugins` | Core-managed plugin installation, execution, configuration, and lifecycle |
| `/feed` | Live resource changes |
| `/queries` | Initial state synchronization and recovery of missed changes |

`/admin/auth` and `/admin/operators` are subfamilies of `/admin`, documented separately because they have distinct responsibilities.

## Agreed resource responsibilities

Entities have exactly three types: Asset, Track, and Geofeature. Plugins do not introduce additional Entity types. They will never define or register components; every supported component requires a Protocol-defined schema. Entities have no unrestricted `extra` map; additional Entity data requires named Protocol fields. Tracks cover stationary and moving observed subjects, including houses. Geofeatures represent defined zones, rally points, and similar spatial designations. Their point, line, or polygon geometry is required at creation. Track geometry is optional; Assets use telemetry for position. Entity IDs and types are immutable. Aliases are optional and editable, unique across all Entity types ignoring case; an absent alias is null and relationships use IDs.

Every Asset requires status, communications, and heartbeat components. The [Asset status model](asset-status.md) replaces the earlier execution-session API and reports Asset condition. The agreed operational values are `unknown`, `initializing`, `ready`, `busy`, `error`, and `stopped`; initial status defaults to `unknown`. Assets own execution and these reports are not Core scheduling gates. Detailed transition/report validation remains open. Asset status is part of the Entity record and participates in feed/query synchronization.

Operational status and connectivity are separate. Communication states are `high_bandwidth`, `healthy`, `degraded`, and `offline`, with connection type recorded separately. Degraded/offline takes precedence over high bandwidth. Core derives state from Asset/transport observations and configured link expectations. Initial communications is `offline` and heartbeat has `last_seen: null`; exact capacity/quality criteria remain open. Planned Asset shutdowns occur after unfinished work is resolved. Exceptional interruptions require reconciliation before deciding Task outcomes; a restart or lost connection does not automatically fail unfinished Tasks.

Assets register themselves through an SDK operation using `POST /entities`, then check in. Initial registration carries descriptive data, components, and capabilities. The [SDK operations catalog](sdk-operations.md) maps these workflows to existing routes; it is distinct from the Protocol Command Catalog. No separate registration or telemetry endpoint is added. Each Asset retains its ID across restarts. Registration retries reuse the same Asset and request identities; reconnecting resumes current state without reapplying defaults. The SDK operations catalog documents typed methods; machine-readable operation discovery is not planned without a concrete consumer.

Assets author their own reported Entity data. Interfaces send Tasks rather than directly editing Assets. Every accepted fresh Asset-originated update refreshes Core-recorded contact; Core-derived changes do not. Partial component updates preserve omitted fields, merge nested fields, replace scalars and arrays, and use explicit null only to remove optional components or clear nullable fields. Core validates the resulting resource atomically. Fresh Asset-originated Task lifecycle reports also establish contact; interface Task creation/cancellation does not. Duplicate reports and historical backlog do not refresh contact, and delayed reports cannot overwrite newer values. Continuous, near-real-time telemetry is the expected operating model; exact ordering fields, freshness windows, and relay-origin details remain open.

Tasks are operational instructions, such as scan area, move to, takeoff, land, and return to launch. They are not a general-purpose abstraction for software jobs.

Each Task records one execution of one Command assigned to one Asset. The assigned Asset never changes. Core accepts and retains valid Tasks even when the assigned Asset is offline; existing unfinished Tasks survive disconnection without an inferred outcome. Assets fetch their full outstanding Task list and execute locally one at a time, oldest submission first by default, following confirmed queue reordering. Multiple move-to Tasks can form a path. Core assigns a permanent increasing submission sequence per Asset at Task acceptance; retries retain it and default reads follow it. Assets acknowledge Tasks when accepting them into their local queue and report in progress when execution starts. Core validates lifecycle reports; it does not reject additional work because an Asset is busy or gate Task creation on communication state. The Asset controls execution when it receives the Tasks. Tasking three Assets creates three Tasks; grouping Tasks remains a separate design question. Unstarted Tasks, including acknowledged Tasks, can be reordered. Submission sequence remains immutable; requested queue order is distinct from Asset-confirmed order. Running and terminal Tasks cannot move, and disconnected Assets can continue their last received order. Exact reorder/confirmation APIs and race handling remain open. Cancellation requests are separate from terminal outcomes; accepted work retains its execution state until the Asset confirms cancellation or reports another outcome.

Atlas Protocol owns the Command Catalog and its schemas. Assets declare which Commands they support and cannot invent new Commands outside that catalog.

The SDK exposes a local function that returns the Command Catalog from the installed Protocol package. Assets and command interfaces already include Protocol, so catalog access requires no Core request or network connection. There is no `/command-catalog` endpoint in this design. The SDK function's name and signature remain to be designed. An Asset's advertised support is separate from the catalog of all defined Commands. Core, Assets, and SDK clients must have matching Protocol schema revisions before operational exchange; mismatches fail explicitly. Package versions may differ when their Protocol revision matches.

Objects hold file content of arbitrary types together with metadata. A photograph's file content lives in Objects, and its JSON metadata can reference zero or more related Entities. The metadata allows additional file-specific information. The first successful upload fixes the Object's file content; different content requires a new Object ID, while descriptive metadata remains editable. Upload retries must recognize prior success without overwriting it. Exact field names, schemas, and retry verification remain to be designed.

Operator records contain information such as a name and personal settings. Exact fields remain open.

Core owns plugin installation, execution, and configuration. Plugins therefore require a defined structure and lifecycle contract. Packaging, runtime, and lifecycle behavior remain to be designed.

Core owns plugin configuration and desired state. A host manager performs installation and container operations on Core's behalf. Clients manage plugins through `/plugins`; the Core server does not directly control the container runtime. The Core-to-manager contract remains to be designed.

Every Plugin declares a configuration schema describing its settings, including required fields and defaults. Core validates configuration against that schema before accepting it. Plugins can define different settings while sharing the same configuration API contract. The schema format remains open; individual Plugin API keys are not part of this contract.

Saving configuration and applying it are separate actions. Saving valid settings records desired configuration and reports pending changes without restarting a running Plugin. Applying the saved configuration restarts the affected running Plugin through the host manager. Reject a disable, uninstall, update, or apply action if it would interrupt unfinished Tasks on an Asset implemented or run by that Plugin; resolve those Tasks first. Saving settings remains allowed. Applying settings to a disabled Plugin validates and retains them for its next start without enabling it; report that startup has not yet tested that revision. Unrelated Assets' Tasks do not block Plugin management, and Plugins are not assumed to assign Tasks.

If applying settings prevents the Plugin from starting, the host manager restores its last working configuration and restarts it with that configuration. Core reports the failed apply and retains the proposed settings for correction. The active configuration and pending settings remain distinguishable. Startup success criteria, first-apply failures without a previous working configuration, and rollback failures remain to be designed.

Core owns the public API for plugin functionality. Plugins communicate with Core through a defined internal contract rather than exposing independent public endpoints. API key access and public documentation stay consistent through Core.

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

Core readiness depends on required infrastructure, including the database and configured object store. Individual Plugin failures are reported on the affected Plugin and do not make an otherwise functioning Core globally unready. Exact dependency probes remain open.

OpenAPI describes the API contract. A documentation tool renders it at `/docs`; Swagger UI is a candidate. These route names are project choices, not routes automatically provided by OpenAPI.

As contracts are designed, capture them in OpenAPI. Documentation must distinguish proposed operations from implemented ones.

## Endpoint map format

For each endpoint, record:

- HTTP method and path.
- Purpose and expected callers.
- Inputs and results.
- State changes and emitted events.
- Design status and unresolved questions.

Expected callers explain how an endpoint is used, not who is allowed to use it. Access follows the shared API key rule.

Map subscriptions and asynchronous completion alongside requests so clients can determine when an operation finishes and how to receive updates.

## SDK read modes

The SDK exposes the same resource-read, query, and feed-subscription methods in three agreed modes:

- HTTP passes reads, queries, and feed subscriptions through to Core's API.
- Full synchronization serves reads and queries only from the local picture and retained history; feed subscriptions emit applied local changes. It has no API fallback or per-call bypass.
- Asset hybrid synchronizes the Asset's own Entity, outstanding Tasks and subsequent outcomes, cancellation requests, queue-order changes, and directly referenced Entities/Object metadata needed for those Tasks. In-scope reads use the local picture; out-of-scope reads make one-off API requests without widening the subscription. Its local feed describes only applied subset changes.

Core filters hybrid initial queries, recovery, and feed delivery before transmission. File bytes remain explicit downloads. Background synchronization maintains the picture independently of application reads. All writes go to Core in every mode. HTTP failures and in-scope local misses do not trigger cross-source fallback.

Pictures are held in memory without persistence and rebuilt on SDK restart. Full synchronization contains the entire operational dataset; hybrid contains its defined subset. Before local readiness, reads return not-ready. During an interruption, they retain the last known picture and expose its stale/disconnected state. Local change history is bounded and configurable, with explicit cursor expiry and cursors scoped to one instance, picture generation, and coverage. Successful in-scope writes reconcile authoritative results locally before returning and notify once; matching feed events are deduplicated. Resource limits must never silently truncate a supposedly complete picture.

Exact hybrid dependency fields, terminal-Task retention, scope-entry/removal events, and query/cursor metadata remain to be specified. See [SDK data access](sdk-data-access.md) for the agreed modes and remaining engineering details. No additional endpoint family is needed for these modes.

## Further planning

Start with workflows and resource ownership, then map them to endpoints. Establish coverage across the families before detailing every schema.

The following decisions remain open:

- Entity relationships and lifecycle behavior.
- Communication-state criteria, detailed report validation, and delayed-report/freshness mechanisms.
- Exact Task sequence encoding, reorder/conflict/confirmation APIs, cancellation confirmation and delivery races, and failure behavior during sequential Asset execution.
- Task lifecycle, Asset-supported Command reporting, stale-report handling, and restart reconciliation.
- Local SDK Command Catalog function name/signature and SDK operation names, including the detailed registration deduplication contract for stable Asset and request identities.
- Exact Object metadata schema and reference representation; historical associations are retained when a related Entity is removed.
- Fields and lifecycle of operator records.
- Plugin structure, packaging, lifecycle, and the Core-to-host-manager contract.
- Plugin configuration schema format, startup success criteria, first-apply and rollback failure handling, and reporting active versus pending settings.
- API key transport details, local first-key provisioning commands, and how browser documentation authenticates.
- Health check criteria and response format.
- Shared conventions for errors, pagination, concurrent edits, retries, and subscriptions.
- Detailed methods, paths, request and response schemas, and asynchronous behavior.
- Documentation renderer selection.
