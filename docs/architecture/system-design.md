# Dedicated Atlas systems and shared contracts

Status: accepted direction, not yet implemented. This document owns cross-cutting mechanisms and module collaboration; behavior rules live on the [topic pages](../topics/README.md). [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first plan. [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) retains the generation policy. [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects the technology stack and [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects Docker deployment.

Linked ADRs record the decisions behind these mechanisms; the [system outline](system-outline.md) owns the responsibility map. Choices explicitly marked open remain implementation work. The [Modernization comparison](modernization-differences.md) records source differences.

## Architecture

Build the dedicated responsibilities in the [Core system outline](system-outline.md), following [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Each module owns its behavior and private data access. Collaborators call explicit interfaces rather than reaching into each other's tables. Keep transactions spanning those interfaces explicit and practical; internal calls can be ordinary code calls.

Storage connections, transactions, API serving, configuration and logging can share concrete utilities. Shared facilities do not establish separate services or a reusable module framework.

Apply the [deep-module criteria](../agents/code-conventions.md#structure-and-interfaces) to callers and internal collaborators together. Keep required workflow coordination behind its owner rather than exporting the mechanism to make that owner's implementation smaller. Separating internal facts or helpers does not by itself justify another public interface, service or framework.

[Protocol](../adr/0011-generate-shared-contracts-with-minimal-customization.md) owns shared external contracts. Core implements their guarantees; SDK exposes consumer access. Public wire types may be used directly where they fit, with a small explicit conversion where internal meaning differs.

## SDK as the supported entry point

Participants on IP links without bandwidth limits interact with Core through the Atlas SDK, which composes Core's API without taking over Core's authentication, authorization, Task transitions, Object readiness or committed-state consistency. [SDK](../topics/sdk.md) owns its consumers, HTTP mode and Full synchronization mode, the Local operational picture, write results, helpers and the [Asset client](../topics/sdk.md#asset-client), which is the SDK side of [shared Asset report acceptance](#shared-asset-report-acceptance).

## Local administration

The CLI and TUI share a local management implementation for Core lifecycle, Reset, Hard Reset, updates and installed Plugin management. They use private internal coordination, not the public API or SDK. Local tooling can start Core when it is stopped. Core's Plugins module owns its lifecycle policy; local tools coordinate with it instead of duplicating the rules.

Plugin management is local-only, with no public API endpoints, SDK methods or public Protocol generation, under [Plugins](../topics/plugins.md#local-administration).

Local tools also switch [Open enrollment](../topics/identity-and-access.md#open-enrollment), [re-provision a lost Asset credential](../topics/identity-and-access.md#lost-asset-credentials) and list retained and revoked Asset IDs.

Local administrative actions are recorded in [Activity history](../topics/history.md#local-actions).

Use the host-side private Docker integration selected in [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md). Its coordination channel and installation/update workflows remain open; no separate management service is required.

Managed Plugins run only with Core under [Runtime lifetime with Core](../topics/plugins.md#runtime-lifetime-with-core); local administration while Core is stopped does not run Plugin Operations.

Start, Stop, Restart, Reset and [Hard Reset](../topics/dataset-lifecycle.md#hard-reset) follow [Dataset lifecycle](../topics/dataset-lifecycle.md) and add no public endpoint or SDK lifecycle method.

### Local lifecycle coordination

Concentrate lifecycle execution and interrupted-action recovery in the shared host-side local management module. The CLI and TUI use the same interface; neither owns a second implementation of shutdown ordering, cleanup progress or startup gating. Core's Plugins module retains Plugin lifecycle policy. The management module coordinates that policy with process actions and each module's private state cleanup.

The management implementation must remain available after Core stops. It owns lifecycle-action serialization, the cleanup progress needed to resume an interrupted Hard Reset, and refusal to start an installation whose cleanup is incomplete. These responsibilities implement the [Dataset lifecycle](../topics/dataset-lifecycle.md) rules; they do not change what each lifecycle action retains or discards. Module owners decide which of their records and files are valid. The coordinator must not reconstruct those decisions by inspecting their private tables.

This placement of responsibility gives recovery rules locality and gives both local callers leverage through one interface. Keep the Docker adapter concrete and on the host under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#ownership-and-lifecycle). A general process framework or interchangeable runtime system adds no required capability. Private coordination, unexpected-Core-loss detection and the coordinator's process lifetime remain engineering work. In particular, host placement does not select an always-running management process; runtime-lifetime enforcement must still work after local callers exit.

### Opening a Dataset

Every Core module holding Dataset state implements one opening interface, `open(retained | fresh)`, and System operations serves operational requests only after every module reports ready. Retained opening checks the writing release, then lets each module reconcile its own state from the previous Core run: Objects reconciles interrupted publication, Plugins marks unfinished Operations Interrupted, Synchronization restores its replay window, and Tasks and Entities validate their retained records. Fresh opening clears each module's Dataset tables and establishes the new Dataset ID in one SQLite transaction. In either mode, Objects then removes, by ownership, content belonging to any Dataset other than the current one. Cleanup therefore does not depend on remembering which Dataset preceded an interrupted Reset: if a retried Reset creates another Dataset, content from every earlier Dataset is still removed. A module that cannot open reports an integrity failure rather than serving partial state. A missing Object file is a fault in that one Object, not a module failure; Core still opens under [Objects](../topics/objects.md#storage-quota-and-integrity-faults). Exact method names remain implementation work.

Reset uses this opening path under the host coordinator, which coordinates lifecycle actions while Core modules own Dataset cleanup and readiness; [Reset execution](../topics/dataset-lifecycle.md#reset-execution) states the directive, Plugin cleanup ordering and interrupted-Reset recovery.

Start, Restart and Reset share this one path, and each module keeps the locality of its own recovery and cleanup rules. The interface has an adapter in every stateful module, so it is a real seam rather than a hypothetical one.

## Identity and access

Callers, their permissions, Enrollment, Asset registration, credentials and the access effects of Asset deletion and retirement are specified in [Identity and access](../topics/identity-and-access.md).

Track publisher authorship, separate from descriptive edits and broad operational read access, follows [one publisher per Track](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

### Concurrent descriptive edits

Edits to operator-managed data require a version precondition identifying the state the caller reviewed. Core rejects an edit with a missing precondition without applying it. A stale precondition produces an explicit conflict so the caller can review the newer values. This covers descriptive resource edits such as aliases and Object metadata, as well as supported operator-managed settings. The rule follows the field's ownership, not whether a human or a Plugin made the request.

The SDK preserves the edit's original precondition. It must not silently fetch a newer version and retry the old edit as though the caller had reviewed it. Resource creation, immutable submissions and lifecycle actions keep their own admission and retry contracts; this decision does not replace them with a generic edit operation.

Asset-originated observations and execution reports use [shared report acceptance](#shared-asset-report-acceptance), report identity and ordering. An unrelated alias edit must not reject a valid position report merely because the aggregate Entity version changed. Descriptive edits likewise must not overwrite reported state. Protocol must specify the applicable version scope and errors for each mutation class; exact encodings and the division of independently editable fields remain engineering work. Track observations additionally obey their [publisher boundary](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

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

System operations coordinates startup and shutdown, while Objects reconciles its own staging, published content and private identity records. A generic cleanup module must not infer Object validity or remove content from stale metadata. The local-files adapter and SQLite remain private implementation details, with bulk transfer outside short database transactions. [ADR-0009](../adr/0009-expose-objects-only-when-ready.md) selects durable file publication before the ready-state SQLite commit; [publication and recovery](../topics/objects.md#publication-and-recovery) states the resulting rules. Exact filesystem primitives remain implementation work.

Tasks retains assigned-Asset declarations, required-result references and Task transitions. Objects owns content readiness and the protection holds derived from those declarations. When Tasks accepts a required-result declaration, it calls Objects to place a hold on each declared Object ID for that Task in the same commit; the hold fails with the deleted-result outcome if any ID was already deleted, and otherwise reports which held Objects are already published. Tasks passes that readiness to [Task transitions](#task-transitions) in the same commit, so an upload that arrived before the declaration can complete the Task immediately.

Objects owns the complete publication workflow when an upload arrives after the declaration. Its domain operation coordinates the short [write commit](#write-commits), identifies affected Tasks from its holds and calls Tasks' result-readiness interface in that transaction. Tasks evaluates and persists any resulting completion under its existing completion and terminal-state rules; publication never reopens a terminal Task. Ready Object metadata, successful upload identity, resulting Task changes and both modules' change records commit together or roll back together. File durability and abandoned-attempt cleanup follow [publication and recovery](../topics/objects.md#publication-and-recovery). Every upload entry point uses this Objects operation, including retries under the existing retry rules. Transport adapters only translate requests and results; they do not assemble publication and Task completion.

Each module keeps its private data access and domain decisions. Objects still enforces deletion protection from its own holds without calling Tasks. The publication collaboration preserves [declaration/publication/deletion serialization](../topics/objects.md#declaration-publication-and-deletion-order) and both result arrival orders. Keep the independent Object MVP fixture free of scan-specific result dependencies; add this collaboration with the scan workflow.

## Core tasking and Asset execution

Tasks implements the rules in [Tasks](../topics/tasks.md), under the [Core-owned Command boundary](../adr/0004-core-owns-commands-and-assets-execute-tasks.md), [Task reconciliation](../adr/0007-reconcile-asset-tasks-after-disconnection.md) and [scan result/status contract](../adr/0008-complete-scan-tasks-when-required-results-are-available.md). It validates Command/target contracts, including [admission](../topics/tasks.md#task-creation) against retired Assets, and uses [Identity and access](../topics/identity-and-access.md#assets) for assigned-Asset reporting.

Tasks validates the typed Entity and Object references that Commands declare, and Entities enforces [required-reference deletion protection](../topics/tracks-and-geofeatures.md#required-entity-references). [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) preserves these references while deferring the dependency publication and indexing used solely for hybrid synchronization.

Tasks coordinates acceptance of scan collection-finished evidence with Entities' geometry edits under [collection finished and geometry](../topics/tasks.md#collection-finished-and-geometry). Their commit order decides whether the scan must account for an edit. Objects' later readiness notification uses that accepted evidence, preserving both result arrival orders. This uses the existing owners and write-commit boundary, without a new coordinator or Task status. Commands using Track data define their own [freshness requirements](../topics/tracks-and-geofeatures.md#track-data-used-by-commands).

The Asset OS owns execution, interruption and its confirmed onboard queue; Core records intent and outcomes without starting Tasks or gating them on connectivity, under [queued and immediate scheduling](../topics/tasks.md#queued-and-immediate-scheduling) and [queue revisions](../topics/tasks.md#queue-revisions).

Asset check-in, component patches and status reports follow [Asset reporting](../topics/asset-reporting.md), replacing the separate execution-runtime registration API; [shared report acceptance](#shared-asset-report-acceptance) enforces authorship and freshness on every reporting path.

Registration/fencing machinery from Modernization is not a required subsystem. Reject unauthorized, duplicate or obsolete reports through the smallest contract satisfying these guarantees. Exact reconciliation messages remain open.

### Shared Asset report acceptance

Entities owns shared Asset report acceptance. Its observable behavior, including dispositions, contact evidence, freshness and no-regression, is specified in [Asset report acceptance](../topics/asset-reporting.md#asset-report-acceptance); this section covers the module mechanism.

Check-in, Entity updates, Task lifecycle reports and queue reports hand shared acceptance the authenticated principal and report through ordinary interfaces before applying anything. Acceptance owns the check that the authenticated principal is bound to the reporting Asset, the Core-issued process generation and authority transfer from [Asset recovery](../topics/tasks.md#recovery-after-an-unexpected-asset-restart), report identities and ordering boundaries, contact and Communication state derivation, component no-regression and movement-sample capture. Identity and access verifies the authenticated principal; Tasks retains assigned-Asset checks and Task transition validation.

Entities owns the private accepted-report identities and ordering state and coordinates persistence with each report's valid effects. Entities and Tasks apply an Asset-reported effect only when given the accepted-report value acceptance returns, so a new reporting route cannot skip authorship or freshness. The acceptance runs inside the same [write commit](#write-commits) as the applied effect: Tasks collaborates with Entities in that transaction so report acceptance facts, affected Task state, Entity contact and their change records commit together. Each module keeps its private data access. This gives shared acceptance rules locality without introducing a separate top-level report-acceptance module, and it does not combine separately arriving Asset and Task reports. Transport adapters translate reports and results rather than reconstructing acceptance and commit coordination. Retain acceptance state across Restart and clear it on Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Exact report identities, ordering scope, freshness windows and interface shapes remain engineering work.

### Task transitions

Tasks keeps its lifecycle rules in one pure transition module: given the affected Task's recorded state, the assigned Asset's control record and an event (an accepted Asset report, a cancellation request, satisfied required results or a control action), it returns the next Task state and control record, or an explicit rejection. The control record holds the latest applied Pause/Resume acceptance order and the suspended Task it concerns, so a delayed control report is judged against newer applied intent inside the module rather than by a handler. Operational status remains separate Entity data; the module does not infer it. It owns the [transition table](../topics/tasks.md#task-status-and-transitions), terminal immutability, cancellation intent, [delaying completion until required results are ready](../topics/tasks.md#scan-completion) and Pause/Resume [control ordering](../topics/tasks.md#control-ordering-and-expiry). Handlers translate requests into events and persist the returned decision; none decides a transition itself.

Queue revisions remain a separate part of Tasks because requested and confirmed order is different state with its own revision contract. They ask the transition module whether a Task has started. The transition module is the test surface for the independently specified state model in the [testing strategy](../testing-strategy.md#required-scenario-coverage); it does not replace integration coverage.

## Plugin Operations

Plugins implements Operations separately from Tasks. [Plugins](../topics/plugins.md) states the Operation, stopping, fault, configuration and storage rules.

SDK helpers manage submission identity and outcome queries; the server remains responsible for acceptance and recorded outcomes. A separate Core-owned Operation record stores submission identity, Plugin/release/capability, input, state, progress and known outcomes. Submission retries use the shared [retry identity](#retry-identity) mechanism. See the [storage catalog](../data-components.md#core-support-records).

Host management owns each Plugin's [working storage](../topics/plugins.md#private-operational-storage) and clears it after stopping writers. Core does not parse Plugin-private storage or give Plugins access to its database. [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects a separate Docker container per installed Plugin.

## Write commits

Core keeps one SQLite database. Its tables are grouped by lifetime: Dataset tables are cleared by Reset, and installation tables such as Asset principal bindings, credential verifiers and API-key creation identities survive until Hard Reset. One database keeps registration, Asset retirement/deletion and credential revocation atomic with their Entity effects; SQLite does not guarantee atomic commits across attached databases in WAL mode. Configuration files, secret material, Plugin artifacts, the Reset directive and the local activity journal stay on the installation mount under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope).

Every write goes through shared commit code with two entry points:

- A Dataset commit takes the Dataset the request targets and rejects an obsolete one before any module logic runs. Inside it, a module runs [Asset report acceptance](#shared-asset-report-acceptance) and [retry identity](#retry-identity) claims where relevant, applies its mutation and returns its public change records and activity records; the commit appends both in order with the mutation. Registration and Asset retirement/deletion write their installation facts inside this same transaction.
- An installation commit serves writes whose records belong to no Dataset, such as API-key creation and credential revocation. A public installation write still carries the caller's Dataset and the commit rejects an obsolete one, as the [API-key retry contract](../topics/identity-and-access.md#api-keys) requires, so a request delayed across Reset cannot create or revoke a retained credential. Local management writes made through the CLI or TUI are not public requests and carry no client Dataset. The commit has no change log entry and records activity when a Dataset exists.

Both acquire SQLite's write lock at the start of the transaction, which serializes concurrent retries of the same identity. The commit code enforces the [Dataset boundary](../topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary), the change-record obligation and the activity obligation once; owning modules still supply the meaning of every record, and the commit code never inspects their private tables. This is the concrete shared transaction facility allowed above, not a module framework or event bus under [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Wire placement of the Dataset identity remains implementation design.

### Retry identity

One retry identity module serves every lost-response retry: Task creation, Asset registration, Asset retirement, Object upload, Plugin Operation submission, queue edit, cancellation request and API-key creation. Inside the caller's commit, a claim supplies the kind, scope (Dataset or installation), identity and canonical original request facts. It returns one of:

- First: no earlier claim; the caller performs the effect and records its result against the identity.
- Replay: an identical earlier claim; return its recorded result without repeating the effect.
- Conflict: the identity was used with different original facts; fail explicitly.
- Ended: the recorded result was later deleted or revoked; return the explicit deleted-result or revoked outcome without resurrection.

Comparison always uses the original facts, never editable current state. Dataset-scoped identities are cleared by Reset; installation-scoped identities survive until Hard Reset. Each kind keeps its own facts, authorization checks and retention rules in its owning contract; the module shares only the mechanism, not the single UUID/hash replacement that the [planning reconciliation](../planning-reconciliation.md) rejected. Asset report identities stay in report acceptance because they also carry ordering and freshness. Movement-sample and activity deduplication follow the identity of the action that produced them.

Asset retirement uses its own Dataset-scoped claim kind inside the Entities retirement commit. Its canonical original facts include the target Asset ID and any submitted retirement parameters; compare them with the original request, not current Entity or credential state. First records the retired result with the atomic effects and activity; an authorized Replay returns that result without repeating them. Reusing the identity for another Asset or changed parameters is Conflict. If ordinary deletion later removes the retired Entity, Ended returns a deleted-result outcome without recreating it. Revoking Asset credentials does not itself end the operator's retirement claim. Reset clears the claim and rejects obsolete-Dataset retries, while the installation-scoped retirement denial remains under [retired identity after Reset](../topics/identity-and-access.md#retired-identity-after-reset). Exact parameter fields and encoding remain schema work.

### Activity recording

Activity is stored in one SQLite activity table through a shared recording helper. System operations is the proposed home for that recording and query facility. Identity and access supplies the actor identity, and each owning module supplies the action's meaning and affected resources; the facility must not infer business actions from diagnostic log strings. Modules return activity records to the [write commit](#write-commits), which appends them with the mutation. Local management records its actions through private coordination while Core runs and through the local activity journal while Core is stopped. [Activity and movement history](../topics/history.md) states what is recorded, attribution, journal import and retention.

## Change publication

The module making a change supplies its public representation. This ownership rule is accepted. The write-owning module returns its mutation's change record to the [write commit](#write-commits), which commits both together in SQLite. A private ordered change log includes replay payloads and deletion records; both feed delivery and changed-since read the committed log. Shared publication code delivers committed records in an order consistent with state. For example, Tasks describes a Task status change; delivery code does not inspect private Task tables to reconstruct its meaning.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

Tasks supplies the public Task and assigned-queue changes needed by synchronized consumers, including requested and confirmed queue state under [queue revisions](../topics/tasks.md#queue-revisions). Synchronization does not infer their meaning from private Task storage. [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) defers the earlier generic Task dependency publication and membership index used solely for Asset hybrid coverage; Command-defined resource references retain their tasking meaning.

## Detectable synchronization gaps

Core must not silently drop committed changes while allowing a consumer to treat its picture as current. When a slow consumer, expired replay history or another delivery gap prevents complete replay, make that condition detectable through the synchronization contract. The SDK's recovery follows [synchronization gaps and recovery](../topics/sdk.md#synchronization-gaps-and-recovery).

Retain a bounded replay window and an explicit earliest recoverable boundary, updated consistently with pruning. Restart retains the remaining window; Reset creates a new Dataset. Deletions and multi-resource changes must remain recoverable without skipped state. Exact payloads, buffer sizes, transport signaling and numeric replay limits remain implementation choices. Dataset changes additionally follow [the Dataset boundary](../topics/dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).

## Basic operational protections

Protect retained credentials with restrictive access to their storage. Keep credentials and provider secrets out of activity history, diagnostic logs and returned error details. Error messages should explain the failure without reproducing secret-bearing inputs or raw provider responses.

Bound request sizes, upload resource use and concurrent/in-flight work. Exceeding a bound must produce an explicit refusal or failure rather than unbounded resource growth or a false success. Object storage has a [quota](../topics/objects.md#storage-quota-and-integrity-faults) that leaves headroom for operational writes. Numeric limits and enforcement mechanisms follow the measured workload; they do not restore the old universal 25-second Operation timeout.

## Generation and testing

Follow [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) for generation policy. Count reusable generator extensions as maintained code and justify them by the independent work they remove. Measure simplicity by independently maintained decisions and effort to change behavior; remove superseded implementations after verification.

Use a pinned toolchain and deterministic regeneration. Independently authored wire examples, public behavior, supported compatibility and real API/storage integration are the test oracles, rather than generated snapshots alone. Generated types do not replace the extensive real SDK and Core integration and parity testing that the [testing strategy](../testing-strategy.md#sdk-and-core-integration-requirements) requires.

Prove the selected Protocol code-generation path and concrete report-acceptance contract in the first relevant implementation slice. Real failure tests remain completion requirements. Removing hybrid narrows the synchronization scope; it does not defer the remaining correctness evidence until after the contract grows.

The [selected stack](../adr/0016-use-go-sqlite-and-openapi-tooling.md) must also pass a representative generation check without output patches, and [Docker deployment](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) must preserve the lifecycle guarantees across container changes.

The [testing strategy](../testing-strategy.md) states the [validation focus for each promise](../testing-strategy.md#validation-focus-by-promise) and the [MVP integration checks](../testing-strategy.md#mvp-integration-checks).
