# Data component catalog

This is the design inventory for resource data and database planning. It lists every named Entity component in the reviewed Atlas Modernization Protocol, the additional data required by our accepted design, and the resource types each belongs to. Assets require `status`, `communications`, and `heartbeat`; Tasks require `status`. These requirements are agreed, as are required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and the typed-storage/validated-JSON approach below. Other component applicability and detailed physical mappings remain proposals for review.

The catalog describes logical data units. A row does not necessarily mean a separate SQL table, and the API can assemble one resource from several tables. Tasks and Objects have structured records and payloads, not the older Entity `components` bag.

## Component applicability

`Required` means every resource of that type must have the component. `Optional` means it may be present and must validate when supplied. `No` means the component does not belong on that resource type in this proposed design. Missing data is not represented by fake measurements, `N/A`, or placeholder component rows.

| Component key | Asset | Track | Geofeature | Task | Object | Contents and purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | Required | No | No | Required | No | Asset operational condition or Task execution lifecycle, with distinct values and transition rules for each resource type |
| `communications` | Required | No | No | No | No | Core-derived [Communication state](topics/asset-reporting.md#communication-state); connection type is recorded separately |
| `heartbeat` | Required | No | No | No | No | Core-recorded [Contact](topics/asset-reporting.md#contact-and-freshness) as `last_seen` |
| `telemetry` | Optional | Optional | No | No | No | Latitude, longitude, altitude, speed, heading, and observation/update time; stationary Tracks can have a position |
| `health` | Optional | No | No | No | No | Reported system health; the older defined field is battery percentage, not an unlimited health dictionary |
| `geometry` | No | Optional | Required | No | No | Point, line, or polygon geometry; required for zones/rally points on Geofeatures, optional for an observed subject's extent on Tracks |
| `media_refs` | Optional | Optional | Optional | No | No | References to Objects with media roles such as camera feed, thumbnail, or heatmap data |
| `mil_view` | Optional | Optional | Optional | No | No | Display classification/affiliation and observation time; old values include friendly, hostile, neutral, unknown, and civilian |
| `sensor_refs` | Optional | Optional | No | No | No | Sensor ID/type references and optional field-of-view/orientation data |

Nine of the ten named keys in the older `EntityComponents` schema are carried forward. The historical `custom_plugin` association is excluded because Plugins are not Assets; see [ADR-0004](adr/0004-core-owns-commands-and-assets-execute-tasks.md). Decisions and remaining proposals relative to its documented typical usage:

- `status` is required on both Assets and Tasks. On an Asset it holds Operational status; Task status describes execution lifecycle, detailed below. They do not share one state table. A house Track does not need an Asset's ready/busy lifecycle.
- `communications` and `heartbeat` are required on every Asset; their values and derivation follow [Asset reporting](topics/asset-reporting.md).
- `geometry` is required when creating a Geofeature under [Geofeature geometry](topics/tracks-and-geofeatures.md#geometry).
- Operational status values follow [Asset reporting](topics/asset-reporting.md#operational-status); this catalog does not select new lifecycle values.

### Component definitions

Every supported component is defined by Protocol, with no Plugin-defined components and no unrestricted Entity `extra` map, under [Components](topics/tracks-and-geofeatures.md#components). Flexible Object metadata remains supported separately.

## Component updates and Asset authorship

Component updates, Asset authorship, Contact and initial values follow [Asset reporting](topics/asset-reporting.md), including its [partial component update rules](topics/asset-reporting.md#partial-component-updates). Track observations follow [one publisher per Track](topics/tracks-and-geofeatures.md#one-publisher-per-track).

## Resource fields and payloads

These inventory the resource data units and detail the Task status component listed above. History and upload-retry records follow below; detailed physical schemas remain to be designed. Each resource retains its own field schema.

| Data unit | Applies to | Requiredness | Contents and purpose |
| --- | --- | --- | --- |
| Entity identity | Asset, Track, Geofeature | Required ID/type; alias and subtype may be absent | Immutable ID and type, optional Alias and subtype; Asset ID persists across restarts. See [Entity types and identity](topics/tracks-and-geofeatures.md#entity-types-and-identity) |
| Asset retirement condition | Asset | Core-owned administrative condition | Published with the Entity, separate from reported operational status; see [Asset retirement](topics/identity-and-access.md#asset-retirement) |
| Resource timestamps/version | All synchronized resource types | Required as defined by each resource envelope | Creation/update times and change ordering; storage version need not occupy the same wire location in every resource |
| `command_manifest` | Asset | Required before accepting supported work; otherwise absent or empty under a defined policy | Asset-reported subset of Protocol Commands, supported scheduling choices, cancellation/progress support, and descriptions; not the full catalog; supplied only by the Asset at registration and check-in; see [Command support](topics/tasks.md#command-support) |
| Task creation identity | Task | Required for retryable creation | Dataset-scoped idempotency key, canonical immutable request facts including Asset, Command, input, scheduling and validity/deadline, and resulting Task ID under a uniqueness constraint; insert atomically with Task/submission sequence, retain across Restart until Reset, reject conflicting reuse |
| Task assignment | Task | Required | Task ID, immutable Asset ID, and immutable Command identifier |
| Task scheduling | Task | Required resolved choice at creation | Immutable queued or immediate, with Command validity rules and an optional execution deadline; see [scheduling](topics/tasks.md#queued-and-immediate-scheduling) |
| Task submission sequence | Task | Required; assigned by Core | Permanent increasing per-Asset sequence allocated when Core accepts the Task; see [submission sequence](topics/tasks.md#submission-sequence) |
| Task current queue order | Task/Asset queue | Separate from submission sequence; exact representation open | Requested order and Asset-confirmed order for eligible unstarted queued Tasks; see [queue revisions](topics/tasks.md#queue-revisions) |
| Task `input` | Task | Required | Immutable Command-specific payload validated against its Protocol schema; Geofeature references follow [live geometry](topics/tasks.md#live-geofeature-geometry) |
| Task `status` | Task | Required | One of the [Task statuses](topics/tasks.md#task-status-and-transitions), from pending through completed, failed or cancelled |
| Task control/recovery facts | Task/Asset | Present when applicable | Applied Pause/Resume ordering and report correlation, expiry/supersession outcomes and evidence for reconciling retained work; exact representation and stale-process proof remain engineering work |
| Task lifecycle times | Task | Creation/update required; other times depend on state | Acknowledged, started, and finished times corresponding to actual lifecycle events |
| Task `progress` | Task | Optional when supported | Execution progress from 0 through 1 |
| Task `output` | Task | Conditional on Command and completion | Command-defined result validated against that Command's output schema |
| Task `failure` | Task | Required for failed state | Failure code and message |
| Task cancellation request | Task | Present when cancellation is requested | Request identity/details accompanying cancellation_requested status, and any decline; see [cancellation requests](topics/tasks.md#cancellation-requests) |
| Task `cancellation` | Task | Required for cancelled state | Confirmed cancellation outcome and details |
| Movement sample | Asset, Track | Created only for explicitly supplied movement in an accepted report | Entity association, report/sample identity, observation time when known, Core receipt time, and supplied position/speed/altitude; append-only until Reset; retries deduplicate |
| Object identity/description | Object | Required ID; descriptive fields follow schema | SDK-allocated Object ID known before upload, type, and usage hints |
| Object storage metadata | Object | Required for a published Object | Public content type and byte size derive from the completed upload; physical storage locations remain private; content is immutable; missing content sets a per-Object [integrity flag](topics/objects.md#storage-quota-and-integrity-faults) |
| Object `referenced_by` | Object | Zero or more associations | Entity and Task references retained as historical context even when the related record is unavailable |
| Object extension metadata | Object | Optional | Flexible file-specific JSON metadata; does not override storage-owned facts |
| Successful upload identity | Core-private record | Retained for successful uploads until Reset | Dataset-scoped request identity, canonical upload facts including supplied Object ID and content equivalence, resulting publication and deletion marker; behavior follows [retries after a lost response](topics/objects.md#retries-after-a-lost-response) |

Task completion, including a completion report retained while required Objects upload, follows [scan completion](topics/tasks.md#scan-completion).

The exact representation of Task progress and timestamps is inherited-schema material to validate during detailed schema authoring. Task status is included in the logical component catalog and remains the Task lifecycle field in its wire representation. Command input/output provides controlled variation without introducing a generic Task `components` bag.

Only ready Object metadata and associations synchronize through the feed; file bytes are fetched through the content endpoints under [Objects](topics/objects.md#ready-only-visibility).

Queued Task reordering, requested and confirmed order and adoption reports follow [queue revisions](topics/tasks.md#queue-revisions). Concrete field encodings remain open.

## Movement history

Current telemetry remains the latest state; the separate sample table preserves reported movement until Reset. Capture only incoming measurements, never copied fields from a merged Entity. Position requires both latitude and longitude; independently supplied speed/altitude are valid. An unchanged position in a fresh report is a sample, but retrying the same report is not another sample. Capture commits with the accepted Entity write. No full Entity snapshots, separate backfill API, historical editing or automatic downsampling is selected.

One paginated history endpoint reads samples for a live or deleted Asset/Track ID and time range, resolving retained identity/kind records and marking deleted Entities. IDs never present in the current Dataset return not found; empty intervals return empty pages. History is outside the live operational picture and its bounded recovery log. Query bounds and report rates need measurement before choosing numeric limits. The [movement-history contract](architecture/system-design.md#movement-history) owns retention, reporting and historical-read semantics.

## Required-result protection

Tasks retain accepted assigned-Asset declarations of required Object references, including before upload; their protection follows [Required-result protection](topics/objects.md#required-result-protection).

## Administrative records

These are separate resource records, not Entity components or members of the operational-picture synchronization set:

| Record | Data covered |
| --- | --- |
| Operator | Stable ID, name, personal settings, timestamps; retained installation setup across Restart and ordinary Reset; cleared by Hard Reset or explicit profile deletion |
| Authenticated identity | Stable principal ID and kind: operator client, Asset, managed Plugin or gateway; Asset identities carry their bound Asset ID. Permissions follow [callers and permissions](topics/identity-and-access.md#callers-and-permissions). |
| API key / credential | Credential ID, principal association, descriptive metadata, verifier where applicable, and revocation state. Provisioning and revocation follow [credentials](topics/identity-and-access.md#credentials). |
| Plugin | Release identity, installation/enablement/availability, declared configuration schema, saved/active settings, startup-validation state, management result |
| Core settings | Explicitly supported server configuration fields and application requirements |
| Activity record | Stable action identity, retained authenticated actor ID/type and safe historical display context, action, target, time and known outcome; profile/credential deletion does not erase attribution; safe summaries only; retain until Reset |

Activity records cover Task issuance/cancellation, Asset retirement and Plugin, credential and configuration changes, including local CLI/TUI actions. Record database changes and their activity together; link process requests to later known outcomes. Do not infer human identity from a selected profile or include secrets. See [activity history](architecture/system-design.md#activity-history).

Their exact field inventory follows the approved endpoints and remains separate from this Entity-component schema. There are no role/permission records implied by these entries.

## Core support records

These Core-owned records support the public contracts; they are not new Entity components and do not require Plugin-defined components.

| Record | Required contents and behavior |
| --- | --- |
| Dataset metadata | Current Dataset ID, writing Core release and the Reset identity that established it, initialized on first use or Reset and retained across same-release Restart. Start checks the writing release before serving data; a mismatch refuses startup and requires explicit update/Reset. |
| Asset registration identity | Dataset-scoped request ID, stable Asset ID, authenticated enrollment-principal binding, canonical initial request facts and resulting Entity/credential association, retained across Restart until Reset. Behavior follows [registration retries](topics/identity-and-access.md#registration-retries). |
| Asset retirement identity | Dataset-scoped request identity, target Asset ID, canonical original retirement parameters and recorded retired result, retained across Restart until Reset. Behavior follows [retirement retries](topics/identity-and-access.md#retirement-retries). |
| API-key creation identity | Installation-scoped creation ID, authenticated administrative principal, canonical initial metadata, secret verifier and resulting key ID/revocation state, retained until Hard Reset. Never retain plaintext secrets in this record. Behavior follows [API keys](topics/identity-and-access.md#api-keys). |
| Asset principal binding | Installation-scoped unique Asset ID to authenticated principal binding, its deletion or retirement denial and whether the identity was enrolled under Open enrollment, retained until Hard Reset. Behavior follows [retained Asset identity](topics/identity-and-access.md#retained-asset-identity-after-reset). |
| Entity identity reservation | Dataset-scoped Entity ID and original kind with a retained deletion marker, retained across Restart until Reset. Behavior follows [Entity ID reservation](topics/tracks-and-geofeatures.md#entity-id-reservation). |
| Asset report acceptance | Entities owns the [shared Asset report acceptance](architecture/system-design.md#shared-asset-report-acceptance) records: Core-private accepted report identities, process generations and ordering boundaries sufficient to reject duplicates and obsolete reports across check-in, component/status patches, Task lifecycle reports and queue adoption/conflict reports. Commit with affected state, contact and movement records; retain across Restart until Reset. Exact ordering scope and wire fields remain schema work; a full packet log is not required. |
| Track publisher assignment | One publisher identity responsible for a Track's observed fields, with the association needed for same-Dataset continuity. Behavior follows [Tracks](topics/tracks-and-geofeatures.md#tracks); exact fields remain schema work. |
| Plugin Operation | Operation ID, Dataset-scoped submission identity, Plugin identity/release/capability, validated input, current lifecycle/progress/timestamps, known outputs and failure/interruption details. Commit acceptance before dispatch. A matching retry retrieves the original Operation; conflicting reuse fails. Retain across Restart and Plugin removal until Reset; no automatic rerun. One current-state row per Operation is sufficient initially; a full progress-event history is not required. |
| Synchronization change | Dataset association, increasing committed sequence, resource type/ID, change kind, and replay data. Include deletion records and enough information for full-picture recovery. Commit with the resource mutation; feed delivery and changed-since consume the same committed records. Per-Asset synchronization coverage is deferred under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). |
| Synchronization retention boundary | Earliest recoverable boundary and latest committed sequence for the Dataset, maintained consistently with pruning. Expired cursors fail explicitly; SDK recovery rebuilds the picture. Retention is bounded and distinct from movement/activity retention until Reset. |
| Asset Task queue | Immutable submission sequence plus requested revision/order and Asset-confirmed revision/order. Preserve revision retry identity and report context; reject stale edits and never mark a newer revision confirmed by an older acknowledgement. |
| Required-result hold | Objects-private hold binding a declared Object ID to the Task whose accepted declaration requires it, placed in the declaration's commit and retained until Reset. Placing a hold reports which held Objects are already published; deletion checks holds without calling Tasks; publication reports the Tasks whose holds it satisfies. The [collaboration](architecture/system-design.md#object-publication-and-recovery-ownership) owns this behavior. |
| Local activity journal | Installation-mount file of local management actions taken while Core is stopped, keyed by action identity with the accepted request or known outcome. Imported idempotently when the retained Dataset or a new installation's first Dataset opens; deleted by the host during Reset before Core starts, and by Hard Reset. Not an SQLite table. |

The [Operation lifecycle](adr/0002-core-manages-installed-plugins.md), [change publication contract](architecture/system-design.md#change-publication), [queue contract](topics/tasks.md#queue-revisions), [Asset report acceptance](architecture/system-design.md#shared-asset-report-acceptance) and [activity history](architecture/system-design.md#activity-history) own these records' behavior. Registration, Asset retirement, Task creation, upload, Operation, queue-edit, cancellation-request and API-key creation identities share the [retry identity](architecture/system-design.md#retry-identity) mechanism while keeping their own facts and retention. Core's SQLite records live in one database grouped by Dataset or installation lifetime under [write commits](architecture/system-design.md#write-commits). Physical columns and indexes remain implementation work.

## Plugin private storage

[ADR-0021](adr/0021-manage-plugin-operational-storage-through-reset.md) gives each Plugin an Atlas-managed operational directory for working files and, when needed, its own private SQLite database. The Plugin owns the contents and schema. These are not Core tables, public resources or mounts of Core's database and Object store.

Operational working state survives Restart and is cleared by Reset. Plugin settings, credentials and reference data belong to retained installation setup; Hard Reset clears both lifetimes. Uninstall stops the Plugin and clears its private operational work, saved configuration, usable credentials, downloaded reference data and owned installation artifacts; reinstall starts with empty work and fresh setup. Public resources and recorded Operations retain their own lifecycle, while disabling preserves the installation and private work. The host coordinator owns stopped-writer cleanup under the [Plugin storage ADR](adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall). Buffered outputs and pending work belong to their original Dataset and cannot be relabeled or republished into the replacement Dataset. Keeping private work does not authorize automatic rerun of an interrupted Operation.

## Agreed storage approach

Use typed storage for identity, status, timestamps, and relationships, with validated JSON for variable payloads such as Command input/output and Object metadata. Every supported component requires a schema. Optional components remain absent when unused; optional scalar fields may be null. Do not store `N/A` or empty component records. A logical component does not automatically require its own SQL table.

### Proposed physical mapping

| Data | Storage direction | Reason |
| --- | --- | --- |
| Entity identity, alias, type, timestamps, version | Typed columns on an Entity table | Stable fields used for lookup, uniqueness, and filtering |
| Asset registration identities | Private Dataset/request uniqueness with immutable original request facts and Entity/credential association | Lost-response retries remain recognizable after later Asset updates or Restart |
| Asset retirement identities | Private Dataset/request uniqueness with original target/parameter facts and recorded result/deletion marker | Retried retirement does not repeat activity or restore a deleted Entity; Reset clears the claim, not the installation denial |
| API-key creation identities | Private installation/creation uniqueness, canonical metadata and credential-verifier association | Lost-response retries cannot create extra keys or reactivate revoked keys; retained with installation setup |
| Entity identity reservations | Private Dataset/Entity ID uniqueness with a retained deletion marker | Deleted IDs cannot be reused or attach retained history to another Entity |
| Track publisher assignment | Typed publisher-to-Track relationship with the publisher's observed-field responsibility and same-Dataset continuity | Preserve publisher ownership and keep descriptive edits separate; publisher transfers are deferred under [publisher transfers](topics/tracks-and-geofeatures.md#publisher-transfers). Exact source and correction-correlation fields remain schema work |
| Asset report acceptance state | Private per-Asset identities and ordering boundaries, with per-component/report-stream detail as required by the ordering contract | Restart cannot let duplicate or delayed traffic refresh contact or overwrite newer state |
| Asset retirement condition | Core-owned field in Asset state, separate from reported components | Publish administrative retirement without changing operational status or Task outcomes |
| Asset `status`, `communications`, `heartbeat` | Typed fields in an Asset-state record | All three components are required on Assets; create this record only for Assets |
| `telemetry` and `health` | Typed optional component records when independent reporting/query needs justify them | Validate known numeric fields; avoid making every Entity carry unrelated columns |
| `geometry` | Validated geometry representation; choose physical type/index with spatial query requirements | Supports both defined areas and observed subject extents |
| `mil_view` | Typed optional fields or a typed component record | Small, bounded known structure |
| `media_refs`, `sensor_refs` | Structured association records where querying requires them | References have meaning and schema, not arbitrary strings |
| Task identity, assignment, scheduling, submission sequence, queue order/confirmation, lifecycle, cancellation request, progress, timestamps | Typed columns with constraints | Core relies on these fields to validate lifecycle transitions |
| Authenticated identities and credentials | Typed identity kind, unique installation-scoped Asset ID/principal binding and retirement denial retained until Hard Reset, credential-to-principal association and revocation state | Enforce report ownership independently of caller-supplied IDs; preserve credential setup across Reset without authorizing obsolete-Dataset writes |
| Plugin Operations | Separate typed SQLite rows with unique Dataset/submission identity and validated input/output JSON | Durable acceptance, retry lookup and retained outcomes without a workflow engine |
| Synchronization changes and retention boundary | Private SQLite log, ordered sequence and recoverable-boundary metadata | Atomic resource/change commits, deletion recovery and explicit cursor expiry |
| Asset Task queue revisions | Typed per-Asset requested/confirmed revisions and ordered Task references | Concurrent edits and delayed confirmations cannot silently replace newer intent |
| Dataset metadata | Private singleton SQLite record for Dataset ID, writing Core release and the establishing Reset identity | Preserve Reset/release boundaries; let Start tell an established Reset directive from a pending one; no metadata-only startup overwrite or silent migration |
| Task creation identities | Dataset/key uniqueness with canonical request facts and Task ID, committed with the Task | Lost-response retries and same-release Restart cannot duplicate an execution |
| Task input/output | Protocol-validated JSON in SQLite | Shape depends on the Command |
| Movement samples | Separate typed SQLite rows, indexed by Entity and time with report-identity uniqueness | Preserve sparse observed quantities; page stable history without expanding live Entity JSON |
| Activity records | Separate typed SQLite table with safe bounded detail fields | Query a limited action log; preserve attribution without a full audit framework |
| Successful upload identities | Private Dataset-scoped retry record with supplied Object ID, original canonical facts and retained deletion marker | A completed request retry returns the existing Object or explicit deleted-result outcome |
| Object identity/storage facts | Typed columns | Core owns storage identity and measured facts |
| Object references | Structured historical associations; Task-required references may precede Object publication | [Required-result protection](topics/objects.md#required-result-protection) independent of mutable metadata; preserve history without cascading deletion |
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

Use SQL `NULL` for an optional scalar such as an absent alias. Omit an absent optional component or its row. If a present component can be disabled, represent that condition explicitly rather than erasing its configuration. A required component uses a meaningful defined initial state, not an empty placeholder. Asset reporting components start with their [initial values](topics/asset-reporting.md#components-and-initial-values).

## Source coverage and remaining decisions

Source: Atlas Modernization's locally read commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`.

- [Protocol definitions](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json): `EntityComponents`, all ten component definitions, `CommandManifest`, `TaskResource`, `ObjectResource`, and `ObjectBlob`.
- [Entity component guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/entities.md): typical applicability. The old implementation did not enforce those per-type restrictions.
- [Task model](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md): lifecycle-specific fields and Command-defined input/output.
- [Object metadata](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/database-structure/objects.md): descriptive metadata, storage-owned fields, and associations.

Before authoring database tables, review remaining applicability proposals, settle Command declaration requirements, and choose detailed physical mappings based on the reads and writes we need. No additional named components are assumed to exist merely because the older wildcard could accept them.
