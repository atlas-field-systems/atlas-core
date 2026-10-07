# Dedicated Atlas systems and shared contracts

Status: accepted direction; operational mechanisms are not yet implemented. The [Slice 0 foundation](../../tests/contract/README.md) supplies shared contract tooling and isolated validation fixtures. This document owns cross-cutting mechanisms and module collaboration; behavior rules live on the [topic pages](../topics/README.md). [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first plan. [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) retains the generation policy. [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects the technology stack and [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects Docker deployment.

Linked ADRs record the decisions behind these mechanisms; the [system outline](system-outline.md) owns the responsibility map. Choices explicitly marked open remain implementation work. The [Modernization comparison](modernization-differences.md) records source differences.

## Architecture

Build the dedicated responsibilities in the [Core system outline](system-outline.md), following [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Each module owns its behavior and private data access. Collaborators call explicit interfaces rather than reaching into each other's tables. Keep transactions spanning those interfaces explicit and practical; internal calls can be ordinary code calls.

Storage connections, transactions, API serving, configuration and logging can share concrete utilities. Shared facilities do not establish separate services or a reusable module framework.

Apply the [deep-module criteria](../agents/code-conventions.md#structure-and-interfaces) to callers and internal collaborators together. Keep required workflow coordination behind its owner rather than exporting the mechanism to make that owner's implementation smaller. Separating internal facts or helpers does not by itself justify another public interface, service or framework.

[Protocol](../adr/0011-generate-shared-contracts-with-minimal-customization.md) owns shared external contracts. Core implements their guarantees; SDK exposes consumer access. Public wire types may be used directly where they fit, with a small explicit conversion where internal meaning differs.

## SDK as the supported entry point

Participants on IP links without bandwidth limits interact with Core through the Atlas SDK, which composes Core's API without taking over Core's authentication, authorization, Task transitions, Object readiness or committed-state consistency. [SDK](../topics/sdk.md) owns its consumers, HTTP mode and Full synchronization mode, the Local operational picture, write results, helpers and the [Asset client](../topics/sdk.md#asset-client), which is the SDK side of [shared Asset report acceptance](#shared-asset-report-acceptance).

## Local administration

The CLI and TUI share a local management implementation for Core lifecycle, Reset, Hard Reset, updates, Core configuration and installed Plugin management. They use private internal coordination, not the public API or SDK. Local tooling can start Core when it is stopped. Core's Plugins module owns its lifecycle policy; local tools coordinate with it instead of duplicating the rules.

Plugin management is local-only, with no public API endpoints, SDK methods or public Protocol generation, under [Plugins](../topics/plugins.md#local-administration).

Core configuration inspection and editing are also local-only under [Core configuration](../topics/dataset-lifecycle.md#core-configuration); authenticated health and readiness remain public under [ADR-0027](../adr/0027-administer-core-configuration-locally.md).

Local tools also switch [Open enrollment](../topics/identity-and-access.md#open-enrollment), [clean up selected test identities](../topics/identity-and-access.md#cleanup-after-testing), [re-provision a lost Asset credential](../topics/identity-and-access.md#lost-asset-credentials) and list retained and revoked Asset IDs.

Local management confirms the selected cleanup IDs and submits one Core-owned workflow through its private coordination while Core runs. Entities coordinates each target's commit and reuses ordinary retirement when an Asset Entity exists; Identity and access owns enrollment provenance, retained binding denial and credential revocation. Revalidate those facts inside the existing [write commit](#write-commits), so callers do not choose between retirement and retained-identity cleanup using an earlier list result. The credential owner also supplies the Open enrollment summary to health rather than exposing its private tables.

Local administrative actions are recorded in [Activity history](../topics/history.md#local-actions).

The shared host module runs as an installation-specific Linux systemd service, owns Docker control and authenticated private Unix coordination, and keeps Core as the sole SQLite accessor even for stopped-state maintenance. Lifetime enforcement and interrupted cleanup follow [host supervision and private coordination](../topics/dataset-lifecycle.md#host-supervision-and-private-coordination), implementing the host placement selected in [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md).

Managed Plugins run only with Core under [Runtime lifetime with Core](../topics/plugins.md#runtime-lifetime-with-core); local administration while Core is stopped does not run Plugin Operations.

Start, Stop, Restart, Reset and [Hard Reset](../topics/dataset-lifecycle.md#hard-reset) follow [Dataset lifecycle](../topics/dataset-lifecycle.md) and add no public endpoint or SDK lifecycle method.

### Local lifecycle coordination

Concentrate lifecycle execution and interrupted-action recovery in the shared host-side local management module. The CLI and TUI use the same interface; neither owns a second implementation of shutdown ordering, cleanup progress or startup gating. Core's Plugins module retains Plugin lifecycle policy. The management module coordinates that policy with process actions and each module's private state cleanup.

The management implementation must remain available after Core stops. It owns lifecycle-action serialization, the cleanup progress needed to resume an interrupted Hard Reset, and refusal to start an installation whose cleanup is incomplete. These responsibilities implement the [Dataset lifecycle](../topics/dataset-lifecycle.md) rules; they do not change what each lifecycle action retains or discards. Module owners decide which of their records and files are valid. The coordinator must not reconstruct those decisions by inspecting their private tables.

The installation-specific manager survives CLI/TUI exit and unexpected Core loss. It serializes lifecycle work, authenticates private Unix peers and stops Plugins when their Core run ends under [host supervision](../topics/dataset-lifecycle.md#host-supervision-and-private-coordination). Keep the Docker adapter concrete and on the host under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#ownership-and-lifecycle).

#### Management action records

Use one private action-record representation for recoverable local management work. The shared management module owns the action identity, kind, target, action-specific phase and known outcome, together with the progress needed to resume cleanup. CLI and TUI callers submit an action and inspect its result; they do not maintain separate recovery records or reconstruct cleanup progress. Share recording and recovery mechanics without forcing different actions through one sequence of phases.

The manager owns durable JSON action records outside the installation tree being cleaned, following [owned storage and durable actions](../topics/dataset-lifecycle.md#owned-storage-and-durable-actions). The Reset action record also owns its directive; there is no separate host Reset directive under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md#host-reset-directive-consolidation). Core supplies independent Dataset establishment proof and retains Plugin policy and private module state. Pending versus established Reset and interrupted Hard Reset use the [recovery states](../topics/dataset-lifecycle.md#recovery-states). The [local activity journal](../topics/history.md#local-actions) remains a separate action history, with its existing import and Reset rules; it is not the startup gate or cleanup authority.

### Opening a Dataset

Every Core module holding Dataset state implements one opening interface, `open(retained | fresh)`, and System operations serves operational requests only after every module reports ready. Retained opening checks the writing release, then lets each module reconcile its own state from the previous Core run: Objects reconciles interrupted publication, Plugins marks unfinished Operations Interrupted, Synchronization restores its replay window, and Tasks and Entities validate their retained records. Fresh opening clears each module's Dataset tables and establishes the new Dataset ID in one SQLite transaction. In either mode, Objects then removes, by ownership, content belonging to any Dataset other than the current one. Cleanup does not depend on remembering which Dataset preceded an interrupted Reset; it covers every noncurrent Dataset, including content left by earlier Resets. Core's establishment proof determines retained versus fresh recovery under [Interrupted Reset](../topics/dataset-lifecycle.md#interrupted-reset); retrying a host action cannot itself authorize another Dataset. A module that cannot open reports an integrity failure rather than serving partial state. A missing Object file is a fault in that one Object, not a module failure; Core still opens under [Objects](../topics/objects.md#storage-quota-and-integrity-faults). Exact method names remain implementation work.

The target Core performs private preflight before opening, including installation-format fingerprints and the explicit finite conversion registry under [retained formats and release update](../topics/dataset-lifecycle.md#retained-formats-and-explicit-release-update). Explicit release update replaces the operational schema in the fresh-opening transaction while preserving installation identity and denial facts. Retained opening never silently migrates operational data or repairs same-release format drift.

Reset uses this opening path under the host coordinator, which coordinates lifecycle actions while Core modules own Dataset cleanup and readiness; [Reset execution](../topics/dataset-lifecycle.md#reset-execution) states the action-record directive, Plugin cleanup ordering and interrupted-Reset recovery.

Start, Restart and Reset share this one path, and each module keeps the locality of its own recovery and cleanup rules. Each stateful module must provide its opening adapter when implemented; the delivered S0 foundation does not yet implement this operational path.

## Identity and access

Callers, their permissions, Enrollment, Asset registration, credentials and the access effects of Asset deletion, retirement and Open enrollment cleanup are specified in [Identity and access](../topics/identity-and-access.md).

Track publisher authorship, separate from descriptive edits and broad operational read access, follows [one publisher per Track](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

### Concurrent descriptive edits

Edits to operator-managed data require a version precondition identifying the state the caller reviewed. Core rejects an edit with a missing precondition without applying it. A stale precondition produces an explicit conflict so the caller can review the newer values. This covers descriptive resource edits such as aliases and Object metadata, as well as supported operator-managed settings. The rule follows the field's ownership, not whether a human or a Plugin made the request.

The SDK preserves the edit's original precondition. It must not silently fetch a newer version and retry the old edit as though the caller had reviewed it. Resource creation, immutable submissions and lifecycle actions keep their own admission and retry contracts; this decision does not replace them with a generic edit operation.

Asset-originated observations and execution reports use [shared report acceptance](#shared-asset-report-acceptance), report identity and ordering. An unrelated alias edit must not reject a valid position report merely because the aggregate Entity version changed. Descriptive edits likewise must not overwrite reported state. [Mutation classes and atomic validation](../topics/asset-reporting.md#mutation-classes-and-atomic-validation) specify separate edit and report requests, their revision scope and errors. Track observations additionally obey their [publisher boundary](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

### Asset deletion coordination

Keep Asset deletion coordination inside the Entities module, behind its existing deletion interface. Entities owns the workflow's admission, serialization and commit coordination; the transport adapter does not assemble separate deletion, credential and Task operations. Tasks supplies the nonterminal-work guard, Identity and access owns credential revocation, and Synchronization owns committed-change delivery and connection handling. Each collaborator retains its domain rules and private storage access.

Coordinate the deletion transaction with the competing assignment, registration, provisioning and reporting paths listed in [Asset deletion and access](../topics/identity-and-access.md#asset-deletion-and-access). Use the credential owner's shared revocation behavior to enforce the delivery cut-off when revocation commits; closing a connection later cannot permit buffered events to bypass it. A rejected deletion leaves the Entity and credentials unchanged. Keep this workflow within Entities without adding a general transaction coordinator. The distinct retirement workflow uses those same owners under [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md). Exact internal interfaces and serialization mechanics remain implementation work.

### Required Entity references

The deletion guard for Tracks and Geofeatures required by unfinished Tasks is specified in [Required Entity references](../topics/tracks-and-geofeatures.md#required-entity-references). Tasks owns the meaning of required Command references; Entities coordinates deletion with Task admission and transitions through the existing module interfaces. This protection does not restore deferred hybrid synchronization. Live geometry and its edit guard follow [Geofeatures](../topics/tracks-and-geofeatures.md#geofeatures); the Task-side cutoff is in [Live Geofeature geometry](../topics/tasks.md#live-geofeature-geometry).

## Objects hide storage

Clients identify Objects and access their content through Core APIs exposed by the SDK. Physical buckets, filesystem paths and storage-provider details stay inside the Objects implementation, outside public Object fields and Plugin integration requirements.

[Objects](../topics/objects.md) specifies ready-only visibility, private staging, restart-from-beginning upload retries and completed-request deduplication under [ADR-0009](../adr/0009-expose-objects-only-when-ready.md). [Dataset lifecycle](../topics/dataset-lifecycle.md) owns retention and Reset cleanup across metadata, content and transfer state. Objects implements these guarantees independently of the selected storage provider.

[ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects SQLite and private local Object files.

### Object publication and recovery ownership

Keep publication, successful-upload retry lookup, deletion identity and interrupted-publication recovery together inside the Objects module. Upload handling and lifecycle coordination use its interface; they do not independently decide whether files and metadata represent a ready Object. This gives readiness rules locality and lets upload and Restart share the same implementation.

System operations coordinates startup and shutdown, while Objects reconciles its own staging, published content and private identity records. A generic cleanup module must not infer Object validity or remove content from stale metadata. The local-files adapter and SQLite remain private implementation details, with bulk transfer outside short database transactions. [ADR-0009](../adr/0009-expose-objects-only-when-ready.md) selects durable file publication before the ready-state SQLite commit; [durability and publication fixtures](../topics/objects.md#durability-and-publication-fixtures) specify file/directory synchronization, SQL durability and independent fault expectations.

Tasks retains assigned-Asset declarations, result references and execution outcomes. Objects owns content readiness and protection holds. When Tasks accepts an independent required-result declaration, it calls Objects to place a hold on each declared Object ID in the same commit. A deleted ID rejects the declaration batch, without affecting separately reported completion. Declaration may precede publication or follow a terminal Task outcome under [result declarations](../topics/tasks.md#result-declarations-and-execution-fixtures).

Objects owns the complete publication workflow. Its short [write commit](#write-commits) publishes ready metadata, successful upload identity and Object changes together. Publication does not call Task transitions or change execution outcomes. Consumers resolve declared IDs against Object state rather than requiring another readiness truth in Tasks. File durability and abandoned-attempt cleanup follow [publication and recovery](../topics/objects.md#publication-and-recovery). Every upload entry point uses this domain operation; transport adapters translate requests and results.

Each module keeps its private data access and domain decisions. Objects enforces deletion protection from its own holds without calling Tasks. Declaration, publication and deletion preserve [identity serialization](../topics/objects.md#declaration-publication-and-deletion-order) in both declaration/upload arrival orders. Keep the independent Object MVP fixture free of scan-specific result dependencies; add result declarations with the later scan workflow.

## Core tasking and Asset execution

Tasks implements the rules in [Tasks](../topics/tasks.md), under the [Core-owned Command boundary](../adr/0004-core-owns-commands-and-assets-execute-tasks.md), [Task reconciliation](../adr/0007-reconcile-asset-tasks-after-disconnection.md) and [Asset-owned completion](../adr/0026-record-asset-completion-independently-of-result-availability.md). It validates Command/target contracts, including [admission](../topics/tasks.md#task-creation) against retired Assets, and uses [Identity and access](../topics/identity-and-access.md#assets) for assigned-Asset reporting.

Tasks validates the typed Entity and Object references that Commands declare, and Entities enforces [required-reference deletion protection](../topics/tracks-and-geofeatures.md#required-entity-references). [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) preserves these references while deferring the dependency publication and indexing used solely for hybrid synchronization.

Tasks coordinates retained collection-finished evidence and applied geometry with Entities' edits under [collection finished and geometry](../topics/tasks.md#collection-finished-and-geometry). Either commit order records actual Asset execution against its applied revision; Core does not require new collection before accepting completion. Commands using Track data define their own [freshness requirements](../topics/tracks-and-geofeatures.md#track-data-used-by-commands).

The Asset OS owns execution, interruption and its confirmed onboard queue; Core records intent and outcomes without starting Tasks or gating them on connectivity, under [queued and immediate scheduling](../topics/tasks.md#queued-and-immediate-scheduling) and [queue revisions](../topics/tasks.md#queue-revisions).

Asset check-in, component patches and status reports follow [Asset reporting](../topics/asset-reporting.md), replacing the separate execution-runtime registration API; [shared report acceptance](#shared-asset-report-acceptance) enforces authorship and freshness on every reporting path.

Registration/fencing machinery from Modernization is not a required subsystem. Reject unauthorized, duplicate or obsolete reports using the shared report context and [process authority](../topics/asset-reporting.md#process-authority-establishment-and-replacement).

### Shared Asset report acceptance

Entities owns shared Asset report acceptance. Its observable behavior, including dispositions, contact evidence, freshness and no-regression, is specified in [Asset report acceptance](../topics/asset-reporting.md#asset-report-acceptance); this section covers the module mechanism.

Check-in, Entity updates, Task lifecycle reports and queue reports hand shared acceptance the authenticated principal and report through ordinary interfaces before applying anything. Acceptance checks the direct Asset principal or the authenticated gateway's binding to the reported Asset under [trusted relay](../topics/asset-reporting.md#report-authority-and-relay), the Core-issued process generation and authority transfer from [Asset recovery](../topics/tasks.md#recovery-after-an-unexpected-asset-restart), report identities and ordering boundaries, contact and Communication state derivation, component no-regression and movement-sample capture. Identity and access verifies the caller and its bindings; Tasks retains assigned-Asset checks and Task transition validation.

Entities owns the private accepted-report identities and ordering state and coordinates persistence with each report's valid effects. Entities and Tasks apply an Asset-reported effect only when given the accepted-report value acceptance returns, so a new reporting route cannot skip authorship or freshness. Acceptance runs inside the same [write commit](#write-commits) as the applied effect: Tasks collaborates with Entities so report acceptance facts, affected Task state, Entity contact and their change records commit together. Each module keeps its private data access; separately arriving Entity and Task reports remain separate commits. Transport adapters translate reports and results rather than reconstructing acceptance and commit coordination. Retain acceptance state across Restart and clear it on Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). [Shared report context](../topics/asset-reporting.md#shared-report-context) specifies identities, ordering, freshness proof and returned dispositions.

#### Shared report context

Protocol defines the common report context once and reuses it in Asset-originated check-in, component and Operational status, Task lifecycle and queue reports. It carries stable report identity, Core-issued process generation and the shared ordering/freshness facts required by acceptance. Each report keeps its own typed payload and any state-specific ordering or correlation facts. Reuse structural definitions rather than introducing a universal report payload or giving all reported state one sequence rule.

Dataset targeting follows the [Dataset wire boundary](../topics/dataset-lifecycle.md#dataset-wire-boundary). Identity and access supplies the authenticated principal separately; claimed identity or timestamps in the report do not establish authorship or fresh Contact. Every route hands that principal and the report to the existing acceptance interface before applying effects. Registration and ordinary submission retry identities retain their separate contracts. The [report contract](../topics/asset-reporting.md#shared-report-context) owns fields and acceptance policy; the [representative toolchain proof](../research/atlas-reassessment/13-protocol-toolchain-proof.md) verifies generation without output patches.

### Task transitions

Tasks keeps its lifecycle rules in one pure transition module: given the affected Task's recorded state, the assigned Asset's control record and an event (an accepted Asset report, a cancellation request or a control action), it returns the next Task state and control record, or an explicit rejection. The control record holds the latest applied Pause/Resume acceptance order and the suspended Task it concerns, so a delayed control report is judged against newer applied intent inside the module rather than by a handler. Operational status remains separate Entity data. The module owns the [transition table](../topics/tasks.md#task-status-and-transitions), terminal immutability, cancellation intent, [reported completion](../topics/tasks.md#scan-completion) and Pause/Resume [control ordering](../topics/tasks.md#control-ordering-and-expiry). Result declaration and publication are not outcome-transition events. Handlers persist its decisions rather than deciding transitions themselves.

Queue revisions remain a separate part of Tasks because requested and confirmed order is different state with its own revision contract. They ask the transition module whether a Task has started. The transition module is the test surface for the independently specified state model in the [testing strategy](../testing-strategy.md#required-scenario-coverage); it does not replace integration coverage.

## Plugin Operations

Plugins implements Operations separately from Tasks. [Plugins](../topics/plugins.md) states the Operation, stopping, fault, configuration and storage rules.

SDK helpers manage submission identity and outcome queries; the server remains responsible for acceptance and recorded outcomes. A separate Core-owned Operation record stores submission identity, Plugin/release/capability, input, state, progress and known outcomes. Submission retries use the shared [retry identity](#retry-identity) mechanism. See the [storage catalog](../data-components.md#core-support-records).

Core and the Plugin preserve exposure-before-send, live duplicate protection and durable unacknowledged execution evidence under [private dispatch and reconciliation](../topics/plugins.md#private-operation-dispatch-and-reconciliation).

Host management owns each Plugin's [working storage](../topics/plugins.md#private-operational-storage) and clears it after stopping writers. Core does not parse Plugin-private storage or give Plugins access to its database or Docker socket. Host coordination supplies the per-Plugin Unix channel and runtime credentials. [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects a separate Docker container per installed Plugin.

## Write commits

Core keeps one SQLite database. Its tables are grouped by lifetime: Dataset tables are cleared by Reset, and installation tables such as Asset principal bindings, credential verifiers and API-key creation identities survive until Hard Reset. One database keeps registration, Asset retirement/deletion and credential revocation atomic with their Entity effects; SQLite does not guarantee atomic commits across attached databases in WAL mode. Configuration files, secret material, Plugin artifacts and the local activity journal stay on the installation mount under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope). Host management action records, including Reset intent, use the external [recovery storage](../topics/dataset-lifecycle.md#owned-storage-and-durable-actions).

Every write goes through shared commit code with two entry points:

- A Dataset commit takes the Dataset the request targets and rejects an obsolete one before any module logic runs. Inside it, a module runs [Asset report acceptance](#shared-asset-report-acceptance) and [retry identity](#retry-identity) claims where relevant, applies its mutation and returns its public change records and activity records; the commit appends both in order with the mutation. Registration and Asset retirement/deletion write their installation facts inside this same transaction.
- An installation commit serves writes whose records belong to no Dataset, such as API-key creation and credential revocation. A public installation write still carries the caller's Dataset and the commit rejects an obsolete one, as the [API-key retry contract](../topics/identity-and-access.md#api-keys) requires, so a request delayed across Reset cannot create or revoke a retained credential. Local management writes made through the CLI or TUI are not public requests and carry no client Dataset. The commit has no change log entry and records activity when a Dataset exists.

Both acquire SQLite's write lock at the start of the transaction, which serializes concurrent retries of the same identity. The commit code enforces the [Dataset boundary](../topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary), change-record and activity obligations once; owning modules supply the meaning of every record, and the commit code never inspects their private tables. This is the concrete shared transaction facility allowed above, not a module framework or event bus under [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). HTTP placement follows [public wire conventions](#public-wire-conventions).

### Retry identity

One retry identity module serves request-result replay for Task creation, Asset registration, Asset retirement, Object upload, Plugin Operation submission, queue edit, cancellation request and API-key creation. Inside the caller's commit, a claim supplies the kind, scope (Dataset or installation), identity and canonical original request facts. It returns one of:

- First: no earlier claim; the caller performs the effect and records its result against the identity.
- Replay: an identical earlier claim; return its recorded result without repeating the effect.
- Conflict: the identity was used with different original facts; fail explicitly.
- Ended: the recorded result was later deleted or revoked; return the explicit deleted-result or revoked outcome without resurrection.

Comparison always uses the original facts, never editable current state. Dataset-scoped identities are cleared by Reset; installation-scoped identities survive until Hard Reset. Each kind keeps its own facts, authorization checks and retention rules in its owning contract; the module shares only the mechanism, not the single UUID/hash replacement that the [planning reconciliation](../planning-reconciliation.md) rejected. Asset report identities stay in report acceptance because they also carry ordering and freshness. Movement-sample and activity deduplication follow the identity of the action that produced them. Local [Open enrollment cleanup](../topics/identity-and-access.md#cleanup-after-testing) uses confirmed binding denial for idempotence rather than a separate request-result replay claim.

Asset retirement uses its own Dataset-scoped claim kind inside the Entities retirement commit. Its canonical original facts include the target Asset ID and any submitted retirement parameters; compare them with the original request, not current Entity or credential state. First records the retired result with the atomic effects and activity; an authorized Replay returns that result without repeating them. Reusing the identity for another Asset or changed parameters is Conflict. If ordinary deletion later removes the retired Entity, Ended returns a deleted-result outcome without recreating it. Revoking Asset credentials does not itself end the operator's retirement claim. Reset clears the claim and rejects obsolete-Dataset retries, while the installation-scoped retirement denial remains under [retired identity after Reset](../topics/identity-and-access.md#retired-identity-after-reset). Exact parameter fields and encoding remain schema work.

### Activity recording

Activity is stored in one SQLite activity table through a shared recording helper. System operations is the proposed home for that recording and query facility. Identity and access supplies the actor identity, and each owning module supplies the action's meaning and affected resources; the facility must not infer business actions from diagnostic log strings. Modules return activity records to the [write commit](#write-commits), which appends them with the mutation. Local management records its actions through private coordination while Core runs and through the local activity journal while Core is stopped. [Activity and movement history](../topics/history.md) states what is recorded, attribution, journal import and retention.

## Change publication

The module making a change supplies its final public resource image or deletion. The [write commit](#write-commits) appends the complete public change batch atomically with the mutation in SQLite. Synchronization defines and checks the supported complete-message bound through this shared commit path before any producer commits effects. Owning modules still supply every change's meaning; admission does not inspect their private tables or split an atomic mutation to fit a message.

A private ordered change log includes resource versions and commit identity; both feed delivery and HTTP changed-since read complete batches from it. Synchronization owns consistent snapshot capture with its continuation cursor and ordered catch-up-to-live delivery after a supplied complete cursor. One complete commit is one Protocol data message. The SDK owns validation and atomic picture application under [synchronization wire and application](../topics/sdk.md#synchronization-wire-and-application-boundary). Snapshot captures use bounded admission and normal replay retention under [snapshot lifetime and recovery](../topics/sdk.md#snapshot-lifetime-and-recovery); allocation receipts are bounded process-lifetime support state under [allocation retries](../topics/sdk.md#snapshot-allocation-retries), distinct from durable mutation retry claims. Producer/delivery/consumer bounds follow [batch capacity compatibility](../topics/sdk.md#complete-batch-capacity-compatibility); exact storage and real resource use remain unqualified.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

Tasks supplies the public Task and assigned-queue changes needed by synchronized consumers, including requested and confirmed queue state under [queue revisions](../topics/tasks.md#queue-revisions). Synchronization does not infer their meaning from private Task storage. [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) defers the earlier generic Task dependency publication and membership index used solely for Asset hybrid coverage; Command-defined resource references retain their tasking meaning.

## Detectable synchronization gaps

Core must not silently drop committed changes while allowing a consumer to treat its picture as current. When a slow consumer, expired replay history or another delivery gap prevents complete replay, make that condition detectable through the synchronization contract. The SDK's recovery follows [synchronization gaps and recovery](../topics/sdk.md#synchronization-gaps-and-recovery).

Retain a bounded replay window and an explicit earliest recoverable boundary, updated atomically when pruning whole commits. Restart retains the remaining window; Reset creates a new Dataset. The [synchronization contract](../topics/sdk.md#synchronization-wire-and-application-boundary) defines consistent snapshot continuation, ordered catch-up/live batches, explicit gaps and starting bounds. [Snapshot recovery](../topics/sdk.md#snapshot-lifetime-and-recovery) uses normal replay pruning without per-reader history pinning and pauses persistent capacity failure explicitly. Dataset changes additionally follow [the Dataset boundary](../topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).

## Basic operational protections

Protect retained credentials with restrictive access to their storage. Keep credentials and provider secrets out of activity history, diagnostic logs and returned error details. Error messages should explain the failure without reproducing secret-bearing inputs or raw provider responses.

Bound request sizes, upload resource use and concurrent/in-flight work. Exceeding a bound must produce an explicit refusal or failure rather than unbounded resource growth or a false success. Object storage has a [quota](../topics/objects.md#storage-quota-and-integrity-faults) that leaves headroom for operational writes. Numeric limits and enforcement mechanisms follow the measured workload; they do not restore the old universal 25-second Operation timeout.

## Generation and testing

### Public wire conventions

Protocol owns these HTTP and non-HTTP representations. Operational requests carry `Atlas-Dataset-ID` and `Atlas-Protocol-Version`; responses echo the actual Dataset and selected compatible contract version. Authenticated health/discovery can run without a Dataset precondition so a client can learn the new boundary. The [Dataset contract](../topics/dataset-lifecycle.md#dataset-wire-boundary) defines rejection before mutation. JSON fields use snake_case. Increasing resource versions, submission sequences, report sequences and commit positions use canonical unsigned decimal strings, never JSON numbers that lose precision in JavaScript. Paging handles remain opaque and bind scope/options, not just a numeric offset.

JSON successes use `{ dataset_id, data, commit_cursor? }`, with a committed cursor for Dataset mutations. Errors use `{ error: { code, message, request_id, details? }, dataset_id? }` with the documented HTTP status. Authentication and validation failures use the same JSON shape, without secret-bearing request values. The [documentation key-entry shell](../topics/dataset-lifecycle.md#offline-tls-and-first-time-setup) is the explicit HTML exception. Binary content responses use content type/length/digest and Dataset/version headers rather than a JSON wrapper. SDK mutation success means a validated committed response; malformed or lost responses retain an unknown outcome under [safe retry handling](../topics/sdk.md#mutation-outcomes-and-retries).

Authenticated `GET /openapi.json` returns the raw OpenAPI document, without the ordinary JSON success envelope, so standard contract tooling can consume it. Dataset/version context remains in response headers. Its JSON errors use the common error envelope; authentication is still required. No-body successes such as permitted deletion use their declared status and response headers.

The public report context is authored once and reused by check-in, status/component reports, Task outcomes, result declarations and queue confirmations under [shared report context](../topics/asset-reporting.md#shared-report-context). Full synchronization carries commit frames and Tasks-owned queue values through the existing Entities/Tasks/Objects picture under [synchronization wire](../topics/sdk.md#synchronization-wire-and-application-boundary). The local Command Catalog, HTTP variants and private Plugin message payloads reference their Protocol definitions rather than copying schemas.

Core checks Protocol's [JSON request representation](../../Atlas%20Protocol/README.md#json-request-representation) before decoding, validates request structure before domain effects, then applies authority, full-result validation and concurrency rules in the owning commit. Schema middleware and generated request-decoding/parameter-binding error hooks use the same typed JSON error adapter; default generated errors can otherwise return plain text. SDK validates successful JSON and error responses before interpreting their meaning. Generated types alone prove neither boundary. Permitted handwritten adapters handle supported tooling gaps such as omitted/null presence, streaming binary bodies and runtime schema validation, without changing generated output. The delivered [Protocol profile](../../Atlas%20Protocol/README.md#supported-schema-profile) and [S0 coverage](../../tests/contract/README.md) record qualified adapters and limitations. The [pinned representative proof](../research/atlas-reassessment/13-protocol-toolchain-proof.md) remains research prior art. Neither establishes operational Core behavior or field readiness.

Follow [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) for generation policy. Count reusable generator extensions as maintained code and justify them by the independent work they remove. Measure simplicity by independently maintained decisions and effort to change behavior; remove superseded implementations after verification.

Use a pinned toolchain and deterministic regeneration. Independently authored wire examples, public behavior, supported compatibility and real API/storage integration are the test oracles, rather than generated snapshots alone. Generated types do not replace the extensive real SDK and Core integration and parity testing that the [testing strategy](../testing-strategy.md#sdk-and-core-integration-requirements) requires.

Prove the selected Protocol code-generation path and concrete report-acceptance contract in the first relevant implementation slice. Real failure tests remain completion requirements. Removing hybrid narrows the synchronization scope; it does not defer the remaining correctness evidence until after the contract grows.

The [selected stack](../adr/0016-use-go-sqlite-and-openapi-tooling.md) must also pass a representative generation check without output patches, and [Docker deployment](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) must preserve the lifecycle guarantees across container changes.

The [testing strategy](../testing-strategy.md) states the [validation focus for each promise](../testing-strategy.md#validation-focus-by-promise) and the [MVP integration checks](../testing-strategy.md#mvp-integration-checks).
