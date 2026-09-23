# API endpoint map

Approved endpoint map as of 2026-09-22, based on [the API plan](api-plan.md) and Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`. The methods, paths, and described behavior are accepted as the design baseline. Items explicitly left open still need detailed contracts. Approval does not mean implementation; no endpoints are implemented in this repository yet.

Use [the glossary](../CONTEXT.md) for resource meanings. Protocol owns resource and Command schemas; the descriptions below identify inputs and results without freezing every field.

See [the data component catalog](data-components.md) for the proposed component applicability and database inventory that will guide detailed schemas.

## Reading the tables

- **Retain**: method and path exist in the older router and are retained with the described behavior.
- **Adapt**: an older capability has a new path or changed contract.
- **New**: added to satisfy a requirement established in this planning session.

These labels describe provenance; the routes below reflect the accepted reconciliation. Expected callers describe usage. Core enforces [Asset report ownership and administrative boundaries](architecture/system-design.md#identity-and-access). All authenticated consumers may read operational data; a valid key alone does not authorize impersonating an Asset or administering Core. Managed Plugins require no operator-managed API keys.

In the effects column, `create`, `update`, and `delete` mean committed resource changes delivered through `/feed` and `/queries/changed-since`. Failed validation produces no resource change. The initial synchronized resource set is Entities, Tasks, and Objects, following the older design. Plugin discovery/status, operator profiles, settings and key metadata are read through the allowed public endpoints; their notification behavior remains open. Plugin management uses private local interfaces.

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
| `PUT /entities/{entity_id}/task-order` | Tasking clients reorder an Asset's unstarted Tasks | Complete eligible queued Task ID list, expected queue revision, request identity → accepted requested revision/order | Reject stale/conflicting edits; publish requested order without implying Asset adoption | New |
| `POST /entities/{entity_id}/task-order/confirm` | Assigned Asset reports adoption or conflict | Requested revision, report identity, adopted/conflict result and relevant execution facts → requested/confirmed queue state | Record adoption or conflict; older reports cannot confirm newer intent or roll back confirmed order | New |
| `GET /entities/{entity_id}/movement-history` | Consumers inspect retained movement for one Asset or Track | Entity association, from/to, limit/cursor → raw movement sample page with observation/receipt times | None; explicit history read outside the live picture | Adapt: narrow the older history API |
| `GET /entities/{entity_id}/objects` | Interfaces find associated files | Entity ID, pagination → Object metadata page | None | Retain |

Deletion rule retained from the older design: reject Asset deletion while it has nonterminal Tasks. Retain completed Task records and historical Object references after an allowed deletion. Aliases are optional, editable, and unique across all Entity types ignoring case. Store an absent alias as null; relationships use immutable Entity IDs. Entity types never change. Every Geofeature must have valid point, line, or polygon geometry at creation; unfinished drawings remain in the interface. Track geometry is optional, and Assets use telemetry for position. Exact Entity filters remain open.

Core validates components against Protocol-defined schemas and applicability. Entities have no unrestricted `extra` metadata map. Plugins will never define or register components. Required components cannot be removed through an update. Partial updates preserve omitted fields, replace supplied scalars, merge nested fields, and replace arrays completely. Explicit null removes an optional component or clears a nullable field. Validate the entire resulting resource and commit atomically.

Assets author their own reported Entity data; command interfaces send Tasks rather than editing Asset state. Core owns derived communications, heartbeat, timestamps, and versions. Every accepted fresh Asset-originated update refreshes Core-recorded contact, including telemetry patches and status reports. Core-derived changes do not refresh contact. Core verifies the Asset identity on every reporting path, including generic Entity patches; this introduces no operator roles. The precise enrollment, relay-proof and report-ordering fields remain open. Fresh reports establish contact; duplicates and historical backlog do not. Delayed updates cannot overwrite newer component values. Continuous, near-real-time telemetry is expected; exact freshness windows remain open.

The SDK provides Asset registration through `POST /entities`, followed by check-in. Initial data can include descriptive fields, components, and Command support. Before the first report, defaults are operational status `unknown`, communications `offline`, and heartbeat `last_seen: null`. See the [SDK operations catalog](sdk-operations.md). No separate registration or telemetry endpoint is needed. Assets retain stable IDs across restarts. Registration retries use the same Asset ID and request identity; reconnects resume the existing record without overwriting it with startup defaults. Exact deduplication retention, response semantics, and report-ordering fields remain open.

Movement samples are captured from explicitly supplied position, speed and altitude in accepted ordinary Entity reports, in the same transaction as the current-state write. Report retries do not duplicate samples, and unrelated updates do not manufacture measurements. History reads return bounded, stably ordered pages; they preserve the Dataset/Entity association and pagination boundary. Retain samples until Reset, separately from current telemetry and feed recovery. Backfill writes, sample editing, reduced-trail and historical-inspection routes are deferred. See [movement history](architecture/system-design.md#movement-history).

### Asset status

The [Asset status model](asset-status.md) replaces the former execution-session API. Status is part of the Asset's Entity record and is synchronized through the ordinary Entity feed. Operational status and connectivity remain separate, and exceptional interruption requires Task reconciliation. Communication states are `high_bandwidth`, `healthy`, `degraded`, and `offline`, with connection type recorded separately. Degraded/offline takes precedence over high bandwidth. Core derives state from Asset/transport observations and link-specific expectations; initial communications is `offline`. Exact criteria remain open. The operational statuses are `unknown`, `initializing`, `ready`, `busy`, `paused`, `error`, and `stopped`. Assets own queued and immediate Task execution; these reports are not Core scheduling gates.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /entities/{entity_id}/status` | Interfaces and integrations inspect an Asset's condition | Asset ID → status, report times, and reason/details | None | New |
| `PATCH /entities/{entity_id}/status` | Assets and relays report Asset-originated operational status | Asset ID, status/reason/details, version precondition → updated status | `update` Entity and contact; no Task outcome inferred | New |

