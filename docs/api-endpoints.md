# API endpoint map

Approved endpoint map as of 2026-09-22, based on [the API plan](api-plan.md) and Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`. The methods, paths, and described behavior are accepted as the design baseline. Items explicitly left open still need detailed contracts. Approval does not mean implementation; no endpoints are implemented in this repository yet.

[Asset retirement](topics/identity-and-access.md#asset-retirement) is an accepted operation whose HTTP binding is still to be selected, so it is recorded below separately from the route table.

Use [the glossary](../CONTEXT.md) for resource meanings. Protocol owns resource and Command schemas; the descriptions below identify inputs and results without freezing every field.

See [the data component catalog](data-components.md) for the proposed component applicability and database inventory that will guide detailed schemas.

## Reading the tables

- **Retain**: method and path exist in the older router and are retained with the described behavior.
- **Adapt**: an older capability has a new path or changed contract.
- **New**: added to satisfy a requirement established in this planning session.

These labels describe provenance; the routes below reflect the accepted reconciliation. Expected callers describe usage. Core enforces the [caller permissions](topics/identity-and-access.md#callers-and-permissions) regardless of the expected caller.

In the effects column, `create`, `update`, and `delete` mean committed resource changes delivered through `/feed` and `/queries/changed-since`. Failed validation produces no resource change. The initial synchronized resource set is Entities, Tasks, and Objects, following the older design. Plugin discovery/status, operator profiles, settings and key metadata are read through the allowed public endpoints; their notification behavior remains open. Plugin management uses private local interfaces.

## Entities

Only `asset`, `track`, and `geofeature` are valid Entity types. An Entity's ID and type are immutable. Houses are Tracks; zones and rally points are Geofeatures. Every Asset requires status, communications, and heartbeat components. A returned Asset includes these components and advertised Command support, which is distinct from the complete catalog available locally through the SDK.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities` | Interfaces and data consumers list Entities | Filters, limit, cursor → Entity page | None | Retain |
| `POST /entities` | Asset clients register Assets; interfaces and Plugins create Tracks/Geofeatures | Identity, type, Descriptive data and, for Assets, Command support → Entity | `create` Entity | Adapt: restrict types |
| `GET /entities/{entity_id}` | Any consumer reads one Entity | ID → full Entity, including advertised support for an Asset | None | Retain |
| `GET /entities/alias/{alias}` | Interfaces resolve a known alias | Case-insensitive alias → one Entity | None | Retain |
| `PATCH /entities/{entity_id}` | Assets report their own changes; interfaces/integrations update other Entity types | ID, partial fields/components, authorship and applicable edit/report preconditions → Entity | `update` Entity; accepted fresh Asset reports refresh [Contact](topics/asset-reporting.md#contact-and-freshness) | Retain; detailed mutable-field schema remains open |
| `DELETE /entities/{entity_id}` | Interfaces remove an Entity | ID → no body, or blocking-Task conflict | `delete` Entity when permitted; retain historical Object associations; Asset deletion also revokes its bound credentials and closes their feeds | Retain; protect required Task references |
| `POST /entities/{entity_id}/checkin` | Assets, directly or through their gateway, report current state | ID, partial component data, optional supported-Command declaration → updated Entity | `update` Entity; accepted fresh reports refresh Contact under [check-in](topics/asset-reporting.md#check-in) | Adapt: status-based reporting |
| `GET /entities/{entity_id}/tasks` | Assets and interfaces inspect assigned work | Asset ID, outstanding/status filter, pagination → Task page with submission/current queue order and confirmation state | None; listing does not accept or start work | Adapt: replace separate execution-session polling |
| `PUT /entities/{entity_id}/task-order` | Tasking clients reorder an Asset's unstarted Tasks | Complete eligible queued Task ID list, expected queue revision, request identity → accepted requested revision/order | Reject stale/conflicting edits; publish requested order without implying Asset adoption | New |
| `POST /entities/{entity_id}/task-order/confirm` | Assigned Asset reports adoption or conflict | Requested revision, report identity, adopted/conflict result and relevant execution facts → requested/confirmed queue state | Record adoption or conflict; accepted fresh reports refresh contact and publish the Entity heartbeat change atomically with queue changes; duplicates/history do not refresh contact or roll back confirmed order | New |
| `GET /entities/{entity_id}/movement-history` | Consumers inspect retained movement for one Asset or Track | Entity association, from/to, limit/cursor → raw movement sample page with observation/receipt times | None; explicit history read outside the live picture | Adapt: narrow the older history API |
| `GET /entities/{entity_id}/objects` | Interfaces find associated files | Entity ID, pagination → Object metadata page | None | Retain |

Deletion rule retained from the older design: reject Asset deletion while it has nonterminal Tasks. Also reject Track or Geofeature deletion when any nonterminal Task has a required Command reference to that Entity; identify the blocking Task references in the conflict and do not force an outcome to permit deletion. An unavailable Asset may leave the reference blocked until Reset. See [required Entity references during Tasks](adr/0023-protect-required-entity-references-during-tasks.md). Retain completed Task records and historical Object references after an allowed deletion. Allowed Asset deletion also revokes the Asset's access under [Asset deletion and access](topics/identity-and-access.md#asset-deletion-and-access). Aliases are optional, editable, and unique across all Entity types ignoring case. Store an absent alias as null; relationships use immutable Entity IDs. Entity types never change. Core reserves each Entity ID within the Dataset, retains that reservation after deletion and across Restart, and rejects reuse until Reset. Asset IDs stay bound to their identity across Reset under [retained Asset identity](topics/identity-and-access.md#retained-asset-identity-after-reset). Every Geofeature must have valid point, line, or polygon geometry at creation; unfinished drawings remain in the interface. Track geometry is optional, and Assets use telemetry for position. Exact Entity filters remain open.

[Asset retirement](topics/identity-and-access.md#asset-retirement) remains possible even when that deletion guard blocks removal. Its method and path remain to be recorded before implementation; no guessed route is added to the approved table.

Core validates components against Protocol-defined schemas and applicability. Entities have no unrestricted `extra` metadata map. Plugins will never define or register components. Entity patches follow the [partial component update rules](topics/asset-reporting.md#partial-component-updates).

Asset reports follow [Asset reporting](topics/asset-reporting.md): Assets author their Reported data, Core owns Derived data, and only accepted fresh reports refresh Contact. Track observation authorship follows the [one-publisher Track rule](adr/0022-one-publisher-per-track.md#publisher-continuity): the same authenticated publisher in one Dataset may continue an existing Track after Plugin uninstall and reinstall with fresh observations, while another publisher uses a separate Track. A silent Track retains its last-known values and exposes observation age; silence does not delete it or refresh its coordinates. There is no universal Track expiry for execution: a Command requiring current observations defines acceptable age and stale handling, while a last-known Command may continue and the Asset applies that policy. Descriptive edits use the [concurrent-edit protection](architecture/system-design.md#concurrent-descriptive-edits). The same publisher may correct current observations through ordinary updates without refreshing their age, rewriting history or replacing newer observations. Publisher transfers are deferred under [ADR-0022](adr/0022-one-publisher-per-track.md#publisher-transfers).

The SDK provides Asset registration through `POST /entities`, followed by check-in; no separate registration or telemetry endpoint is needed. Registration content, stable Asset IDs and retries follow [Asset registration](topics/identity-and-access.md#asset-registration), and values before the first report follow [initial values](topics/asset-reporting.md#components-and-initial-values). See the [SDK operations catalog](sdk-operations.md).

Movement samples are captured from explicitly supplied position, speed and altitude in accepted ordinary Entity reports, in the same transaction as the current-state write. Report retries do not duplicate samples, and unrelated updates do not manufacture measurements. History reads return bounded, stably ordered pages; they preserve the Dataset/Entity association and pagination boundary. The movement-history route resolves live and deleted Asset/Track IDs through retained identity records: deletion does not make retained samples inaccessible. Return a deleted-Entity indicator with the historical page; an empty interval is an empty page. An ID never present in the current Dataset returns not found, and an obsolete-Dataset request cannot read a replacement Dataset. Retain samples until Reset, separately from current telemetry and feed recovery. Backfill writes, sample editing, reduced-trail and historical-inspection routes are deferred. See [movement history](architecture/system-design.md#movement-history).

### Asset status

These routes read and report [Operational status](topics/asset-reporting.md#operational-status), which replaces the former execution-session API; exceptional interruption still requires Task reconciliation.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities/{entity_id}/status` | Interfaces and integrations inspect an Asset's condition | Asset ID → status, report times, and reason/details | None | New |
| `PATCH /entities/{entity_id}/status` | Assets and relays report Asset-originated operational status | Asset ID, status/reason/details, Asset report identity/order → updated status | `update` Entity; accepted fresh reports refresh Contact; no Task outcome inferred | New |

Status-specific routes apply to Asset Entities and share validation with check-in and Entity patches. [Command support](topics/asset-reporting.md#command-support) is Reported data, not bound to a public execution-session registration. Plugins are not Assets and expose Operations separately. Mechanics for stale reports, restart reconciliation, and active Tasks remain open and must be settled before execution is implemented.

## Tasks

Task creation assigns one Protocol-defined Command to one Asset. Assignment, Command, input and selected scheduling are immutable. The [Task transition table](adr/0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) defines statuses, report authority and cancellation/terminal-state rules. There is no generic Task patch or delete endpoint; [terminal records remain until Reset](adr/0007-reconcile-asset-tasks-after-disconnection.md#completed-task-retention).

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /tasks` | Interfaces inspect work | Filters, pagination → Task page | None | Retain |
| `POST /tasks` | Tasking client requests execution | Asset ID, Command, input, supported queued/immediate scheduling, idempotency key → created or previously created Task | `create` Task on first successful request | Retain |
| `GET /tasks/{task_id}` | Interfaces and Assets inspect one execution | Task ID → Task | None | Retain |
| `PATCH /tasks/{task_id}/status` | Tasking clients request cancellation; assigned Assets report lifecycle, progress and outcomes | Task ID, target status or progress-only report, request/report identity and transition-specific fields → authoritative Task | Validate actor/transition; set cancellation_requested on request, cancelled on confirmation, and the execution status established by accepted reports when the Asset declines; publish every accepted Task change; refresh contact only for accepted fresh Asset reports | Adapt: unified Task status updates |
| `GET /tasks/{task_id}/objects` | Interfaces inspect associated files | Task ID, pagination → Object metadata page | None | Retain |

Task creation validates the Protocol catalog, Command input and the Asset's advertised support, and rejects new assignments to a [retired Asset](topics/identity-and-access.md#asset-retirement). Repeating an idempotency key with the same request returns the same Task; different tasking data conflicts. Core records every cancellation request; declared Asset cancellation support only tells the caller what to expect, and an Asset that cannot withdraw the Task declines the request. [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) owns offline acceptance and execution behavior.

An unfinished Task that references a Geofeature follows its immutable ID and current geometry until its Command's declared cutoff, by default the terminal report, and Core records the geometry revision the Asset used. Before that cutoff, geometry edits that would invalidate the Task's input are rejected with the blocking Tasks identified. For scans, Core's accepted valid assigned-Asset collection-finished report closes geometry changes; earlier edits are accounted for, later edits do not demand more collection, and another scan is a new Task. [ADR-0024](adr/0024-use-live-geofeature-geometry-in-tasks.md) covers disconnected continuation, reconnect adoption, and saved-versus-applied geometry reporting, with gateway receipt distinct from adoption and reporting as evidence rather than permission. [ADR-0008](adr/0008-complete-scan-tasks-when-required-results-are-available.md) retains required-result gating and either arrival order; exact revisions and transport encodings remain engineering work.

The status endpoint replaces the separate acknowledge/start/progress/complete/fail/cancel endpoints. It accepts lifecycle and progress-only reports under [ADR-0007's status update contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#status-update-api), and returns the actual recorded Task. Progress-only reports preserve current status. A completion submission may return a nonterminal Task under the [scan completion contract](adr/0008-complete-scan-tasks-when-required-results-are-available.md). Named SDK helpers use this same endpoint. Fresh Asset reports also publish the corresponding Entity contact change under [Contact and freshness](topics/asset-reporting.md#contact-and-freshness).

Assigned-work reads and queue edits use the Entity routes above. Follow the [queue revision contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions) for ordering, eligibility, pagination and adoption/conflict reports. Clients fetch all outstanding pages and deduplicate by Task ID.

Pause and Resume use `POST /tasks` with their Protocol-defined Commands and immediate scheduling; neither adds a dedicated endpoint. [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling) owns their execution, control ordering and expiry behavior, including [recovery after an unexpected Asset restart](adr/0007-reconcile-asset-tasks-after-disconnection.md#recovery-after-an-unexpected-asset-restart).

Request fields, sequence encoding, concurrency/report-ordering tokens, event envelopes and error encodings remain schema work.

## Objects

Objects hold arbitrary file types and flexible JSON metadata. Entity references are zero-to-many. Objects also support Task references. References are historical associations, not ownership links that cascade-delete files.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /objects` | Interfaces and integrations list files | Filters, pagination → Object metadata page | None | Retain |
| `POST /objects/upload` | File producers supply content and descriptive metadata | Complete file stream, SDK-allocated Object ID, Dataset-scoped request identity, metadata and associations → ready Object, original live success, or explicit deleted-result retry error | Stream to private staging; publish only complete content; clean up failed staging; restart failed transfers from zero; no overwrite | Adapt: ready-only publication |
| `GET /objects/{object_id}` | Consumers inspect a file record | Object ID → full metadata and associations | None | Retain |
| `PATCH /objects/{object_id}` | Interfaces and integrations edit metadata | Object ID, changed metadata/associations, required version precondition → Object | `update` Object metadata; stale edits conflict for caller review | Retain |
| `DELETE /objects/{object_id}` | Interfaces remove an unprotected Object | Object ID → no body, or conflict for a declared required Task result | Validate protection atomically with deletion; arrange stored-content removal only when allowed | Adapt: protect declared required results until Reset |
| `GET /objects/{object_id}/download` | Consumers retrieve file content | Object ID → attachment stream | None | Retain |
| `GET /objects/{object_id}/view` | Interfaces preview supported content | Object ID → inline stream, attachment, or unsupported-type error | None | Retain; supported preview formats need review |

Objects are visible through reads, queries and feed only after content and metadata are ready. Upload identity, staged metadata and progress are separate transfer state, not publicly listed Objects. Physical file paths remain private; measured byte size and content type come from the upload process. The earlier metadata-only `POST /objects` route is removed. Descriptive fields and associations may be staged with the upload and edited after publication, with the [concurrent-edit protection](architecture/system-design.md#concurrent-descriptive-edits) rejecting stale edits for caller review. The accepted [upload contract](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries) restarts interrupted uploads from the beginning. Resumable transfer sessions, offset queries and chunk-continuation endpoints are deferred. Clean up failed or abandoned staging; it is not a retained operational record. Stable Dataset-scoped request identity recognizes a previously completed upload when its response was lost; concurrent retries cannot publish twice. Conflicting reuse fails. Exact content-equivalence verification remains schema work. After the first successful upload, file content is immutable. Changed content requires a new Object ID; descriptive metadata remains editable. A retry must recognize an already-successful upload without overwriting it. Exact retry identity/content verification, transfer limits, deletion completion, and preview formats remain open. Arbitrary upload types do not imply arbitrary inline rendering.

The SDK allocates Object IDs before completion reporting/upload, so either arrival order is representable without publishing placeholders. Reusing an upload request with another Object ID or claiming an already-used Object ID with a different request conflicts. Allowed deletion keeps private identity tombstones until Reset; an identical old upload retry reports that its Object was deleted and cannot recreate it. [Identity and retry contract](adr/0009-expose-objects-only-when-ready.md#result-identity-before-upload).

Required result Objects cannot be deleted from Core's acceptance of the assigned Asset's declaration until Reset, regardless of later Task status. Core checks authoritative Task result references, not only editable Object associations. Metadata edits, Entity deletion and a stale cleanup request cannot bypass protection. Declaration acceptance, publication and deletion must serialize their protection decisions; declarations for already-deleted IDs are rejected. Optional attachments and other unprotected Objects retain ordinary deletion behavior. See [required results](adr/0009-expose-objects-only-when-ready.md#required-result-protection).

## Administration

All routes are authenticated. Only [operator administrative clients](topics/identity-and-access.md#operator-clients) may manage the documented configuration and credentials. Plugin configuration and process administration are exclusively local.

### Core configuration and diagnostics

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/config` | Administrative clients inspect Core settings | No body → documented public configuration fields | None | New |
| `PATCH /admin/config` | Administrative clients change supported Core settings | Changed fields, required version precondition → configuration and apply requirements | Persist accepted settings; restart/apply rules remain open | New |
| `GET /admin/resources` | Administrative clients inspect service resources | No body → host/process diagnostics | None | Adapt from `/resources` |

The editable Core settings and their application rules must be defined before the configuration write route is implemented. The Plugin save/apply policy is not automatically a policy for Core itself. No generic maintenance or restart endpoint is proposed without a specific operation to support.

### Activity history

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/activity` | Operator administrative clients inspect recorded actions | Actor/action/target/time filters, limit/cursor → activity page with known outcomes | None; read-only, outside the synchronized picture | New |

Record Task issuance/cancellation and Plugin, credential and configuration changes, including local CLI/TUI actions, plus the administrative retirement action required by [ADR-0019](adr/0019-retire-assets-without-inventing-task-outcomes.md). Core/private management supplies authenticated attribution; public callers cannot insert or alter log entries. A selected profile is not proof of a human actor behind a shared key. Keep safe summaries without secrets or full resource snapshots, deduplicate action retries, and retain until Reset. See the [activity-history contract](architecture/system-design.md#activity-history) for database transactions and process request/outcome recording.

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

Use explicit Operator IDs rather than a `/me` route: an API key does not currently identify a person. Profile selection mechanics remain open; activity records identify the authenticated caller and do not treat a selected profile as proof of human identity. Deleting a profile does not imply deleting operational Entities, Tasks, or Objects. Profiles and personal settings survive ordinary Reset as installation setup; Hard Reset clears them.

## Plugins

Plugin installation, catalog selection, configuration, enable/disable, updates, removal and process control use the local CLI/TUI. They have no public endpoints or SDK methods. Uninstall stops the Plugin and clears its private operational work, saved configuration, usable credentials, downloaded reference data and owned installation artifacts; reinstall starts with empty work and fresh setup. Public resources and recorded Operations retain their own lifecycle, while disabling preserves the installation and private work, under [ADR-0021](adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall). The public API exposes discovery/status and durable Operations under [ADR-0002](adr/0002-core-manages-installed-plugins.md).

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /plugins` | Consumers discover installed Plugins and capabilities | Pagination → Plugin summary page | None | Adapt: discovery and availability only |
| `GET /plugins/{plugin_id}` | Consumers inspect a Plugin | Plugin ID → release, capabilities, availability and fault status | None; no configuration secrets or management controls | New |
| `POST /plugins/{plugin_id}/operations` | Consumers invoke a declared capability | Capability identifier, input, dataset-scoped submission identity → accepted Operation and outcome URL | Record durable Operation; declared processing may publish operational resources | Adapt: replace request-bound capability invocation |
| `GET /plugins/{plugin_id}/operations` | Consumers list Operations | Filters, pagination → Operation page | None | New |
| `GET /plugins/{plugin_id}/operations/{operation_id}` | Consumers query one Operation | Core-owned Operation ID → status, progress, known outputs and outcome | None | New |
| `POST /plugins/{plugin_id}/operations/{operation_id}/cancel` | Consumers request cancellation | Operation ID → Operation | Record cancellation request; final outcome requires confirmation | New |

Here `operation_id` identifies one accepted Operation, not a Plugin capability. Return `202 Accepted` on submission with the Operation identity and query URL. Retries with the same dataset-scoped submission identity recover the existing Operation; a deliberate rerun uses a new identity. Caller disconnection does not cancel work. Failed or Interrupted Operations retain known outputs/effects. Terminal outcomes cannot be overwritten; query retained Operations even if the Plugin is later removed, until Reset.

Operations have their own [transition table](adr/0002-core-manages-installed-plugins.md#operation-transitions). Operation transitions remain separate from Task transitions even though both include cancellation-requested intent. Operation polling uses these endpoints in every SDK mode; Operations are outside the initial Entity/Task/Object picture. Live Operation notification details remain open.

Plugins are not taskable Assets. They can create Tasks for Assets through the ordinary Task API, and publish resources through Core using their Plugin identity. Stopping a Plugin protects its active Operations under [ADR-0006](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md); unrelated Asset Tasks do not block management. Local management results, saved/active configuration and startup validation belong to that private contract, not the public Plugin resource.

## Synchronization

The general SDK exposes resource reads, queries, and feed subscriptions through the same methods in HTTP mode and Full synchronization mode under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). HTTP mode passes all three operations through to Core's API. Full synchronization mode uses local resource/query results and subscriptions to changes applied to the local picture, with no direct pass-through, fallback, or per-call bypass. The endpoints below are called by HTTP-mode operations or privately by the background synchronizer; full-synchronization application query/feed calls resolve locally. HTTP-mode failures do not fall back to cached data. See [SDK data access](sdk-data-access.md) for freshness, recovery, and open read-policy decisions.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /queries/full` | SDK clients load the full operational dataset | Per-resource pagination → Entities, Tasks, Objects, continuation cursors and a baseline version | None | Retain |
| `GET /queries/changed-since` | SDK clients recover missed changes | Baseline version and cursor → ordered change events and next recovery boundary | None | Retain |
| `GET /feed` | SDK clients subscribe to live operational changes | WebSocket upgrade, API-key authentication, subscription filters → hello, subscription acknowledgement and resource events | Maintain connection/subscriptions; no resource writes | Retain |

The earlier [Asset hybrid mode](sdk-data-access.md#asset-hybrid-mode) is deferred along with Core's matching Asset-scoped snapshots, feed, replay, dependency membership and continuation rules. Gateways, like IP-connected Assets, use HTTP mode or Full synchronization mode over an IP link to Core with adequate bandwidth; they need not share Core's host or network. The constrained gateway-to-Asset radio link has no selected transport or delivery contract yet. Removing the SDK mode does not change authenticated Asset report authority, retries, Task reconciliation or Core retention.

Recovery contract: finish initial dataset pagination, then recover changes since its baseline before treating the dataset as current. The paginated read is not a frozen database snapshot. Keep the baseline stable across its pages; do not substitute the largest version seen in individual resources. Subscription acknowledgement and its continuation boundary close the handoff to live delivery. On feed reconnect or a version gap, recover through changed-since. If retained history no longer covers the requested version, return an explicit cursor-expired response and require a new initial load. Retention duration, subscription filters and exact continuation fields remain implementation choices; Asset-scoped synchronization is deferred.

All reads, mutations, upload handles and recovery cursors follow the [dataset Reset boundary](sdk-data-access.md#dataset-reset-boundary). Core rejects obsolete-dataset submissions, reports and transfer/replay handles; the SDK discards obsolete state without relabeling old writes. Exact wire placement remains open.

Browser WebSockets cannot rely on custom upgrade headers. Use first-message API-key authentication when upgrade headers are unavailable; authenticate before delivering events. No browser-session authentication is assumed. All application requests remain authenticated; CORS preflight is transport negotiation and needs separate handling.

## Health and documentation

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /health` | Monitors check that Core is serving | API key → liveness status | None | Adapt: now authenticated |
| `GET /readiness` | Monitors check required dependencies | API key → readiness status and dependency checks | None | Adapt: now authenticated |
| `GET /docs` | Developers browse interactive documentation | API key → documentation interface | None | New |
| `GET /openapi.json` | SDK/tooling and docs read the HTTP contract | API key → OpenAPI document | None | New |

Core readiness depends on required infrastructure, including SQLite and private Object file storage. An unavailable Plugin is reported on that Plugin and does not make an otherwise functioning Core globally unready. Exact dependency probes and timeout thresholds remain to be specified. Browser access to protected documentation needs a concrete key-entry/bootstrap mechanism without making documentation anonymously accessible by accident.

## Shared contract baseline

| Concern | Accepted starting rule | Still to settle |
| --- | --- | --- |
| API key transport | Carry forward `Authorization: Bearer` and `X-API-Key` for public HTTP calls | Choose whether both are needed; browser docs entry flow |
| Lists | Bounded cursor pagination, following older list contracts | Filters, limits, and headers versus body pagination metadata |
| Errors | Stable error code and human-readable message with appropriate HTTP status | One consistent error envelope for handlers and authentication |
| Concurrent changes | Resource versions and ETags; operator-managed and other descriptive edits require a matching version precondition, and stale edits conflict for caller review. Asset reports use their separate acceptance and ordering rules | Exact revision and conflict encodings |
| Retryable mutations | Stored original Asset registration facts, Task creation idempotency, Dataset-scoped Asset retirement/Operation/upload identities, installation-scoped API-key creation identities; history capture and action recording deduplicate retries. One shared [retry identity](architecture/system-design.md#retry-identity) mechanism returns first, replay, conflict or ended outcomes | Exact identity/wire encodings and remaining response schemas; accepted retention rules are defined in the linked contracts |
| Protocol compatibility | Allow declared compatible Core/Asset/SDK versions; explicitly reject unsupported versions and unsupported Asset Commands | Compatibility range advertisement and negotiation fields; catalog lookup remains local |
| Change events | Committed Entity, Task, and Object writes publish versioned changes; identical no-op retries do not create another execution | Administrative/Plugin notifications and retention limits |

## Remaining contract details

1. Define exact request/response schemas, filters, limits, and status codes for the approved routes.
2. Resolve the specific open choices in the shared contract table, including exact concurrent-edit error/revision encodings and how supported compatibility ranges are advertised. The required protection for descriptive edits and the separate Asset-report acceptance rule are settled.
3. Specify Task status and queue wire fields, report validation and reconciliation mechanics; specify Pause/Resume report correlation, Command-specific deadlines and recovery evidence under the accepted ordering/reconciliation policies before implementation. Do not reintroduce the removed execution-session API.
4. Define private local management outcomes, Operation envelopes/notification behavior, and whole-file upload retry identity/content-verification details.
5. Bind the accepted [retirement workflow](topics/identity-and-access.md#asset-retirement) to one HTTP operation and SDK method, including its Core-owned Entity condition and retained authorization state. Preserve its semantics without inventing a second caller-side workflow.

## Sources

Route existence was checked against the router, not inferred only from prose. This is a local source review, not a claim that the older service was run or that its current remote state was fetched.

- [Registered routes](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go).
- [API guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md).
- [Earlier Task contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md); its execution-session design is superseded here by [Asset reporting](topics/asset-reporting.md).
- [Object contracts](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md).
- [Historical Object references](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md).
- [Plugin design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md).
- [Plugin management](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md).
