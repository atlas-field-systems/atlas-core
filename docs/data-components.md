# Data component catalog

This is the design inventory for resource data and database planning. It lists every named Entity component in the reviewed Atlas Modernization Protocol, the additional data required by our accepted design, and the resource types each belongs to. Assets require `status`, `communications`, and `heartbeat`; Tasks require `status`. These requirements are agreed, as are required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and the typed-storage/validated-JSON approach below. Other component applicability and detailed physical mappings remain proposals for review.

The catalog describes logical data units. A row does not necessarily mean a separate SQL table, and the API can assemble one resource from several tables. Tasks and Objects have structured records and payloads, not the older Entity `components` bag.

## Component applicability

`Required` means every resource of that type must have the component. `Optional` means it may be present and must validate when supplied. `No` means the component does not belong on that resource type in this proposed design. Missing data is not represented by fake measurements, `N/A`, or placeholder component rows.

| Component key | Asset | Track | Geofeature | Task | Object | Contents and purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | Required | No | No | Required | No | Asset operational condition or Task execution lifecycle, with distinct values and transition rules for each resource type |
| `communications` | Required | No | No | No | No | Communication state: high_bandwidth, healthy, degraded, or offline; connection type is recorded separately |
| `heartbeat` | Required | No | No | No | No | Core-recorded last contact; `last_seen: null` before the first report; every accepted fresh Asset-originated update refreshes contact |
| `telemetry` | Optional | Optional | No | No | No | Latitude, longitude, altitude, speed, heading, and observation/update time; stationary Tracks can have a position |
| `health` | Optional | No | No | No | No | Reported system health; the older defined field is battery percentage, not an unlimited health dictionary |
| `geometry` | No | Optional | Required | No | No | Point, line, or polygon geometry; required for zones/rally points on Geofeatures, optional for an observed subject's extent on Tracks |
| `media_refs` | Optional | Optional | Optional | No | No | References to Objects with media roles such as camera feed, thumbnail, or heatmap data |
| `mil_view` | Optional | Optional | Optional | No | No | Display classification/affiliation and observation time; old values include friendly, hostile, neutral, unknown, and civilian |
| `sensor_refs` | Optional | Optional | No | No | No | Sensor ID/type references and optional field-of-view/orientation data |

Nine of the ten named keys in the older `EntityComponents` schema are carried forward. The historical `custom_plugin` association is excluded because Plugins are not Assets; see [ADR-0004](adr/0004-core-owns-commands-and-assets-execute-tasks.md). Decisions and remaining proposals relative to its documented typical usage:

- `status` is required on both Assets and Tasks. Asset status describes operational condition; Task status describes execution lifecycle, detailed below. They do not share one state table. A house Track does not need an Asset's ready/busy lifecycle.
- `communications` and `heartbeat` are required on every Asset. The communication states are `high_bandwidth`, `healthy`, `degraded`, and `offline`. Connection type is separate; degraded/offline takes precedence over high bandwidth. Core derives state from Asset/transport observations and configured link expectations; exact criteria remain open in [Asset status](asset-status.md).
- `geometry` is required when creating a Geofeature. A point uses one position; lines and polygons use lists of points. Unfinished drawings remain in the interface until valid. Track geometry is optional; Assets use telemetry for position.
- All Asset status values and detailed field schemas follow [Asset status](asset-status.md); this catalog does not select new lifecycle values.

### Component definitions

Every supported component must be defined by Protocol, with a schema and declared applicability. Plugins will never define or register components. New components require a Protocol change. The older unrestricted `custom_*` extension pattern is not carried forward.

Flexible Object metadata remains supported separately. Entities have no unrestricted `extra` metadata map. Entity data belongs in Protocol-defined fields and components; flexible file-specific metadata belongs on Objects. Additional Entity data requires named Protocol fields.

## Component updates and Asset authorship

Clients send partial component JSON through the existing Entity routes. There is no separate telemetry-update endpoint. Omitted fields remain unchanged, supplied scalar fields replace their previous values, nested fields merge, and arrays replace completely. Explicit null removes an optional component or clears a nullable field. Required components cannot be removed. Core validates the complete resulting resource and commits the update atomically.

Assets are the source of edits to their own reported Entity data. Command interfaces send Tasks rather than directly editing Asset state. Transport integrations can relay Asset-originated updates; the exact origin and ordering fields remain open. Core verifies the reporting Asset's identity across check-in, component patches and Task reports. Relay proof remains to be specified; a claimed Asset ID alone is insufficient. Core still maintains derived fields such as communications, heartbeat, versions, and timestamps.