Status-specific routes apply to Asset Entities. Status supplied through check-in or any permitted Entity patch uses the same validation and transition rules. Command support is reported on the Entity/check-in contract; it is not bound to a public execution-session registration. Plugins are not Assets and expose Operations separately. Mechanics for stale reports, restart reconciliation, and active Tasks remain open and must be settled before execution is implemented.

## Tasks

Task creation assigns one Protocol-defined Command to one Asset and begins in `pending`. Core assigns a permanent increasing submission sequence within that Asset's queue when accepting it. Assignment, Command, input and selected scheduling are immutable. The specified lifecycle is `pending`, `acknowledged`, `in_progress`, `paused`, `cancellation_requested`, `completed`, `failed`, or `cancelled`. Paused requires Asset-confirmed suspension; explicit immediate Resume returns the suspended Task to in progress when it can safely continue. Terminal Tasks are execution records retained until Reset, so there is no generic Task patch or delete endpoint. Interfaces may omit historical Tasks from normal views without deleting them.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /tasks` | Interfaces inspect work | Filters, pagination → Task page | None | Retain |
| `POST /tasks` | Tasking client requests execution | Asset ID, Command, input, supported queued/immediate scheduling, idempotency key → created or previously created Task | `create` Task on first successful request | Retain |
| `GET /tasks/{task_id}` | Interfaces and Assets inspect one execution | Task ID → Task | None | Retain |
| `PATCH /tasks/{task_id}/status` | Tasking clients request cancellation; assigned Assets report lifecycle, progress and outcomes | Task ID, target status or progress-only report, request/report identity and transition-specific fields → authoritative Task | Validate actor/transition; set cancellation_requested on request, cancelled on confirmation; publish accepted changes and contact only for fresh Asset reports | Adapt: unified Task status updates |
| `GET /tasks/{task_id}/objects` | Interfaces inspect associated files | Task ID, pagination → Object metadata page | None | Retain |

