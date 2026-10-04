# API endpoint map

Approved endpoint map as of 2026-09-22, based on the API planning decisions and Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`. The methods, paths, and described behavior are accepted as the design baseline. Items explicitly left open still need detailed contracts. Approval does not mean implementation; no endpoints are implemented in this repository yet.

[Asset retirement](topics/identity-and-access.md#asset-retirement) and independent result declarations now have concrete bindings below. Route specification is not evidence of implementation.

Use [the glossary](../GLOSSARY.md) for resource meanings. Protocol owns resource and Command schemas; the descriptions below identify inputs and results without freezing every field.

See [the data component catalog](data-components.md) for the proposed component applicability and database inventory that will guide detailed schemas.

## Route families

These are the starting families; more can be added as requirements emerge. Behavior rules for each family live on the [topic pages](topics/README.md).

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

## Reading the tables

Each route records its method and path, expected callers and purpose, inputs and results, state changes and emitted events, and its design status and open questions. Subscriptions and asynchronous completion are mapped alongside requests so clients can determine when an operation finishes and how to receive updates. Coverage across the families comes before detailing every schema.

- **Retain**: method and path exist in the older router and are retained with the described behavior.
- **Adapt**: an older capability has a new path or changed contract.
- **New**: added to satisfy a requirement established in this planning session.

These labels describe provenance; the routes below reflect the accepted reconciliation. Expected callers describe usage. Core enforces the [caller permissions](topics/identity-and-access.md#callers-and-permissions) regardless of the expected caller.

In the effects column, `create`, `update`, and `delete` mean committed resource changes delivered through `/feed` and `/queries/changed-since`. Failed validation produces no resource change. The initial synchronized resource set is Entities, Tasks, and Objects, following the older design. Plugin discovery/status, Operations, operator profiles, settings and key metadata use explicit HTTP reads outside the initial picture; no separate live notifications are required initially. Plugin management uses private local interfaces.

## Entities

Entity types, identity, Aliases, Components, deletion, Track publishers and Geofeature geometry follow [Entities, Tracks and Geofeatures](topics/tracks-and-geofeatures.md). Every Asset requires status, communications, and heartbeat components. A returned Asset includes these components and advertised Command support, which is distinct from the complete catalog available locally through the SDK.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities` | Interfaces and data consumers list Entities | Filters, limit, cursor → Entity page | None | Retain |
| `POST /entities` | Asset clients register Assets; interfaces and Plugins create Tracks/Geofeatures | Identity, type, Descriptive data and, for Assets, Command support → Entity | `create` Entity | Adapt: restrict types |
| `GET /entities/{entity_id}` | Any consumer reads one Entity | ID → full Entity, including advertised support for an Asset | None | Retain |
| `GET /entities/alias/{alias}` | Interfaces resolve a known alias | Case-insensitive alias → one Entity | None | Retain |
| `PATCH /entities/{entity_id}` | Assets report their own changes; interfaces/integrations update other Entity types | ID, partial fields/components, authorship and applicable edit/report preconditions → Entity | `update` Entity; accepted fresh Asset reports refresh [Contact](topics/asset-reporting.md#contact-and-freshness) | Retain; detailed mutable-field schema remains open |
| `DELETE /entities/{entity_id}` | Interfaces remove an Entity | ID → no body, or blocking-Task conflict | `delete` Entity when permitted; retain historical Object associations; Asset deletion also revokes its bound credentials and closes their feeds | Retain; protect [required Task references](topics/tracks-and-geofeatures.md#required-entity-references) |
| `POST /entities/{entity_id}/retire` | Operator administrative clients withdraw an Asset | Asset ID, Dataset-scoped request identity → retired Asset or replayed result | Atomically end participation and revoke access; retain execution evidence and protected results; do not infer physical stop | New binding for accepted [retirement](topics/identity-and-access.md#asset-retirement) |
| `POST /entities/{entity_id}/checkin` | Assets, directly or through their gateway, report current state | ID, partial component data, optional supported-Command declaration → updated Entity | `update` Entity; accepted fresh reports refresh Contact under [check-in](topics/asset-reporting.md#check-in) | Adapt: status-based reporting |
| `GET /entities/{entity_id}/tasks` | Assets and interfaces inspect assigned work | Asset ID, outstanding/status filter, pagination → Task page with submission/current queue order and confirmation state | None; listing does not accept or start work | Adapt: replace separate execution-session polling |
| `PUT /entities/{entity_id}/task-order` | Tasking clients reorder an Asset's unstarted Tasks | Complete eligible queued Task ID list, expected queue revision, request identity → accepted requested revision/order | Reject stale/conflicting edits; publish requested order without implying Asset adoption | New |
| `POST /entities/{entity_id}/task-order/confirm` | Assigned Asset reports adoption or conflict | Requested revision, report identity, adopted/conflict result and relevant execution facts → requested/confirmed queue state | Record adoption or conflict; accepted fresh reports refresh contact and publish the Entity heartbeat change atomically with queue changes; duplicates/history do not refresh contact or roll back confirmed order | New |
| `GET /entities/{entity_id}/movement-history` | Consumers inspect retained movement for one Asset or Track | Entity association, from/to, limit/cursor → raw movement sample page with observation/receipt times | None; explicit history read outside the live picture | Adapt: narrow the older history API |
| `GET /entities/{entity_id}/objects` | Interfaces find associated files | Entity ID, pagination → Object metadata page | None | Retain |

Deletion follows [Entity deletion](topics/tracks-and-geofeatures.md#entity-deletion), which retains the older design's rejection of Asset deletion while it has nonterminal Tasks.

[Asset retirement](topics/identity-and-access.md#asset-retirement) remains possible even when that deletion guard blocks removal; its retry and already-retired distinctions apply to the binding above.

Asset reports follow [Asset reporting](topics/asset-reporting.md): Assets author their Reported data, Core owns Derived data, and only accepted fresh reports refresh Contact. Descriptive edits use the [concurrent-edit protection](architecture/system-design.md#concurrent-descriptive-edits).

The SDK provides Asset registration through `POST /entities`, followed by check-in; no separate registration or telemetry endpoint is needed. Registration content, stable Asset IDs and retries follow [Asset registration](topics/identity-and-access.md#asset-registration), and values before the first report follow [initial values](topics/asset-reporting.md#components-and-initial-values). See the [SDK operations catalog](topics/sdk.md#operations-catalog).

Movement samples, their capture from accepted reports and the history read's deleted-Entity and not-found behavior follow [movement history](topics/history.md#movement-history).

### Asset status

These routes read and report [Operational status](topics/asset-reporting.md#operational-status), which replaces the former execution-session API; exceptional interruption still requires Task reconciliation.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities/{entity_id}/status` | Interfaces and integrations inspect an Asset's condition | Asset ID → status, report times, and reason/details | None | New |
| `PATCH /entities/{entity_id}/status` | Assets and relays report Asset-originated operational status | Asset ID, status/reason/details, Asset report identity/order → updated status | `update` Entity; accepted fresh reports refresh Contact; no Task outcome inferred | New |

Status-specific routes apply to Asset Entities and share validation with check-in and Entity patches. [Command support](topics/asset-reporting.md#command-support) is Reported data, not bound to a public execution-session registration. Plugins are not Assets and expose Operations separately. Stale reports and process replacement follow [shared report context](topics/asset-reporting.md#shared-report-context); physical active/suspended work is recorded under [queue representation](topics/tasks.md#queue-representation-and-coherent-reads), without a Core scheduler.

## Tasks

Task creation assigns one Protocol-defined Command to one Asset. Validation, the status set and transitions, cancellation, scheduling, retention and the status route's rules are specified in [Tasks](topics/tasks.md); there is no generic Task patch or delete endpoint.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /tasks` | Interfaces inspect work | Filters, pagination → Task page | None | Retain |
| `POST /tasks` | Tasking client requests execution | Asset ID, Command, input, supported queued/immediate scheduling, idempotency key → created or previously created Task | `create` Task on first successful request | Retain |
| `GET /tasks/{task_id}` | Interfaces and Assets inspect one execution | Task ID → Task | None | Retain |
| `PATCH /tasks/{task_id}/status` | Tasking clients request cancellation; assigned Assets report lifecycle, progress and outcomes | Task ID, target status or progress-only report, request/report identity and transition-specific fields → authoritative Task | Validate actor/transition; set cancellation_requested on request, cancelled on confirmation, and the execution status established by accepted reports when the Asset declines; publish every accepted Task change; refresh contact only for accepted fresh Asset reports | Adapt: unified Task status updates |
| `POST /tasks/{task_id}/results` | Assigned Asset declares Task outputs independently of completion | Shared report context, append-only result declarations → recorded references and acceptance receipt | Validate the batch and place required-result holds atomically; allow declarations after terminal outcome; never change outcome | New: [result declarations](topics/tasks.md#result-declarations-and-execution-fixtures) |
| `GET /tasks/{task_id}/objects` | Interfaces inspect associated files | Task ID, pagination → Object metadata page | None | Retain |

Assigned-work reads and queue edits use the Entity routes above under [queue revisions](topics/tasks.md#queue-revisions). Pause and Resume use `POST /tasks` with their Protocol-defined Commands and immediate scheduling; neither adds a dedicated endpoint. Fresh Asset reports also publish the corresponding Entity contact change under [Contact and freshness](topics/asset-reporting.md#contact-and-freshness).

Concrete queue/report/result representations follow [Tasks](topics/tasks.md#queue-representation-and-coherent-reads) and [public wire conventions](architecture/system-design.md#public-wire-conventions); their production Protocol schemas remain to be authored.

## Objects

Objects hold file content of any type with flexible JSON metadata and historical Entity and Task references. Ready-only visibility, uploads and their retries, publication, deletion, Required-result protection, metadata edits and download are specified in [Objects](topics/objects.md); the earlier metadata-only `POST /objects` route is removed.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /objects` | Interfaces and integrations list files | Filters, pagination → Object metadata page | None | Retain |
| `POST /objects/upload` | File producers supply content and descriptive metadata | Complete file stream, SDK-allocated Object ID, Dataset-scoped request identity, metadata and associations → ready Object, original live success, or explicit deleted-result retry error | Stream to private staging; publish only complete content; clean up failed staging; restart failed transfers from zero; no overwrite | Adapt: ready-only publication |
| `GET /objects/{object_id}` | Consumers inspect a file record | Object ID → full metadata and associations | None | Retain |
| `PATCH /objects/{object_id}` | Interfaces and integrations edit metadata | Object ID, changed metadata/associations, required version precondition → Object | `update` Object metadata; stale edits conflict for caller review | Retain |
| `DELETE /objects/{object_id}` | Interfaces remove an unprotected Object | Object ID → no body, or conflict for a declared required Task result | Validate protection atomically with deletion; arrange stored-content removal only when allowed | Adapt: protect declared required results until Reset |
| `GET /objects/{object_id}/download` | Consumers retrieve file content | Object ID → attachment stream | None | Retain |
| `GET /objects/{object_id}/view` | Interfaces preview supported content | Object ID → inline stream, attachment, or unsupported-type error | None | Retain; supported preview formats need review |

Producer replay, content verification, durability and the deletion completion boundary follow [Objects](topics/objects.md#durability-and-publication-fixtures). Preview formats remain open.

## Administration

All routes are authenticated. Only [operator administrative clients](topics/identity-and-access.md#operator-clients) may manage the documented configuration and credentials. Plugin configuration and process administration are exclusively local.

### Core configuration and diagnostics

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/config` | Administrative clients inspect Core settings | No body → documented public configuration fields | None | New |
| `PATCH /admin/config` | Administrative clients change supported Core settings | Changed fields, required version precondition → desired/active configuration and apply requirements | Atomic validated save; per-field live/deferred application under [Core configuration](topics/dataset-lifecycle.md#core-configuration) | New |
| `GET /admin/resources` | Administrative clients inspect service resources | No body → host/process diagnostics | None | Adapt from `/resources` |

Supported editable Core fields and application rules follow [Core configuration](topics/dataset-lifecycle.md#core-configuration). No public lifecycle/restart endpoint is introduced.

### Activity history

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/activity` | Operator administrative clients inspect recorded actions | Actor/action/target/time filters, limit/cursor → activity page with known outcomes | None; read-only, outside the synchronized picture | New |

What is recorded, its attribution and retention follow [Activity history](topics/history.md#activity-history).

### API keys

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/auth/api-keys` | Administrative clients list keys | Pagination → key metadata, never key secrets | None | Adapt from `/admin/api-keys` |
| `POST /admin/auth/api-keys` | Administrative clients provision a key | Prepared creation/key identity, secret and name/description → key metadata | Idempotently create an operator administrative key; retain verifier only; not an Asset reporting identity | Adapt from `/admin/api-keys` |
| `DELETE /admin/auth/api-keys/{key_id}` | Administrative clients revoke a key | Key ID → no body | Revoke the key | Adapt from `/admin/api-keys/{key_id}` |

These routes require an operator administrative credential. Key bootstrap, prepared secrets, creation retries and revocation follow [API keys](topics/identity-and-access.md#api-keys) and [credential revocation](topics/identity-and-access.md#credential-revocation).

### Operator records

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/operators` | Interfaces select or display Operators | Pagination → Operator page | None | New |
| `POST /admin/operators` | Interfaces create a profile | Name and settings → Operator with stable ID | Create profile | New |
| `GET /admin/operators/{operator_id}` | Interfaces load a profile | Operator ID → Operator and settings | None | New |
| `PATCH /admin/operators/{operator_id}` | Interfaces edit a profile | Changed name/settings, required version precondition → Operator | Update profile | New |
| `DELETE /admin/operators/{operator_id}` | Interfaces remove a profile | Operator ID → no body | Delete profile/settings; retain actor ID/type and historical display context in activity records until Reset; do not cascade-delete history | New |

Use explicit Operator IDs rather than a `/me` route: an API key does not currently identify a person. Profile selection mechanics remain open; activity attribution follows [record contents and attribution](topics/history.md#record-contents-and-attribution). Deleting a profile does not imply deleting operational Entities, Tasks, or Objects. Profiles and personal settings survive ordinary Reset as installation setup; Hard Reset clears them.

## Plugins

The public API exposes Plugin discovery/status and durable Operations; Plugin management is local-only. Their rules are specified in [Plugins](topics/plugins.md).

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /plugins` | Consumers discover installed Plugins and capabilities | Pagination → Plugin summary page | None | Adapt: discovery and availability only |
| `GET /plugins/{plugin_id}` | Consumers inspect a Plugin | Plugin ID → release, capabilities, availability and fault status | None; no configuration secrets or management controls | New |
| `POST /plugins/{plugin_id}/operations` | Consumers invoke a declared capability | Capability identifier, input, dataset-scoped submission identity → accepted Operation and outcome URL | Record durable Operation; declared processing may publish operational resources | Adapt: replace request-bound capability invocation |
| `GET /plugins/{plugin_id}/operations` | Consumers list Operations | Filters, pagination → Operation page | None | New |
| `GET /plugins/{plugin_id}/operations/{operation_id}` | Consumers query one Operation | Core-owned Operation ID → status, progress, known outputs and outcome | None | New |
| `POST /plugins/{plugin_id}/operations/{operation_id}/cancel` | Consumers request cancellation | Operation ID → Operation | Record cancellation request; final outcome requires confirmation | New |

Submission, retries, cancellation, the [Operation transitions](topics/plugins.md#operation-transitions) and retention are specified in [Plugins](topics/plugins.md#operations), including the `202 Accepted` submission response.


## Synchronization

HTTP-mode operations call these routes directly, and the SDK's background synchronizer calls them privately in Full synchronization mode; read sources, freshness and recovery follow [SDK](topics/sdk.md#modes).

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /queries/full` | SDK clients load the full operational dataset | Per-resource pagination → Entities, Tasks, ready Objects with resource versions, continuations and stable baseline cursor | None; private staged load reconciles baseline replay before ready | Retain |
| `GET /queries/changed-since` | SDK clients recover missed changes | Baseline version and cursor → ordered change events and next recovery boundary | None | Retain |
| `GET /feed` | SDK clients subscribe to live operational changes | WebSocket upgrade, caller authentication, complete-picture subscribe → hello, boundary acknowledgement and commit-framed changes | Maintain connection; no resource writes; no selective subscriptions | Retain |

Asset-scoped synchronization is [deferred](topics/sdk.md#deferred-asset-hybrid-mode), and gateways use these routes like any other SDK client.

When retained history no longer covers the requested version, `GET /queries/changed-since` returns an explicit cursor-expired response. The SDK's load and recovery procedure follows [background synchronization](topics/sdk.md#background-synchronization). Whole-commit retention bounds, complete-picture scope and continuation fields follow [synchronization wire](topics/sdk.md#synchronization-wire-and-application-boundary).

All reads, mutations, prepared uploads and recovery cursors follow Core's [Dataset wire boundary](topics/dataset-lifecycle.md#dataset-wire-boundary) and [SDK Dataset Reset handling](topics/sdk.md#dataset-reset-handling).

Feed authentication follows [connection setup](topics/sdk.md#connection-setup): every socket sends the first `authenticate` message before operational delivery, including sockets opened with upgrade credentials. Browser WebSockets do not rely on custom upgrade headers or browser-session authentication. All application requests remain authenticated; CORS preflight is transport negotiation under [offline TLS setup](topics/dataset-lifecycle.md#offline-tls-and-first-time-setup).

## Health and documentation

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /health` | Authenticated clients discover Core state; Assets obtain contact proof | Credentials, optional bound Asset/generation challenge request → liveness, Dataset/Core time/version discovery, advisory Open enrollment status and optional contact challenge | No operational mutation or Contact refresh; challenge is proof for a later accepted report | Adapt: [freshness exchange](topics/asset-reporting.md#contact-proof-and-clock-uncertainty) |
| `GET /readiness` | Monitors check required dependencies | Caller credentials → readiness status and dependency checks | None | Adapt: now authenticated |
| `GET /docs` | Developers browse interactive documentation | Caller credentials → documentation interface | None | New |
| `GET /openapi.json` | SDK/tooling and docs read the HTTP contract | Caller credentials → OpenAPI document | None | New |

Health remains available across a Dataset change under the [Dataset boundary](topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary). Core readiness depends on required infrastructure, including SQLite and private Object file storage. An unavailable Plugin is [reported on that Plugin](topics/plugins.md#plugin-capabilities-and-discovery) and does not make an otherwise functioning Core globally unready. `/health` reports process liveness separately from `/readiness`, with the advisory setting and retained-identity count under [Open enrollment](topics/identity-and-access.md#open-enrollment). That advisory status does not make Core unready. Exact dependency probes, timeout thresholds and response format remain to be specified. Protected documentation uses the [offline key-entry and bootstrap contract](topics/dataset-lifecycle.md#offline-tls-and-first-time-setup); its unauthenticated shell contains no schema or operational data.

OpenAPI describes the API contract, and a documentation tool renders it at `/docs`. Swagger UI is a candidate; renderer selection remains open. These route names are project choices, not routes OpenAPI provides automatically. Capture contracts in OpenAPI as they are designed, and distinguish proposed operations from implemented ones in the documentation.

## Shared contract baseline

| Concern | Current owner and contract |
| --- | --- |
| Credential transport and setup | Retain the starting operator key transports `Authorization: Bearer` and `X-API-Key`. Caller authority follows [Identity and access](topics/identity-and-access.md#callers-and-permissions); TLS/docs/bootstrap and WebSocket setup follow [offline setup](topics/dataset-lifecycle.md#offline-tls-and-first-time-setup) and [SDK connections](topics/sdk.md#connection-setup) |
| Lists | Shared bounded filters, cursor/source boundaries and assigned-queue coherence follow [query and status](topics/sdk.md#query-and-status-contract) |
| Errors and wire context | JSON success/error envelopes, Dataset/version headers and decimal counters follow [public wire conventions](architecture/system-design.md#public-wire-conventions) |
| Concurrent changes | Separate atomic report and descriptive mutations follow [mutation-class validation](topics/asset-reporting.md#mutation-classes-and-atomic-validation) and the [authority matrix](topics/tracks-and-geofeatures.md#mutation-authority-matrix); configuration uses [desired/active revisions](topics/dataset-lifecycle.md#core-configuration) |
| Retryable mutations | Operation-specific prepared identities and outcome categories follow [SDK mutation retries](topics/sdk.md#mutation-outcomes-and-retries); Core uses [retry identity](architecture/system-design.md#retry-identity) without replacing owner-specific facts or retention |
| Compatibility | Health advertises explicit supported editions and the SDK selects a common edition under [connection setup](topics/sdk.md#connection-setup); Command Catalog lookup remains local |
| Change events | Whole-commit Entity/Task/ready-Object frames, bounded replay and initial handoff follow [synchronization wire](topics/sdk.md#synchronization-wire-and-application-boundary) |

## Remaining contract details

Author full endpoint schemas and SDK signatures from these owning specifications during their [implementation slices](architecture/implementation-sequence.md). The representative [Protocol proof](research/atlas-reassessment/13-protocol-toolchain-proof.md) verifies the supported generation profile without implying complete API coverage. Future Command variants and their detailed progress/deadline rules remain in [Tasks' open questions](topics/tasks.md#open-questions); a production Elevation provider and documentation renderer are unselected. These choices do not reopen the specified report, queue, transfer, retirement, configuration or synchronization rules.

## Sources

Route existence was checked against the router, not inferred only from prose. This is a local source review, not a claim that the older service was run or that its current remote state was fetched.

- [Registered routes](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go).
- [API guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md).
- [Earlier Task contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md); its execution-session design is superseded here by [Asset reporting](topics/asset-reporting.md).
- [Object contracts](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md).
- [Historical Object references](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md).
- [Plugin design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md).
- [Plugin management](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md).
