# Data component catalog

This is the design inventory for resource data and database planning. It lists every named Entity component in the reviewed Atlas Modernization Protocol, the additional data required by our accepted design, and the resource types each belongs to. Assets require `status`, `communications`, and `heartbeat`; Tasks require `status`. These requirements are agreed, as are required Geofeature geometry, immutable Entity types, alias rules, Protocol-only component definitions, and the typed-storage/validated-JSON approach below. Other component applicability and detailed physical mappings remain proposals for review.

The catalog describes logical data units. A row does not necessarily mean a separate SQL table, and the API can assemble one resource from several tables. Tasks and Objects have structured records and payloads, not the older Entity `components` bag.

S1 freezes the Asset component surface to required `status`, `communications` and `heartbeat`, plus optional `telemetry` for position, speed, altitude and heading. Identity, Alias, Command support and Task records retain their separate contracts. S1 does not need `health`/battery, `sensor_refs`, `mil_view` or `media_refs`; their broader applicability remains deferred. Telemetry timestamps follow [Asset reporting](topics/asset-reporting.md#shared-report-context), with no SDK clock-offset estimator.

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
| `task_queue` | Asset; owned by Tasks | Required, including an empty queue; Core-derived | Requested and confirmed evidence, aggregate revision and reported active/suspended work; see [queue representation](topics/tasks.md#queue-representation-and-coherent-reads) |
| Task `input` | Task | Required | Immutable Command-specific payload validated against its Protocol schema; Geofeature references follow [live geometry](topics/tasks.md#live-geofeature-geometry) |
| Task `status` | Task | Required | One of the [Task statuses](topics/tasks.md#task-status-and-transitions), from pending through completed, failed or cancelled |
| Task control/recovery facts | Task/Asset | Present when applicable | Applied Pause/Resume ordering and report correlation, expiry/supersession outcomes and evidence for reconciling retained work; shared authority follows [process replacement](topics/asset-reporting.md#process-authority-establishment-and-replacement) |
| Task lifecycle times | Task | Creation/update required; other times depend on state | Acknowledged, started, and finished times corresponding to actual lifecycle events |
| Task `progress` | Task | Optional when supported | Execution progress from 0 through 1 |
| Task `output` | Task | Conditional on Command and completion | Command-defined result validated against that Command's output schema |
| Task `failure` | Task | Required for failed state | Failure code and message |
| Task cancellation request | Task | Present when cancellation is requested | Request identity/details accompanying cancellation_requested status, and any decline; see [cancellation requests](topics/tasks.md#cancellation-requests) |
| Task `cancellation` | Task | Required for cancelled state | Confirmed cancellation outcome and details |
| Movement sample | Asset, Track | Created only for previously unrecorded explicitly supplied movement in an accepted report | Entity/sample identity, original per-quantity evidence/correction correlation and observation timing, Core receipt time, and supplied position/speed/altitude under [movement history](topics/history.md#movement-history) |
| Object identity/description | Object | Required ID; descriptive fields follow schema | SDK-allocated Object ID known before upload, type, and usage hints |
| Object storage metadata | Object | Required for a published Object | Public content type and byte size derive from the completed upload; physical storage locations remain private; content is immutable; missing content sets a per-Object [integrity flag](topics/objects.md#storage-quota-and-integrity-faults) |
| Object `referenced_by` | Object | Zero or more associations | Entity and Task references retained as historical context even when the related record is unavailable |
| Object extension metadata | Object | Optional | Flexible file-specific JSON metadata; does not override storage-owned facts |
| Successful upload identity | Core-private record | Retained for successful uploads until Reset | Dataset-scoped request identity, canonical upload facts including supplied Object ID and content equivalence, resulting publication and deletion marker; behavior follows [retries after a lost response](topics/objects.md#retries-after-a-lost-response) |

Task completion and independently appended result declarations follow [scan completion](topics/tasks.md#scan-completion).

The exact representation of Task progress and timestamps is inherited-schema material to validate during detailed schema authoring. Task status is included in the logical component catalog and remains the Task lifecycle field in its wire representation. Command input/output provides controlled variation without introducing a generic Task `components` bag.

Only ready Object metadata and associations synchronize through the feed; file bytes are fetched through the content endpoints under [Objects](topics/objects.md#ready-only-visibility).

Queued Task reordering, requested and confirmed order and adoption reports follow [queue representation](topics/tasks.md#queue-representation-and-coherent-reads).

## Movement history

Movement samples are stored separately from current telemetry; capture, retention and the history read follow [movement history](topics/history.md#movement-history).

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
| Core settings | Locally inspected and edited server configuration fields and application requirements under [Core configuration](topics/dataset-lifecycle.md#core-configuration); no public configuration resource |
| Activity record | Stable action identity, authenticated actor ID/type and safe display context, action, target, time and known outcome, under [record contents and attribution](topics/history.md#record-contents-and-attribution) |

What activity records cover and how they are recorded follow [Activity history](topics/history.md#activity-history).

Public records follow the approved endpoints; Core settings and private Plugin management records follow their local-management contracts. Their field inventories remain separate from this Entity-component schema. There are no role/permission records implied by these entries.

## Core support records

These Core-owned records support the public contracts; they are not new Entity components and do not require Plugin-defined components.

| Record | Required contents and behavior |
| --- | --- |
| Dataset metadata | Current Dataset ID, writing Core release and the Reset identity that established it, initialized on first use or Reset and retained across same-release Restart. Behavior follows [Dataset identity](topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary) and [release mismatch](topics/dataset-lifecycle.md#release-mismatch-and-release-updates). |
| Asset registration identity | Dataset-scoped request ID, stable Asset ID, authenticated enrollment-principal binding, canonical initial request facts and resulting Entity/credential association, retained across Restart until Reset. Behavior follows [registration retries](topics/identity-and-access.md#registration-retries). |
| Asset retirement identity | Dataset-scoped request identity, target Asset ID, canonical original retirement parameters and recorded retired result, retained across Restart until Reset. Behavior follows [retirement retries](topics/identity-and-access.md#retirement-retries). |
| API-key creation identity | Installation-scoped creation ID, authenticated administrative principal, canonical initial metadata, secret verifier and resulting key ID/revocation state, retained until Hard Reset. Never retain plaintext secrets in this record. Behavior follows [API keys](topics/identity-and-access.md#api-keys). |
| Asset principal binding | Installation-scoped unique Asset ID to authenticated principal binding, its denial after deletion, retirement or Open enrollment cleanup and its immutable enrollment provenance, retained until Hard Reset. Behavior follows [retained Asset identity](topics/identity-and-access.md#retained-asset-identity-after-reset). |
| Entity identity reservation | Dataset-scoped Entity ID and original kind with a retained deletion marker, retained across Restart until Reset. Behavior follows [Entity ID reservation](topics/tracks-and-geofeatures.md#entity-id-reservation). |
| Asset report acceptance | Entities-owned private identities, process generations, original evidence and ordering boundaries under [shared report context](topics/asset-reporting.md#shared-report-context). Commit with affected state, Contact and movement records; retain across Restart until Reset. A full packet log is not required. |
| Track publisher assignment | One publisher owns a Track's observed fields through the installation binding in [publisher continuity](topics/identity-and-access.md#publisher-continuity); Dataset observations and corrections use [per-quantity identity and time](topics/tracks-and-geofeatures.md#observation-identities-ordering-and-time). |
| Plugin Operation | Operation ID, Dataset-scoped submission identity, Plugin identity/release/capability, validated input, current lifecycle/progress/timestamps, known outputs, failure/interruption details and any separate [Recovered outcome](topics/plugins.md#recovered-outcomes) with its typed result/error. Acceptance, retries and retention follow [Operations](topics/plugins.md#operations). One current-state row per Operation is sufficient initially; a full progress-event history is not required. |
| Synchronization change | Bounded complete commit records with final resource images or deletions and versions under [synchronization wire](topics/sdk.md#synchronization-wire-and-application-boundary); commit atomically with mutations for feed and HTTP changed-since. Per-Asset coverage remains deferred under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). |
| Temporary synchronization capture | Synchronization-owned logical state with Dataset/caller and Core-run binding, stable handle, captured boundary and immutable pages, continuation references, advertised expiry, release/expiry state and budget accounting under [snapshot recovery](topics/sdk.md#snapshot-lifetime-and-recovery); bounded in-run receipts include allocation context/load ID, original request facts and pending/ended outcome under [allocation retries](topics/sdk.md#snapshot-allocation-retries). Physical storage remains S4 engineering work, with no durable cross-Restart capture requirement. |
| Synchronization retention boundary | Earliest recoverable boundary and latest committed sequence for the Dataset, maintained consistently with pruning. Expired cursors fail explicitly; SDK recovery rebuilds the picture. Retention is bounded and distinct from movement/activity retention until Reset. |
| Asset Task queue | Tasks-owned requested/confirmed state and reported active/suspended work, projected as the Asset's complete `task_queue` under [queue representation](topics/tasks.md#queue-representation-and-coherent-reads). |
| Required-result hold | Objects-private Object/Task protection placed atomically with an accepted declaration and retained until Reset. Deletion checks holds without calling Tasks; publication has no Task outcome effect under [Object collaboration](architecture/system-design.md#object-publication-and-recovery-ownership). |
| Local management action | Host-manager durable JSON identity, phase and establishment evidence outside the cleanup tree under [owned storage and durable actions](topics/dataset-lifecycle.md#owned-storage-and-durable-actions). Separate from Core's Dataset and activity journal. |
| Local activity journal | Installation-mount file of local management actions taken while Core is stopped, keyed by action identity. Not an SQLite table. Import and deletion follow [local actions](topics/history.md#local-actions). |

The [Operation lifecycle](topics/plugins.md#operation-transitions), [change publication contract](architecture/system-design.md#change-publication), [queue contract](topics/tasks.md#queue-revisions), [Asset report acceptance](architecture/system-design.md#shared-asset-report-acceptance) and [Activity history](topics/history.md#activity-history) own these records' behavior. Registration, Asset retirement, Task creation, upload, Operation, queue-edit, cancellation-request and API-key creation identities share the [retry identity](architecture/system-design.md#retry-identity) mechanism while keeping their own facts and retention. Core's SQLite records live in one database grouped by Dataset or installation lifetime under [write commits](architecture/system-design.md#write-commits). Physical columns and indexes remain implementation work.

## Plugin private storage

[ADR-0021](adr/0021-manage-plugin-operational-storage-through-reset.md) gives each Plugin an Atlas-managed operational directory for working files and, when needed, its own private SQLite database. The Plugin owns the contents and schema. These are not Core tables, public resources or mounts of Core's database and Object store.

Retention across Restart, Reset and Hard Reset, uninstall cleanup and the no-rerun rule follow [private operational storage](topics/plugins.md#private-operational-storage).

## Agreed storage approach

Use typed storage for identity, status, timestamps, and relationships, with validated JSON for variable payloads such as Command input/output and Object metadata. Every supported component requires a schema. Optional components remain absent when unused; optional scalar fields may be null. Do not store `N/A` or empty component records. A logical component does not automatically require its own SQL table.

### Proposed physical mapping

| Data | Storage direction | Reason |
| --- | --- | --- |
| Entity identity, alias, type, timestamps, version | Typed columns on an Entity table | Stable fields used for lookup, uniqueness, and filtering |
| Asset registration identities | Private Dataset/request uniqueness with immutable original request facts and Entity/credential association | Lost-response retries remain recognizable after later Asset updates or Restart |
| Asset retirement identities | Private Dataset/request uniqueness with original target/parameter facts and recorded result/deletion marker | Retried retirement does not repeat activity or restore a deleted Entity; Reset clears the claim, not the installation denial |
| API-key creation identities | Private installation/creation uniqueness, canonical metadata and credential-verifier association | Lost-response retries cannot create extra keys or reactivate revoked keys; retained with installation setup |
| Entity identity reservations | Private Dataset/Entity ID uniqueness, original kind, deletion marker and highest issued geometry revision when applicable | Deleted IDs cannot be reused or attach retained history to another Entity; late valid Task/result evidence can resolve issued geometry revisions |
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
| Movement samples | Separate typed SQLite rows, indexed by Entity/time with per-quantity original-evidence/correction uniqueness | Re-signing or a new outer report identity cannot duplicate movement; preserve sparse quantities and their own timing under [movement history](topics/history.md#movement-history) |
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

Use the frozen S1 component surface above when authoring its schemas and tables. Review remaining applicability proposals before implementing later components, settle their Command declaration requirements, and choose physical mappings from the reads and writes they need. No additional named components are assumed to exist merely because the older wildcard could accept them.