Retained lifecycle rules: Task creation validates the local Protocol catalog, Command input, and the Asset's advertised support. Core accepts and retains valid Tasks even when the assigned Asset is offline; their assignment order is preserved until the Asset receives them. Existing unfinished Tasks are unchanged by a loss of connectivity. Assets execute queued Tasks one at a time, oldest submission first by default, subject to confirmed queue reordering. A busy Asset can receive more Tasks. Communication state does not gate Task creation or change Core scheduling behavior; Core is not the Asset scheduler. Repeating an idempotency key with the same request returns the same Task; different tasking data conflicts. Queued work still follows queue order when acknowledgement is omitted. Supported immediate Tasks bypass the queued path and may run alongside it; they remain ordinary tracked Tasks. The first valid terminal transition wins; identical retries are no-ops and conflicting retries fail. A cancellation request does not prove that physical execution stopped. Set `cancellation_requested` and retain execution facts until the assigned Asset confirms `cancelled` or reports another valid outcome. Missing acknowledgement is not proof of non-delivery; confirmation is still required. Cancelling in-progress work depends on declared Asset support. The request alone does not win the terminal-state race. Asset status changes alone do not currently define terminal Task outcomes.

Fresh Asset-originated acknowledgements, starts, progress, and outcomes also update the assigned Asset's Core-recorded contact and publish the corresponding Entity change. Duplicate reports and historical backlog do not refresh contact. Interface-originated Task creation and cancellation do not establish Asset contact. Task lifecycle validation still applies independently of contact freshness.

Core assigns Tasks a permanent increasing submission sequence per Asset in acceptance order. Assigned-work reads return that order by default. Assets fetch the full outstanding list across pages and deduplicate by Task ID. Idempotent retries preserve the original Task and sequence. The Asset reports `acknowledged` when accepting a Task into its local queue and `in_progress` only when execution begins. Exact sequence field encoding remains a schema detail.

Task reordering is agreed for queued Tasks that have not started, including acknowledged Tasks. Submission sequence stays immutable; current queue order is separate. Running and terminal Tasks cannot be moved. Expose requested order separately from the order confirmed by the Asset. A disconnected Asset can continue its last received order. Whole-list edits use expected queue revisions and stable request identities. Assigned Assets report adoption or conflict for a specific requested revision. Follow the [queue revision contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions); exact field encodings and event envelopes remain to be designed.

A scan Task completes only when Core has both the authenticated assigned-Asset completion report and every required ready Object declared by that Asset, in either arrival order. Until then it retains its applicable nonterminal state, including `paused` or `cancellation_requested`, with upload progress detail retained. Uploads may finish after confirmed cancellation without reopening the Task. See [ADR-0008](adr/0008-complete-scan-tasks-when-required-results-are-available.md).

The status endpoint replaces the separate acknowledge/start/progress/complete/fail/cancel endpoints. It is a validated lifecycle operation, not an unrestricted Task patch. A tasking client may request `cancellation_requested`; only the authenticated assigned Asset may report acknowledgement, start, progress, execution outcomes or `cancelled`. Cancellation confirmation identifies the request being confirmed. The SDK retains named helpers where useful, all using this endpoint.

Progress-only reports preserve current status. Acknowledgement/start reports arriving during cancellation can update validated execution facts without replacing `cancellation_requested`. A completion submission can return a nonterminal Task while required Objects are pending. Matching retries have no additional effect; unauthorized transitions and conflicting terminal reports fail. The [Task transition table](adr/0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) governs validation. Request fields, concurrency/report-ordering tokens and error encodings remain schema work.