Core records receipt time for every accepted fresh Asset-originated update, including partial telemetry updates, status reports, and check-ins. Clients cannot set Core's heartbeat timestamp. Core's own derived changes do not refresh contact. Registration creates the record with initial data; before its first subsequent report, defaults are operational status `unknown`, communications `offline`, and heartbeat `last_seen: null`. Detailed registration and reporting behavior is in the [SDK operations catalog](sdk-operations.md).

Fresh reports establish contact; duplicates and historical backlog do not. Delayed reports never overwrite newer component values. An unchanged measurement in a newly generated report can still establish contact. Fresh Asset-originated Task lifecycle reports also refresh the assigned Asset's heartbeat; interface Task creation/cancellation does not. Continuous, near-real-time telemetry is expected; exact ordering fields and freshness windows remain open.

## Resource fields and payloads

These inventory the resource data units and detail the Task status component listed above. History and upload-retry records follow below; detailed physical schemas remain to be designed. Each resource retains its own field schema.

| Data unit | Applies to | Requiredness | Contents and purpose |
| --- | --- | --- | --- |
| Entity identity | Asset, Track, Geofeature | Required ID/type; alias and subtype may be absent | Immutable ID and type; Asset ID persists across restarts; optional editable alias, unique across all Entity types ignoring case; subtype |
| Resource timestamps/version | All synchronized resource types | Required as defined by each resource envelope | Creation/update times and change ordering; storage version need not occupy the same wire location in every resource |
| `command_manifest` | Asset | Required before accepting supported work; otherwise absent or empty under a defined policy | Advertised subset of Protocol Commands, supported scheduling choices, cancellation/progress support, and descriptions; not the full catalog; queued execution and immediate behavior follow Protocol Commands |
| Task assignment | Task | Required | Task ID, immutable Asset ID, and immutable Command identifier |
| Task scheduling | Task | Required resolved choice at creation | Immutable queued or immediate, allowed by Protocol and Asset support; immediate Tasks are excluded from the reorderable queued path |
| Task submission sequence | Task | Required; assigned by Core | Permanent increasing sequence within the assigned Asset's queue, allocated when Core accepts the Task; determines default relative order of queued Tasks and is unchanged by retries; immediate Tasks retain the sequence without occupying the queued path |
| Task current queue order | Task/Asset queue | Separate from submission sequence; exact representation open | Requested order and Asset-confirmed order for unstarted queued Tasks; started, paused and terminal Tasks cannot move |
| Task `input` | Task | Required | Immutable Command-specific payload validated against its Protocol schema |
| Task `status` | Task | Required | Pending in Core, acknowledged when the Asset accepts it into its local queue, in progress when execution starts, paused on confirmed suspension, cancellation requested while withdrawal is pending, then completed/failed/cancelled |
| Task lifecycle times | Task | Creation/update required; other times depend on state | Acknowledged, started, and finished times corresponding to actual lifecycle events |
| Task `progress` | Task | Optional when supported | Execution progress from 0 through 1 |
| Task `output` | Task | Conditional on Command and completion | Command-defined result validated against that Command's output schema |
| Task `failure` | Task | Required for failed state | Failure code and message |
| Task cancellation request | Task | Present when cancellation is requested | Request identity/details accompanying cancellation_requested status; receipt by Core alone is not confirmed cancellation |
| Task `cancellation` | Task | Required for cancelled state | Confirmed cancellation outcome and details; accepted work waits for the Asset's confirmation |
| Movement sample | Asset, Track | Created only for explicitly supplied movement in an accepted report | Entity association, report/sample identity, observation time when known, Core receipt time, and supplied position/speed/altitude; append-only until Reset; retries deduplicate |
| Object identity/description | Object | Required ID; descriptive fields follow schema | Object ID, type, and usage hints |
| Object storage metadata | Object | Required for a published Object | Public content type and byte size derive from the completed upload; physical storage locations remain private; content is immutable |
| Object `referenced_by` | Object | Zero or more associations | Entity and Task references retained as historical context even when the related record is unavailable |
| Object extension metadata | Object | Optional | Flexible file-specific JSON metadata; does not override storage-owned facts |
| Successful upload identity | Core-private record | Retained for successful uploads until Reset | Dataset-scoped request identity, content-equivalence facts and resulting Object ID; recognizes lost-response retries without another publication |

Task completion follows [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) and [scan result readiness](adr/0008-complete-scan-tasks-when-required-results-are-available.md); a completion report may be retained while required Objects are still uploading. Cancellation requested is a nonterminal status; retain execution facts while waiting for an outcome.

The exact representation of Task progress and timestamps is inherited-schema material to validate during detailed schema authoring. Task status is included in the logical component catalog and remains the Task lifecycle field in its wire representation. Command input/output provides controlled variation without introducing a generic Task `components` bag.

