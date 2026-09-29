# API plan

This document records the API planning decisions. The endpoint map was approved on 2026-09-22. The routes describe intended organization and accepted methods, not implemented endpoints. Detailed schemas and explicitly unresolved behavior remain to be designed.

See [the domain glossary](../CONTEXT.md) for the meanings of the resources in this plan.

The [data component catalog](data-components.md) inventories resource components and their proposed applicability and storage mappings. Required Asset status, communications, and heartbeat, plus required Task status, are agreed. Required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and typed storage with validated JSON for variable payloads are also agreed. Detailed physical mappings and other component restrictions remain proposals.

The [approved API endpoint map](api-endpoints.md) records methods, paths, inputs, results, and effects under these families, along with the remaining detailed contract questions.

## Access

Public consumers authenticate, have broad operational read access and have no operator roles; Asset, Plugin, gateway and administrative boundaries follow [Identity and access](topics/identity-and-access.md).

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

Entities have exactly three types, Asset, Track and Geofeature; their identity, Aliases, Protocol-defined Components, deletion, one publisher per Track, observation age and Geofeature geometry are specified in [Entities, Tracks and Geofeatures](topics/tracks-and-geofeatures.md).

Every Asset requires status, communications and heartbeat components; [Asset reporting](topics/asset-reporting.md) specifies Operational status, Communication state, Contact, check-in, partial component updates and report acceptance, replacing the earlier execution-session API.

The SDK [Asset client](topics/sdk.md#asset-client) registers Assets through `POST /entities` and then checks in, with no separate registration or telemetry endpoint; the [SDK operations catalog](topics/sdk.md#operations-catalog), distinct from the Protocol Command Catalog, maps SDK workflows to routes and registration follows [Asset registration](topics/identity-and-access.md#asset-registration).

Assets author their own reported Entity data, and only accepted fresh Asset-originated reports refresh [Contact](topics/asset-reporting.md#contact-and-freshness); these reporting rules do not replace the [one-publisher Track rule](topics/tracks-and-geofeatures.md#one-publisher-per-track).

Tasks are operational instructions, each recording one Command invocation assigned to one Asset; Commands, the Command Catalog, the Task lifecycle, scheduling, queues, Pause/Resume, reconciliation and scan completion are specified in [Tasks](topics/tasks.md), and the [endpoint map](api-endpoints.md#tasks) maps them to public operations.

Core, Assets and SDK clients may use different supported compatible versions. Core advertises supported compatibility ranges and explicitly rejects unsupported clients; exact negotiation fields remain open. See [ADR-0005](adr/0005-allow-compatible-client-versions.md).

Objects hold immutable file content of arbitrary types with editable descriptive metadata and historical Entity and Task references. Ready-only visibility, whole-file uploads and their retries, deletion, Required-result protection and metadata edits are specified in [Objects](topics/objects.md), and the [endpoint map](api-endpoints.md#objects) maps them to public operations.

Movement history and Activity history, including what each records, retention and their paginated reads, are specified in [Activity and movement history](topics/history.md).

Operator records contain information such as a name and personal settings. Exact fields remain open.

Plugins expose durable Operations, not Asset Tasks, and may issue Tasks to real Assets through existing Commands; installation, configuration and process administration are local CLI/TUI actions with no public management routes or SDK methods. [Plugins](topics/plugins.md) specifies Operations, lifecycle, configuration and storage.

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

Core readiness depends on required infrastructure, including SQLite and the private Object file storage. Individual Plugin failures are [reported on the affected Plugin](topics/plugins.md#plugin-capabilities-and-discovery) and do not make an otherwise functioning Core globally unready. Exact dependency probes remain open.

OpenAPI describes the API contract. A documentation tool renders it at `/docs`; Swagger UI is a candidate. These route names are project choices, not routes automatically provided by OpenAPI.

As contracts are designed, capture them in OpenAPI. Documentation must distinguish proposed operations from implemented ones.

## Endpoint map format

For each endpoint, record:

- HTTP method and path.
- Purpose and expected callers.
- Inputs and results.
- State changes and emitted events.
- Design status and unresolved questions.

Expected callers explain usage. Enforced report ownership and administrative boundaries follow [caller permissions](topics/identity-and-access.md#callers-and-permissions).

Map subscriptions and asynchronous completion alongside requests so clients can determine when an operation finishes and how to receive updates.

## SDK read modes

The general SDK reads through HTTP mode or Full synchronization mode behind one read interface, under [SDK](topics/sdk.md#modes).

## Further planning

Start with workflows and resource ownership, then map them to endpoints. Establish coverage across the families before detailing every schema.

The following decisions remain open:

- Entity relationships and lifecycle behavior beyond the [accepted Entity rules](topics/tracks-and-geofeatures.md#open-questions).
- The [Asset reporting open questions](topics/asset-reporting.md#open-questions), including Communication state criteria, report validation and freshness mechanisms.
- Exact Task/queue field encodings, report ordering and failure behavior during sequential Asset execution; Pause/Resume report correlation, deadline and expiry fields, Core-time offset estimation and execution-recovery proof remain implementation details under the accepted policy.
- Detailed Asset-supported Command reporting, stale-report handling, and restart reconciliation under the accepted Task lifecycle.
- Local SDK Command Catalog function name/signature and SDK operation names, including the detailed registration deduplication contract for stable Asset and request identities.
- Exact Object metadata schema and reference representation; historical associations are retained when a related Entity is removed.
- Fields and lifecycle of operator records.
- The [Plugin open questions](topics/plugins.md#open-questions), including manifest/distribution, private Docker coordination and configuration schema details.
- API key transport details, local first-key provisioning commands, and how browser documentation authenticates.
- Health check criteria and response format.
- Shared wire conventions for errors, pagination, concurrent edits, retries, and subscriptions; concurrent descriptive-edit protection is accepted, while its revision and error encodings remain implementation work.
- Request and response schemas and asynchronous behavior. Methods and paths are accepted in the [endpoint map](api-endpoints.md), except bindings it marks as open.
- Documentation renderer selection.