Immediate Tasks follow Command-specific validity rules and optional execution deadlines checked by the Asset. Older Pause/Resume requests cannot undo newer applied control intent; never-executed superseded or expired requests receive an explicit outcome. An unsafe-to-resume Task reports failure and leaves the Asset paused until a new explicit Resume. Unexpected process restart requires reconciling retained work before execution and holding uncertain work and queued continuation. See [ordering and recovery](adr/0007-reconcile-asset-tasks-after-disconnection.md#control-ordering-and-expiry).

Pause and Resume use `POST /tasks` with their Protocol-defined Commands and immediate scheduling; neither adds a dedicated endpoint. The Asset interrupts current queued work, reports its own `paused` status and the suspended Task's `paused` status, and completes the Pause Task once applied. Resume continues the interrupted Task before remaining queued work, or the Asset reports failure if that Task cannot safely resume. Independent immediate actions such as lights can run alongside movement or while paused without changing the queued path. See [scheduling](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling) and [Pause](adr/0007-reconcile-asset-tasks-after-disconnection.md#pause-through-an-immediate-command).

## Objects

Objects hold arbitrary file types and flexible JSON metadata. Entity references are zero-to-many. Objects also support Task references. References are historical associations, not ownership links that cascade-delete files.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /objects` | Interfaces and integrations list files | Filters, pagination → Object metadata page | None | Retain |
| `POST /objects/upload` | File producers supply content and descriptive metadata | Complete file stream, Dataset-scoped request identity, metadata and associations → ready Object or original success on identical retry | Stream to private staging; publish only complete content; clean up failed staging; restart failed transfers from zero; no overwrite | Adapt: ready-only publication |
| `GET /objects/{object_id}` | Consumers inspect a file record | Object ID → full metadata and associations | None | Retain |
| `PATCH /objects/{object_id}` | Interfaces and integrations edit metadata | Object ID, changed metadata/associations, version precondition → Object | `update` Object metadata | Retain |
| `DELETE /objects/{object_id}` | Interfaces remove an Object | Object ID → no body | `delete` Object; arrange stored-content removal | Retain |
| `GET /objects/{object_id}/download` | Consumers retrieve file content | Object ID → attachment stream | None | Retain |
| `GET /objects/{object_id}/view` | Interfaces preview supported content | Object ID → inline stream, attachment, or unsupported-type error | None | Retain; supported preview formats need review |

Objects are visible through reads, queries and feed only after content and metadata are ready. Upload identity, staged metadata and progress are separate transfer state, not publicly listed Objects. Physical file paths remain private; measured byte size and content type come from the upload process. The earlier metadata-only `POST /objects` route is removed. Descriptive fields and associations may be staged with the upload and edited after publication. The accepted [upload contract](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries) restarts interrupted uploads from the beginning. Resumable transfer sessions, offset queries and chunk-continuation endpoints are deferred. Clean up failed or abandoned staging; it is not a retained operational record. Stable Dataset-scoped request identity recognizes a previously completed upload when its response was lost; concurrent retries cannot publish twice. Conflicting reuse fails. Exact content-equivalence verification remains schema work. After the first successful upload, file content is immutable. Changed content requires a new Object ID; descriptive metadata remains editable. A retry must recognize an already-successful upload without overwriting it. Exact retry identity/content verification, transfer limits, deletion completion, and preview formats remain open. Arbitrary upload types do not imply arbitrary inline rendering.

## Administration

All routes are authenticated. Operator-facing administrative clients may manage the documented configuration and credentials; Asset and Plugin integration identities cannot. Operator profiles remain names/settings rather than permission roles. Plugin configuration and process administration are exclusively local. See [identity and access](architecture/system-design.md#identity-and-access).

### Core configuration and diagnostics

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/config` | Administrative clients inspect Core settings | No body → documented public configuration fields | None | New |
| `PATCH /admin/config` | Administrative clients change supported Core settings | Changed fields, version precondition → configuration and apply requirements | Persist accepted settings; restart/apply rules remain open | New |
| `GET /admin/resources` | Administrative clients inspect service resources | No body → host/process diagnostics | None | Adapt from `/resources` |

The editable Core settings and their application rules must be defined before the configuration write route is implemented. The Plugin save/apply policy is not automatically a policy for Core itself. No generic maintenance or restart endpoint is proposed without a specific operation to support.

### Activity history

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/activity` | Operator administrative clients inspect recorded actions | Actor/action/target/time filters, limit/cursor → activity page with known outcomes | None; read-only, outside the synchronized picture | New |

Record Task issuance/cancellation and Plugin, credential and configuration changes, including local CLI/TUI actions. Core/private management supplies authenticated attribution; public callers cannot insert or alter log entries. A selected profile is not proof of a human actor behind a shared key. Keep safe summaries without secrets or full resource snapshots, deduplicate action retries, and retain until Reset. See the [activity-history contract](architecture/system-design.md#activity-history) for database transactions and process request/outcome recording.

### API keys

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/auth/api-keys` | Administrative clients list keys | Pagination → key metadata, never key secrets | None | Adapt from `/admin/api-keys` |
| `POST /admin/auth/api-keys` | Administrative clients provision a key | Name/description → key metadata and secret returned once | Create an operator administrative key; not an Asset reporting identity | Adapt from `/admin/api-keys` |
| `DELETE /admin/auth/api-keys/{key_id}` | Administrative clients revoke a key | Key ID → no body | Revoke the key | Adapt from `/admin/api-keys/{key_id}` |

These routes require an operator administrative credential, not an Asset or Plugin integration identity; no browser-admin session is selected. Deployment tooling authorizes Asset enrollment; the SDK provisions the bound identity automatically with no per-Asset approval click or manual key-management workflow. The credential/proof mechanism remains to be designed. Bootstrap: local deployment setup provisions the first key outside HTTP and stores it for the operator; subsequent keys use these routes. Recovery after loss or revocation of every key is also a local setup responsibility. Exact setup commands remain open.

### Operator records

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /admin/operators` | Interfaces select or display Operators | Pagination → Operator page | None | New |
| `POST /admin/operators` | Interfaces create a profile | Name and settings → Operator with stable ID | Create profile | New |
| `GET /admin/operators/{operator_id}` | Interfaces load a profile | Operator ID → Operator and settings | None | New |
| `PATCH /admin/operators/{operator_id}` | Interfaces edit a profile | Changed name/settings, version precondition → Operator | Update profile | New |
| `DELETE /admin/operators/{operator_id}` | Interfaces remove a profile | Operator ID → no body | Delete profile; historical attribution policy remains open | New |

Use explicit Operator IDs rather than a `/me` route: an API key does not currently identify a person. Profile selection mechanics remain open; activity records identify the authenticated caller and do not treat a selected profile as proof of human identity. Deleting a profile does not imply deleting operational Entities, Tasks, or Objects.

## Plugins

Plugin installation, catalog selection, configuration, enable/disable, updates, removal and process control use the local CLI/TUI. They have no public endpoints or SDK methods. The public API exposes discovery/status and durable Operations under [ADR-0002](adr/0002-core-manages-installed-plugins.md).

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /plugins` | Consumers discover installed Plugins and capabilities | Pagination → Plugin summary page | None | Adapt: discovery and availability only |
| `GET /plugins/{plugin_id}` | Consumers inspect a Plugin | Plugin ID → release, capabilities, availability and fault status | None; no configuration secrets or management controls | New |
| `POST /plugins/{plugin_id}/operations` | Consumers invoke a declared capability | Capability identifier, input, dataset-scoped submission identity → accepted attempt and outcome URL | Record durable Operation; declared processing may publish operational resources | Adapt: replace request-bound capability invocation |
| `GET /plugins/{plugin_id}/operations` | Consumers list attempts | Filters, pagination → Operation page | None | New |
| `GET /plugins/{plugin_id}/operations/{operation_id}` | Consumers query one attempt | Core-owned attempt ID → status, progress, known outputs and outcome | None | New |
| `POST /plugins/{plugin_id}/operations/{operation_id}/cancel` | Consumers request cancellation | Attempt ID → Operation | Record cancellation request; final outcome requires confirmation | New |

Here `operation_id` identifies one accepted attempt, not a capability definition. Return `202 Accepted` on submission with the attempt identity and query URL. Retries with the same dataset-scoped submission identity recover the existing attempt; a deliberate rerun uses a new identity. Caller disconnection does not cancel work. Failed or interrupted attempts retain known outputs/effects. Terminal outcomes cannot be overwritten; query retained attempts even if the Plugin is later removed, until Reset.

Operations have their own [transition table](adr/0002-core-manages-installed-plugins.md#operation-transitions). Operation transitions remain separate from Task transitions even though both include cancellation-requested intent. Operation polling uses these endpoints in every SDK mode; Operations are outside the initial Entity/Task/Object picture. Live Operation notification details remain open.

Plugins are not taskable Assets. They can create Tasks for Assets through the ordinary Task API, and publish resources through Core using managed integration identity. Stopping a Plugin protects its active Operations under [ADR-0006](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md); unrelated Asset Tasks do not block management. Local management results, saved/active configuration and startup validation belong to that private contract, not the public Plugin resource.

## Synchronization

The SDK exposes resource reads, queries, and feed subscriptions through the same methods in all three modes. HTTP mode passes all three through to Core's API. Full-synchronization mode uses local resource/query results and subscriptions to changes applied to the local picture, with no direct pass-through, fallback, or per-call bypass. The endpoints below are called by HTTP-mode operations or privately by the background synchronizer; full-synchronization application query/feed calls resolve locally. Asset hybrid serves its related subset locally and makes one-off API reads outside that scope without expanding its subscription; its feed describes applied local subset changes. HTTP-mode failures do not fall back to cached data. See [SDK data access](sdk-data-access.md) for scope, freshness, recovery, and open read-policy decisions.

| Method and path | Expected caller / purpose | Input → result | Effects | Basis |
| --- | --- | --- | --- | --- |
| `GET /queries/full` | SDK clients load the operational dataset | Full or Asset scope, per-resource pagination → scoped Entities, Tasks, Objects, continuation cursors and a baseline version | None | Retain |
| `GET /queries/changed-since` | SDK clients recover missed changes | Full or Asset scope, baseline version and cursor → scoped ordered change events and next recovery boundary | None | Retain |
| `GET /feed` | SDK clients subscribe to live changes | WebSocket upgrade, API-key authentication, subscription filters → hello and resource events | Maintain connection/subscriptions; no resource writes | Retain |

Asset hybrid requires matching Core-side scope filters across initial queries, recovery, and feed delivery. Its scope includes the Asset's own Entity, outstanding Tasks and subsequent outcomes, cancellation requests, queue-order changes, and directly referenced Entities/Object metadata needed for those Tasks. Filter before transmission; do not download the full dataset and discard unrelated data locally. Scope is a bandwidth choice, not a read-permission boundary; every authenticated client can still request the full picture. Out-of-scope reads use ordinary API requests without widening the subscription. Exact scope fields, dependency declarations, scope-entry/removal events, and cursor semantics remain to be specified. See [Asset hybrid](sdk-data-access.md#asset-hybrid-mode).

Recovery contract: finish initial dataset pagination, then recover changes since its baseline before treating the dataset as current. The paginated read is not a frozen database snapshot. Keep the baseline stable across its pages; do not substitute the largest version seen in individual resources. On feed reconnect or a version gap, recover through changed-since. If retained history no longer covers the requested version, return an explicit cursor-expired response and require a new initial load. Retention duration and subscription filters remain reviewable.

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
| Concurrent changes | Resource versions and ETags; use `If-Match` to reject stale writes | Which writes require rather than merely accept it |
| Retryable mutations | Stable Asset/request identities for registration retries, Task creation idempotency, Dataset-scoped Operation and upload identities; history capture and action recording deduplicate retries | Identity formats, retention, and exact response behavior |
| Protocol compatibility | Allow declared compatible Core/Asset/SDK versions; explicitly reject unsupported versions and unsupported Asset Commands | Compatibility range advertisement and negotiation fields; catalog lookup remains local |
| Change events | Committed Entity, Task, and Object writes publish versioned changes; identical no-op retries do not create another execution | Administrative/Plugin notifications and retention limits |

## Remaining contract details

1. Define exact request/response schemas, filters, limits, and status codes for the approved routes.
2. Resolve the specific open choices in the shared contract table, including mandatory write preconditions and how supported compatibility ranges are advertised.
3. Specify Task status and queue wire fields, report validation and reconciliation mechanics; specify Pause/Resume report correlation, Command-specific deadlines and recovery evidence under the accepted ordering/reconciliation policies before implementation. Do not reintroduce the removed execution-session API.
4. Define private local management outcomes, Operation envelopes/notification behavior, and whole-file upload retry identity/content-verification details.

## Sources

Route existence was checked against the router, not inferred only from prose. This is a local source review, not a claim that the older service was run or that its current remote state was fetched.

- [Registered routes](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/cmd/atlas_core/main.go).
- [API guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/API_GUIDE.md).
- [Earlier Task contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md); its execution-session design is superseded here by [Asset status](asset-status.md).
- [Object contracts](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md).
- [Historical Object references](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-05-29-object-references-are-historical.md).
- [Plugin design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md).
- [Plugin management](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md).