Ready Object metadata and associations synchronize through the feed. Upload staging and progress do not publish incomplete Objects. File bytes remain in object storage and are fetched through the approved content endpoints.

Queued Task reordering is allowed before execution starts, including for acknowledged Tasks. Preserve immutable submission sequence and keep requested queue order distinct from Asset-confirmed order. Running and terminal Tasks cannot be moved. A disconnected Asset may still follow its last received order. The accepted [queue revision contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions) supplies whole-list edits, stale-edit rejection and assigned-Asset adoption/conflict reports. Concrete field encodings remain open.

## Movement history

Current telemetry remains the latest state; the separate sample table preserves reported movement until Reset. Capture only incoming measurements, never copied fields from a merged Entity. Position requires both latitude and longitude; independently supplied speed/altitude are valid. An unchanged position in a fresh report is a sample, but retrying the same report is not another sample. Capture commits with the accepted Entity write. No full Entity snapshots, separate backfill API, historical editing or automatic downsampling is selected.

One paginated history endpoint reads samples for an Entity and time range. History is outside the live operational picture and its bounded recovery log. Query bounds and report rates need measurement before choosing numeric limits. The [movement-history contract](architecture/system-design.md#movement-history) owns retention, reporting and historical-read semantics.

## Administrative records

These are separate resource records, not Entity components or members of the operational-picture synchronization set:

| Record | Data covered |
| --- | --- |
| Operator | Stable ID, name, personal settings, timestamps |
| Authenticated identity | Stable principal ID and kind: operator client, Asset or managed Plugin. Asset identities require a stable bound Asset ID; a claimed ID in a request is not authentication. |
| API key / credential | Credential ID, principal association, descriptive metadata, verifier where applicable, and revocation state. Asset enrollment and Plugin integration identities are provisioned automatically; operators do not manage per-Plugin keys. |
| Plugin | Release identity, installation/enablement/availability, declared configuration schema, saved/active settings, startup-validation state, management result |
| Core settings | Explicitly supported server configuration fields and application requirements |
| Activity record | Stable action identity, authenticated actor/type, action, target, time and known outcome; safe summaries only; retain until Reset |

Activity records cover Task issuance/cancellation and Plugin, credential and configuration changes, including local CLI/TUI actions. Record database changes and their activity together; link process requests to later known outcomes. Do not infer human identity from a selected profile or include secrets. See [activity history](architecture/system-design.md#activity-history).

Their exact field inventory follows the approved endpoints and remains separate from this Entity-component schema. There are no role/permission records implied by these entries.

## Core support records

These Core-owned records support the public contracts; they are not new Entity components and do not require Plugin-defined components.

| Record | Required contents and behavior |
| --- | --- |
| Plugin Operation attempt | Operation ID, Dataset-scoped submission identity, Plugin identity/release/capability, validated input, current lifecycle/progress/timestamps, known outputs and failure/interruption details. Commit acceptance before dispatch. A matching retry retrieves the original attempt; conflicting reuse fails. Retain across Restart and Plugin removal until Reset; no automatic rerun. One current-state row per attempt is sufficient initially; a full progress-event history is not required. |
| Synchronization change | Dataset association, increasing committed sequence, resource type/ID, change kind, and replay data. Include deletion records and enough information for scoped recovery. Commit with the resource mutation; feed delivery and changed-since consume the same committed records. |
| Synchronization retention boundary | Earliest recoverable boundary and latest committed sequence for the Dataset, maintained consistently with pruning. Expired cursors fail explicitly; SDK recovery rebuilds the picture. Retention is bounded and distinct from movement/activity retention until Reset. |
| Asset Task queue | Immutable submission sequence plus requested revision/order and Asset-confirmed revision/order. Preserve revision retry identity and report context; reject stale edits and never mark a newer revision confirmed by an older acknowledgement. |

The [Operation lifecycle](adr/0002-core-manages-installed-plugins.md), [change publication contract](architecture/system-design.md#change-publication) and [queue contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions) own these records' behavior. Physical columns and indexes remain implementation work.

## Agreed storage approach

Use typed storage for identity, status, timestamps, and relationships, with validated JSON for variable payloads such as Command input/output and Object metadata. Every supported component requires a schema. Optional components remain absent when unused; optional scalar fields may be null. Do not store `N/A` or empty component records. A logical component does not automatically require its own SQL table.

### Proposed physical mapping

| Data | Storage direction | Reason |
| --- | --- | --- |
| Entity identity, alias, type, timestamps, version | Typed columns on an Entity table | Stable fields used for lookup, uniqueness, and filtering |
| Asset `status`, `communications`, `heartbeat` | Typed fields in an Asset-state record | All three components are required on Assets; create this record only for Assets |
| `telemetry` and `health` | Typed optional component records when independent reporting/query needs justify them | Validate known numeric fields; avoid making every Entity carry unrelated columns |
| `geometry` | Validated geometry representation; choose physical type/index with spatial query requirements | Supports both defined areas and observed subject extents |
| `mil_view` | Typed optional fields or a typed component record | Small, bounded known structure |
| `media_refs`, `sensor_refs` | Structured association records where querying requires them | References have meaning and schema, not arbitrary strings |
| Task identity, assignment, scheduling, submission sequence, queue order/confirmation, lifecycle, cancellation request, progress, timestamps | Typed columns with constraints | Core relies on these fields to validate lifecycle transitions |
| Authenticated identities and credentials | Typed identity kind, stable Asset binding where required, credential-to-principal association and revocation state | Enforce report ownership independently of caller-supplied IDs; preserve credential setup across Reset without authorizing obsolete-Dataset writes |
| Plugin Operation attempts | Separate typed SQLite rows with unique Dataset/submission identity and validated input/output JSON | Durable acceptance, retry lookup and retained outcomes without a workflow engine |
| Synchronization changes and retention boundary | Private SQLite log, ordered sequence and recoverable-boundary metadata | Atomic resource/change commits, deletion recovery and explicit cursor expiry |
| Asset Task queue revisions | Typed per-Asset requested/confirmed revisions and ordered Task references | Concurrent edits and delayed confirmations cannot silently replace newer intent |
| Task input/output | Protocol-validated JSON in SQLite | Shape depends on the Command |
| Movement samples | Separate typed SQLite rows, indexed by Entity and time with report-identity uniqueness | Preserve sparse observed quantities; page stable history without expanding live Entity JSON |
| Activity records | Separate typed SQLite table with safe bounded detail fields | Query a limited action log; preserve attribution without a full audit framework |
| Successful upload identities | Private Dataset-scoped retry record linked to Object ID | A completed request retry returns the original publication |
| Object identity/storage facts | Typed columns | Core owns storage identity and measured facts |
| Object references | Structured historical associations | Preserve references without cascading deletion of useful evidence |
| Object extension metadata | Validated JSON in SQLite within the Object metadata contract | Keeps variable data flexible without weakening core fields |

The storage approach is agreed; exact tables, columns, and indexes remain proposals and are not implemented. Entity JSON shape does not dictate one SQL row, nor does each logical component require its own table. Historical Object references must not acquire foreign-key deletion behavior that contradicts their accepted semantics.

## Catalog rules for schema generation

For each supported component, record one authoritative definition of:

- Component key and description.
- Applicable resource types and requiredness.
- Field schema, units, bounds, and allowed values.
- Absence/default semantics and any explicit enabled/disabled state.
- Who supplies its values and which values Core derives. These are write semantics, not permission roles.
- Update/merge rules, timestamps, and synchronization behavior.

Record storage mappings and relational constraints separately in private SQL schemas; they are not Protocol component definitions.

Protocol owns public component schemas and applicability; generate API bindings and SDK types from OpenAPI. Private SQL schemas and queries own storage, with sqlc generating typed Go access. Do not generate database tables from public resource models. See [ADR-0016](adr/0016-use-go-sqlite-and-openapi-tooling.md). Core must validate both supplied component shapes and applicability to the resource type, including the final result of a patch. Database constraints should enforce the relational invariants independently. A generator should not automatically create a universal nullable-column table from every possible component property.

Use SQL `NULL` for an optional scalar such as an absent alias. Omit an absent optional component or its row. If a present component can be disabled, represent that condition explicitly rather than erasing its configuration. A required component uses a meaningful defined initial state, not an empty placeholder. Before the first report, communications is `offline` and heartbeat has `last_seen: null`; operational status defaults to `unknown` when no report is available. Do not invent a contact timestamp.

## Source coverage and remaining decisions

Source: Atlas Modernization's locally read commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`.

- [Protocol definitions](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json): `EntityComponents`, all ten component definitions, `CommandManifest`, `TaskResource`, `ObjectResource`, and `ObjectBlob`.
- [Entity component guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/entities.md): typical applicability. The old implementation did not enforce those per-type restrictions.
- [Task model](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md): lifecycle-specific fields and Command-defined input/output.
- [Object metadata](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md): descriptive metadata, storage-owned fields, and associations.

Before authoring database tables, review remaining applicability proposals, settle Command declaration requirements, and choose detailed physical mappings based on the reads and writes we need. No additional named components are assumed to exist merely because the older wildcard could accept them.
