# Dedicated Atlas systems and shared contracts

Status: accepted direction. [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first plan. [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) retains the generation policy. [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects the technology stack and [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects Docker deployment. These are accepted choices, not completed implementations.

This document owns collaboration rules and interface boundaries. Linked ADRs own the detailed behavioral decisions; the [system outline](system-outline.md) owns the responsibility map. Choices explicitly marked open remain implementation work. The [Modernization comparison](modernization-differences.md) records source differences.

## Architecture

Build the dedicated responsibilities in the [Core system outline](system-outline.md), following [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Each module owns its behavior and private data access. Collaborators call explicit interfaces rather than reaching into each other's tables. Keep transactions spanning those interfaces explicit and practical; internal calls can be ordinary code calls.

Storage connections, transactions, API serving, configuration and logging can share concrete utilities. Shared facilities do not establish separate services or a reusable module framework.

Apply the [deep-module criteria](../agents/code-conventions.md#structure-and-interfaces) to callers and internal collaborators together. Keep required workflow coordination behind its owner rather than exporting the mechanism to make that owner's implementation smaller. Separating internal facts or helpers does not by itself justify another public interface, service or framework.

[Protocol](../adr/0011-generate-shared-contracts-with-minimal-customization.md) owns shared external contracts. Core implements their guarantees; SDK exposes consumer access. Public wire types may be used directly where they fit, with a small explicit conversion where internal meaning differs.

## SDK as the supported entry point

Participants on IP links without bandwidth limits, including applications, Command Interfaces, Plugins, IP-connected Assets and radio gateways, use the general SDK to interact with Core. The local CLI/TUI administers the installation through internal management interfaces and does not use the SDK or public API. A health-check client, Command Interface and data-processing Plugin use the same supported SDK, with behavior appropriate to their needs. [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) draws the boundary at bandwidth: bandwidth-limited Assets and their constrained transport do not run this library and reach Core through a radio gateway.

Provide basic API access without starting a synchronized replica. Applications that need a maintained shared picture opt into synchronization and caching through the SDK. An application's role does not select its mode automatically. The SDK should make both uses clear without duplicating endpoint definitions or requiring a second client library outside it. The agreed modes are HTTP mode and Full synchronization mode, which uses local reads/queries/feed. Every mode writes to Core. Asset hybrid and matching Core scope machinery are deferred under ADR-0020. See [SDK data access](../sdk-data-access.md) for recovery, local history and Dataset Reset behavior. Exact method signatures remain open. External IP interaction with Core goes through the SDK, including Object upload and download; a bandwidth-limited Asset reaches it through its radio gateway.

The 27 September unified-interface decision remains in force for the two modes selected on 28 September. Keep the same public resource-read, query and feed methods, selecting the mode at configuration rather than requiring each caller to choose separate API and picture surfaces. HTTP and picture adapters remain private at the [existing read-source seam](../sdk-data-access.md#local-operational-picture-ownership); the SDK owns routing, complete-picture coverage, recovery and reconciliation while exposing meaningful readiness, freshness and failure facts. Existing local queries, changed-since history, cursor rules and no-fallback behavior remain required. Removing hybrid is an explicit scope decision under ADR-0020, not a public-interface split or permission to discard the remaining picture guarantees.

Keep the Core API small and explicit. The SDK owns client-side conveniences such as whole-file upload retries, pagination, submission retry identity and waiting for Operation outcomes. These helpers compose supported API operations and live separately from generated bindings; they do not duplicate endpoint contracts or patch generated code. Add helpers for actual consumer workflows, not a general workflow engine.

Core remains responsible for authentication, authorization, Task transitions, Object readiness and committed-state consistency at its API boundary. The SDK is the supported client entry point, not a substitute for those server responsibilities.

Accepted on 26 September 2026 and clarified on 28 September: one SDK Asset client module owns Core-facing Asset interactions for IP-connected Assets, gateways and simulated-Asset fixtures. These include registration and enrollment, check-in, component and status reports, Task lifecycle reports, required-result uploads, queue adoption/conflict reports and reading assigned work. It owns first-registration retry identity under enrollment authorization, re-registration after Reset, coordination of preallocated result Object IDs with completion reports, report identity and ordering, the Core-issued process generation, Pause/Resume report correlation, queue revision adoption, lost-response retries, discarding obsolete work on a Dataset change and reconnect reconciliation. After an Asset process restart, the Asset OS supplies its onboard execution evidence to the Asset client's reconciliation; the client reports what that evidence establishes and keeps uncertain work back until explicit recovery. The Asset OS still owns scheduling and execution, and the SDK keeps no disk persistence. State that must survive a process restart, such as a pending registration identity, is prepared by the Asset client and handed to the Asset OS or deployment layer to retain before submission, following the [API-key creation](../topics/identity-and-access.md#api-keys) pattern. Route-level Task status helpers remain for tasking clients such as an operator requesting cancellation. The Asset client is the SDK side of [Asset report acceptance](#shared-asset-report-acceptance), with HTTP as its Core-facing transport adapter. Bandwidth-limited Assets do not run it directly, and it does not implement radio delivery. See the [SDK operations catalog](../sdk-operations.md#asset-client).

## Local administration

The CLI and TUI share a local management implementation for Core lifecycle, Reset, Hard Reset, updates and installed Plugin management. They use private internal coordination, not the public API or SDK. Local tooling can start Core when it is stopped. Core's Plugins module owns its lifecycle policy; local tools coordinate with it instead of duplicating the rules.

Plugin management is local-only, with no public API endpoints, SDK methods or public Protocol generation, under [Plugins](../topics/plugins.md#local-administration).

Local tools also switch [Open enrollment](../topics/identity-and-access.md#open-enrollment), [re-provision a lost Asset credential](../topics/identity-and-access.md#lost-asset-credentials) and list retained and revoked Asset IDs.

Local administrative actions contribute to [activity history](#activity-history).

Use the host-side private Docker integration selected in [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md). Its coordination channel and installation/update workflows remain open; no separate management service is required.

Managed Plugins run only with Core under [Runtime lifetime with Core](../topics/plugins.md#runtime-lifetime-with-core); local administration while Core is stopped does not run Plugin Operations.

[Hard Reset](../adr/0015-separate-start-stop-restart-and-reset.md#hard-reset) is a separate local CLI/TUI action available whether Atlas is running or stopped. Its coordinator stops Core and managed Plugins, wipes operational state and installation setup, and returns to first-time setup. Ordinary Reset preserves Operator profiles, personal settings and installation setup. Neither reset action adds a public endpoint or SDK lifecycle method.

### Local lifecycle coordination

Concentrate lifecycle execution and interrupted-action recovery in the shared host-side local management module. The CLI and TUI use the same interface; neither owns a second implementation of shutdown ordering, cleanup progress or startup gating. Core's Plugins module retains Plugin lifecycle policy. The management module coordinates that policy with process actions and each module's private state cleanup.

The management implementation must remain available after Core stops. It owns lifecycle-action serialization, the cleanup progress needed to resume an interrupted Hard Reset, and refusal to start an installation whose cleanup is incomplete. These responsibilities implement [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md); they do not change what each lifecycle action retains or discards. Module owners decide which of their records and files are valid. The coordinator must not reconstruct those decisions by inspecting their private tables.

This placement of responsibility gives recovery rules locality and gives both local callers leverage through one interface. Keep the Docker adapter concrete and on the host under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#ownership-and-lifecycle). A general process framework or interchangeable runtime system adds no required capability. Private coordination, unexpected-Core-loss detection and the coordinator's process lifetime remain engineering work. In particular, host placement does not select an always-running management process; runtime-lifetime enforcement must still work after local callers exit.

### Opening a Dataset

Accepted on 26 September 2026. Every Core module holding Dataset state implements one opening interface, `open(retained | fresh)`, and System operations serves operational requests only after every module reports ready. Retained opening checks the writing release, then lets each module reconcile its own state from the previous Core run: Objects reconciles interrupted publication, Plugins marks unfinished Operations Interrupted, Synchronization restores its replay window, and Tasks and Entities validate their retained records. Fresh opening clears each module's Dataset tables and establishes the new Dataset ID in one SQLite transaction. In either mode, Objects then removes, by ownership, content belonging to any Dataset other than the current one. Cleanup therefore does not depend on remembering which Dataset preceded an interrupted Reset: if a retried Reset creates another Dataset, content from every earlier Dataset is still removed. A module that cannot open reports an integrity failure rather than serving partial state. A missing Object file is a fault in that one Object, not a module failure; Core still opens under [Objects](../topics/objects.md#storage-quota-and-integrity-faults). Exact method names remain implementation work.

Reset uses this opening path under the host coordinator. [ADR-0015's Reset execution contract](../adr/0015-separate-start-stop-restart-and-reset.md#reset-execution) owns the directive, commit marker and interrupted-action recovery algorithm. The host coordinates lifecycle actions and clears [private Plugin working storage](../adr/0021-manage-plugin-operational-storage-through-reset.md) before fresh opening; Core modules own Dataset cleanup and readiness. Recovery of an established Reset preserves new-Dataset Plugin work under ADR-0021. [Hard Reset](../adr/0015-separate-start-stop-restart-and-reset.md#hard-reset) retains its separate destructive scope.

Start, Restart and Reset share this one path, and each module keeps the locality of its own recovery and cleanup rules. The interface has an adapter in every stateful module, so it is a real seam rather than a hypothetical one.

## Identity and access

Callers, their permissions, Enrollment, Asset registration, credentials and the access effects of Asset deletion and retirement are specified in [Identity and access](../topics/identity-and-access.md).

Track publisher authorship, separate from descriptive edits and broad operational read access, follows [one publisher per Track](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

### Concurrent descriptive edits

Accepted on 28 September 2026 when the user approved the first documentation grilling round. Edits to operator-managed data require a version precondition identifying the state the caller reviewed. Core rejects an edit with a missing precondition without applying it. A stale precondition produces an explicit conflict so the caller can review the newer values. This covers descriptive resource edits such as aliases and Object metadata, as well as supported operator-managed settings. The rule follows the field's ownership, not whether a human or a Plugin made the request.

The SDK preserves the edit's original precondition. It must not silently fetch a newer version and retry the old edit as though the caller had reviewed it. Resource creation, immutable submissions and lifecycle actions keep their own admission and retry contracts; this decision does not replace them with a generic edit operation.

Asset-originated observations and execution reports use [shared report acceptance](#shared-asset-report-acceptance), report identity and ordering. An unrelated alias edit must not reject a valid position report merely because the aggregate Entity version changed. Descriptive edits likewise must not overwrite reported state. Protocol must specify the applicable version scope and errors for each mutation class; exact encodings and the division of independently editable fields remain engineering work. Track observations additionally obey their [publisher boundary](../topics/tracks-and-geofeatures.md#one-publisher-per-track).

### Asset deletion coordination

Keep Asset deletion coordination inside the Entities module, behind its existing deletion interface. Entities owns the workflow's admission, serialization and commit coordination; the transport adapter does not assemble separate deletion, credential and Task operations. Tasks supplies the nonterminal-work guard, Identity and access owns credential revocation, and Synchronization owns committed-change delivery and connection handling. Each collaborator retains its domain rules and private storage access.

Coordinate the deletion transaction with the competing assignment, registration, provisioning and reporting paths listed in [Asset deletion and access](../topics/identity-and-access.md#asset-deletion-and-access). Use the credential owner's shared revocation behavior to enforce the delivery cut-off when revocation commits; closing a connection later cannot permit buffered events to bypass it. A rejected deletion leaves the Entity and credentials unchanged. Keep this workflow within Entities without adding a general transaction coordinator. The distinct retirement workflow uses those same owners under [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md). Exact internal interfaces and serialization mechanics remain implementation work.

### Required Entity references

The deletion guard for Tracks and Geofeatures required by unfinished Tasks is specified in [Required Entity references](../topics/tracks-and-geofeatures.md#required-entity-references). Tasks owns the meaning of required Command references; Entities coordinates deletion with Task admission and transitions through the existing module interfaces. This protection does not restore deferred hybrid synchronization. Live geometry and its edit guard follow [Geofeatures](../topics/tracks-and-geofeatures.md#geofeatures); the Task-side cutoff is in [Live Geofeature geometry](../topics/tasks.md#live-geofeature-geometry).

## Bandwidth and authenticated reporting

The general SDK assumes adequate IP bandwidth between its consumers and Core, including a gateway running on a different host or network. Gateways may obtain the full operational picture; constrained-link selection and encoding belong between the gateway and Assets under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md). No Core-side hybrid filtering is required. Keep partial component updates, stable retry identities and bounded recovery because they preserve useful behavior without another read mode. Numeric capacity and latency still require measurement; this assumption does not make internet access a prerequisite for local operation.

Compact authenticated transport remains design work; any optimization must preserve the [caller identity](../topics/identity-and-access.md#callers-and-permissions) and [revocation](../topics/identity-and-access.md#credential-revocation) rules.

HTTP/OpenAPI remains the selected Core interface. A gateway uses the general SDK on its Core-facing IP link and separate radio software for Asset messages; no radio packet format, compression algorithm, batching protocol or per-packet overhead guarantee is selected here. Gateway translation preserves the [relay rules](../topics/asset-reporting.md#report-authority-and-relay) for Asset reports. A future constrained-IP deployment may choose a dedicated SDK without expanding this general SDK's scope. See the [integration and parity requirements](../testing-strategy.md).

## Objects hide storage

Clients identify Objects and access their content through Core APIs exposed by the SDK. Physical buckets, filesystem paths and storage-provider details stay inside the Objects implementation, outside public Object fields and Plugin integration requirements.

[Objects](../topics/objects.md) specifies ready-only visibility, private staging, restart-from-beginning upload retries and completed-request deduplication under [ADR-0009](../adr/0009-expose-objects-only-when-ready.md). [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md) owns retention and Reset cleanup across metadata, content and transfer state. Objects implements these guarantees independently of the selected storage provider.

[ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects SQLite and private local Object files.

### Object publication and recovery ownership

Keep publication, successful-upload retry lookup, deletion identity and interrupted-publication recovery together inside the Objects module. Upload handling and lifecycle coordination use its interface; they do not independently decide whether files and metadata represent a ready Object. This gives readiness rules locality and lets upload and Restart share the same implementation.

System operations coordinates startup and shutdown, while Objects reconciles its own staging, published content and private identity records. A generic cleanup module must not infer Object validity or remove content from stale metadata. The local-files adapter and SQLite remain private implementation details, with bulk transfer outside short database transactions. [ADR-0009](../adr/0009-expose-objects-only-when-ready.md) selects durable file publication before the ready-state SQLite commit; [publication and recovery](../topics/objects.md#publication-and-recovery) states the resulting rules. Exact filesystem primitives remain implementation work.

Tasks retains assigned-Asset declarations, required-result references and Task transitions. Objects owns content readiness and the protection holds derived from those declarations. Accepted on 26 September 2026: when Tasks accepts a required-result declaration, it calls Objects to place a hold on each declared Object ID for that Task in the same commit; the hold fails with the deleted-result outcome if any ID was already deleted, and otherwise reports which held Objects are already published. Tasks passes that readiness to [Task transitions](#task-transitions) in the same commit, so an upload that arrived before the declaration can complete the Task immediately.

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

Accepted on 26 September 2026: Entities owns shared Asset report acceptance. Its observable behavior, including dispositions, contact evidence, freshness and no-regression, is specified in [Asset report acceptance](../topics/asset-reporting.md#asset-report-acceptance); this section covers the module mechanism.

Check-in, Entity updates, Task lifecycle reports and queue reports hand shared acceptance the authenticated principal and report through ordinary interfaces before applying anything. Acceptance owns the check that the authenticated principal is bound to the reporting Asset, the Core-issued process generation and authority transfer from [Asset recovery](../topics/tasks.md#recovery-after-an-unexpected-asset-restart), report identities and ordering boundaries, contact and Communication state derivation, component no-regression and movement-sample capture. Identity and access verifies the authenticated principal; Tasks retains assigned-Asset checks and Task transition validation.

Entities owns the private accepted-report identities and ordering state and coordinates persistence with each report's valid effects. Entities and Tasks apply an Asset-reported effect only when given the accepted-report value acceptance returns, so a new reporting route cannot skip authorship or freshness. The acceptance runs inside the same [write commit](#write-commits) as the applied effect: Tasks collaborates with Entities in that transaction so report acceptance facts, affected Task state, Entity contact and their change records commit together. Each module keeps its private data access. This gives shared acceptance rules locality without introducing a separate top-level report-acceptance module, and it does not combine separately arriving Asset and Task reports. Transport adapters translate reports and results rather than reconstructing acceptance and commit coordination. Retain acceptance state across Restart and clear it on Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Exact report identities, ordering scope, freshness windows and interface shapes remain engineering work.

### Task transitions

Accepted on 26 September 2026. Tasks keeps its lifecycle rules in one pure transition module: given the affected Task's recorded state, the assigned Asset's control record and an event (an accepted Asset report, a cancellation request, satisfied required results or a control action), it returns the next Task state and control record, or an explicit rejection. The control record holds the latest applied Pause/Resume acceptance order and the suspended Task it concerns, so a delayed control report is judged against newer applied intent inside the module rather than by a handler. Operational status remains separate Entity data; the module does not infer it. It owns the [transition table](../topics/tasks.md#task-status-and-transitions), terminal immutability, cancellation intent, [delaying completion until required results are ready](../topics/tasks.md#scan-completion) and Pause/Resume [control ordering](../topics/tasks.md#control-ordering-and-expiry). Handlers translate requests into events and persist the returned decision; none decides a transition itself.

Queue revisions remain a separate part of Tasks because requested and confirmed order is different state with its own revision contract. They ask the transition module whether a Task has started. The transition module is the test surface for the independently specified state model in the [testing strategy](../testing-strategy.md#required-scenario-coverage); it does not replace integration coverage.

## Plugin Operations

Plugins implements Operations separately from Tasks. [Plugins](../topics/plugins.md) states the Operation, stopping, fault, configuration and storage rules.

SDK helpers manage submission identity and outcome queries; the server remains responsible for acceptance and recorded outcomes. A separate Core-owned Operation record stores submission identity, Plugin/release/capability, input, state, progress and known outcomes. Submission retries use the shared [retry identity](#retry-identity) mechanism. See the [storage catalog](../data-components.md#core-support-records).

Host management owns each Plugin's [working storage](../topics/plugins.md#private-operational-storage) and clears it after stopping writers. Core does not parse Plugin-private storage or give Plugins access to its database. [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects a separate Docker container per installed Plugin.

## Write commits

Accepted on 26 September 2026. Core keeps one SQLite database. Its tables are grouped by lifetime: Dataset tables are cleared by Reset, and installation tables such as Asset principal bindings, credential verifiers and API-key creation identities survive until Hard Reset. One database keeps registration, Asset retirement/deletion and credential revocation atomic with their Entity effects; SQLite does not guarantee atomic commits across attached databases in WAL mode. Configuration files, secret material, Plugin artifacts, the Reset directive and the local activity journal stay on the installation mount under [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope).

Every write goes through shared commit code with two entry points:

- A Dataset commit takes the Dataset the request targets and rejects an obsolete one before any module logic runs. Inside it, a module runs [Asset report acceptance](#shared-asset-report-acceptance) and [retry identity](#retry-identity) claims where relevant, applies its mutation and returns its public change records and activity records; the commit appends both in order with the mutation. Registration and Asset retirement/deletion write their installation facts inside this same transaction.
- An installation commit serves writes whose records belong to no Dataset, such as API-key creation and credential revocation. A public installation write still carries the caller's Dataset and the commit rejects an obsolete one, as the [API-key retry contract](../topics/identity-and-access.md#api-keys) requires, so a request delayed across Reset cannot create or revoke a retained credential. Local management writes made through the CLI or TUI are not public requests and carry no client Dataset. The commit has no change log entry and records activity when a Dataset exists.

Both acquire SQLite's write lock at the start of the transaction, which serializes concurrent retries of the same identity. The commit code enforces the [Dataset boundary](../adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary), the change-record obligation and the activity obligation once; owning modules still supply the meaning of every record, and the commit code never inspects their private tables. This is the concrete shared transaction facility allowed above, not a module framework or event bus under [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Wire placement of the Dataset identity remains implementation design.

### Retry identity

Accepted on 26 September 2026. One retry identity module serves every lost-response retry: Task creation, Asset registration, Asset retirement, Object upload, Plugin Operation submission, queue edit, cancellation request and API-key creation. Inside the caller's commit, a claim supplies the kind, scope (Dataset or installation), identity and canonical original request facts. It returns one of:

- First: no earlier claim; the caller performs the effect and records its result against the identity.
- Replay: an identical earlier claim; return its recorded result without repeating the effect.
- Conflict: the identity was used with different original facts; fail explicitly.
- Ended: the recorded result was later deleted or revoked; return the explicit deleted-result or revoked outcome without resurrection.

Comparison always uses the original facts, never editable current state. Dataset-scoped identities are cleared by Reset; installation-scoped identities survive until Hard Reset. Each kind keeps its own facts, authorization checks and retention rules in its owning contract; the module shares only the mechanism, not the single UUID/hash replacement that the [planning reconciliation](../planning-reconciliation.md) rejected. Asset report identities stay in report acceptance because they also carry ordering and freshness. Movement-sample and activity deduplication follow the identity of the action that produced them.

Asset retirement uses its own Dataset-scoped claim kind inside the Entities retirement commit. Its canonical original facts include the target Asset ID and any submitted retirement parameters; compare them with the original request, not current Entity or credential state. First records the retired result with the atomic effects and activity; an authorized Replay returns that result without repeating them. Reusing the identity for another Asset or changed parameters is Conflict. If ordinary deletion later removes the retired Entity, Ended returns a deleted-result outcome without recreating it. Revoking Asset credentials does not itself end the operator's retirement claim. Reset clears the claim and rejects obsolete-Dataset retries, while the installation-scoped retirement denial remains under [retired identity after Reset](../topics/identity-and-access.md#retired-identity-after-reset). Exact parameter fields and encoding remain schema work.

## Change publication

The module making a change supplies its public representation. This ownership rule is accepted. The write-owning module returns its mutation's change record to the [write commit](#write-commits), which commits both together in SQLite. A private ordered change log includes replay payloads and deletion records; both feed delivery and changed-since read the committed log. Shared publication code delivers committed records in an order consistent with state. For example, Tasks describes a Task status change; delivery code does not inspect private Task tables to reconstruct its meaning.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

Tasks supplies the public Task and assigned-queue changes needed by synchronized consumers, including requested and confirmed queue state under [queue revisions](../topics/tasks.md#queue-revisions). Synchronization does not infer their meaning from private Task storage. [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md) defers the earlier generic Task dependency publication and membership index used solely for Asset hybrid coverage; Command-defined resource references retain their tasking meaning.

## Detectable synchronization gaps

Core must not silently drop committed changes while allowing a consumer to treat its picture as current. When a slow consumer, expired replay history or another delivery gap prevents complete replay, make that condition detectable through the synchronization contract. The SDK marks its picture stale and obtains a fresh snapshot with a consistent continuation point before treating it as current again.

Retain a bounded replay window and an explicit earliest recoverable boundary, updated consistently with pruning. Restart retains the remaining window; Reset creates a new Dataset. Deletions and multi-resource changes must remain recoverable without skipped state. Exact payloads, buffer sizes, transport signaling and numeric replay limits remain implementation choices. Full-picture read access is available to every authenticated SDK client; automatic synchronization is still opt-in. Dataset changes additionally follow [the Reset boundary](../adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary).

### Asset hybrid coverage ownership

Deferred on 28 September 2026 by [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md). This heading retains the destination of earlier planning links; the former membership, scope-change and scoped-continuation requirements are not current implementation work. The SDK maintains a full picture when synchronization is selected. Gateways own any later selection needed for their radio link, without requiring Core to maintain automatic Asset subsets.

## Movement history

Track [silence and observation age](../topics/tracks-and-geofeatures.md#silence-and-observation-age) and [corrections](../topics/tracks-and-geofeatures.md#corrections-to-current-observations) are current-state rules, separate from the retained movement samples below; accepted movement corrections use the ordinary append-only ingestion and do not authorize historical sample editing or backfill.

The initial scope is a small Core store for reported Asset and Track movement, accepted on 22 September 2026. Entities captures position, speed and altitude from accepted ordinary create/update/check-in reports into a separate append-only sample table, in the same transaction as the current-state write. Do not store whole Entity snapshots or infer measurements from the merged Entity. Capture only explicitly supplied quantities: a position requires a complete latitude/longitude pair; speed-only and altitude-only samples are valid; unrelated changes add no sample. A fresh report repeating a stationary position is still an observation, while replaying the same report creates no additional sample.

Each sample records its Entity association, report/sample identity, optional observation time, Core receipt time and supplied measurements. Unknown observation time stays explicitly unknown; receipt time provides the labeled fallback for ordering. Existing Asset report-authority and freshness rules still apply. Store samples in SQLite with an index for Entity/time queries; exact columns, report identity encoding and cursor fields remain schema work. Retain samples across Restart until Reset, without a separate 30-day expiry job. Entity deletion must not silently cascade-delete retained observations or attach them to a replacement Entity. Deleted IDs stay reserved under [Entity ID reservation](../topics/tracks-and-geofeatures.md#entity-id-reservation).

Expose one paginated `GET /entities/{entity_id}/movement-history` read with a bounded time range. Return raw samples with their timing and stable ordering, not reconstructed Entity state. Resolve the Entity through its live record or retained Dataset identity/deletion record, including original kind. Deleted Asset/Track IDs remain queryable with an explicit deleted-Entity indicator; an empty interval returns an empty page, while an ID never present in the current Dataset returns not found. A live-Entity lookup must not gate this historical read. Reset clears those historical identities and samples together; retained authentication bindings alone do not create historical coverage. Dataset and Entity association checks plus a stable pagination boundary prevent Reset, identity replacement or concurrent inserts from mixing results. Request bounds and ingestion capacity must be measured against Asset and Track report rates; do not silently sample away observations or truncate a requested interval.

History-only backfill, manual sample editing, server-generated reduced trails, historical-value reconstruction and whole-map replay are deferred. The older pre-identification backfill workflow is therefore not supported initially. A Command Interface can display returned samples without this plan selecting its UI. Movement-history reads are explicit SDK history operations outside the synchronized operational picture; they call the history API in every mode and never populate or advance the live picture. See [SDK data access](../sdk-data-access.md#historical-reads).

## Activity history

Core records which authenticated caller issued or cancelled Tasks and changed Plugins, credentials or configuration, including the Open enrollment setting, plus [Asset retirement](../adr/0019-retire-assets-without-inventing-task-outcomes.md). System operations is the proposed home for a shared recording/query facility; Identity and access supplies actor identity, and each owning module supplies action meaning and affected resources. The facility must not infer business actions from diagnostic log strings. The external Command Interface may render the history.

The initial scope is a small structured log, accepted on 22 September 2026: one SQLite activity table, a shared recording helper and `GET /admin/activity` with pagination and actor/action/target/time filters. Record Task issuance and cancellation requests, plus Plugin, credential and configuration changes. The retirement decision extends this scope with its attributed administrative action. Include local CLI/TUI actions, including while Core is stopped. Ordinary telemetry, resource reads, file contents, full before/after snapshots, tamper-evident auditing, export tooling and general replay are outside this scope.

Records contain a stable action identity, authenticated actor identity/type, action, target, time and known outcome. Preserve attribution after a profile or credential is deleted: each activity record retains the stable authenticated actor ID/type and safe display context captured at the time of the action. Profile deletion removes the editable profile/settings, not these historical facts. Retain them until Reset, with no cascading deletion or reassignment to a replacement identity. A selected Operator profile may provide display context, but a shared credential does not prove which human used it; do not invent that attribution. Store safe change summaries and credential identifiers, never secret values.

For database actions, record the activity in the same transaction as the accepted change. An idempotent retry must not create another logical action. For process operations, record the accepted request and later known outcome linked by action identity; an accepted request is not proof of completion. A crash may leave an outcome unknown. Do not claim a transaction spans the process effect. These records explain a limited set of operational actions, not every rejected request or all external effects.

While Core runs, local management records its actions through the private coordination channel. While Core is stopped, it appends each action to a local activity journal on the installation mount, keyed by action identity and recording the accepted request or its later known outcome. Opening the retained Dataset, or the first Dataset of a new installation, imports the journal inside a write commit before serving and removes entries only after import, so a repeated import creates no duplicate records. First-time setup actions are therefore recorded in the installation's first Dataset. The host coordinator deletes pending entries as part of Reset, together with the managed logs, before it starts Core. The journal is therefore gone before the Reset can be established, and a crash during Reset cannot import pre-Reset activity. Hard Reset deletes the journal. This keeps SQLite accessed only by Core under [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md). Plugins and public clients cannot directly write arbitrary log entries. Read access follows the operator administrative boundary. History queries use explicit SDK methods outside the synchronized picture. Retain the log across Restart and clear it on Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Exact local coordination, field formats, query limits and failure presentation remain implementation details.

## Basic operational protections

Identify the actor for local administrative actions in activity history, including actions performed through CLI/TUI while Core is stopped. The local identity and recording mechanism remain implementation choices and follow the existing Reset retention boundary; they do not require operator roles or another public administration API.

Protect retained credentials with restrictive access to their storage. Keep credentials and provider secrets out of activity history, diagnostic logs and returned error details. Error messages should explain the failure without reproducing secret-bearing inputs or raw provider responses.

Bound request sizes, upload resource use and concurrent/in-flight work. Exceeding a bound must produce an explicit refusal or failure rather than unbounded resource growth or a false success. Object storage has a [quota](../topics/objects.md#storage-quota-and-integrity-faults) that leaves headroom for operational writes. Numeric limits and enforcement mechanisms follow the measured workload; they do not restore the old universal 25-second Operation timeout.

## Generation and testing

Follow [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) for generation policy. Count reusable generator extensions as maintained code and justify them by the independent work they remove. Measure simplicity by independently maintained decisions and effort to change behavior; remove superseded implementations after verification.

Use a pinned toolchain and deterministic regeneration. Independently authored wire examples, public behavior, supported compatibility and real API/storage integration are the test oracles, rather than generated snapshots alone.

Reaffirmed on 28 September 2026: prove the selected Protocol code-generation path and concrete report-acceptance contract in the first relevant implementation slice. Real failure tests remain completion requirements. Removing hybrid narrows the synchronization scope; it does not defer the remaining correctness evidence until after the contract grows.

| Promise | Validation focus |
| --- | --- |
| [Task lifecycle](../topics/tasks.md#task-status-and-transitions) and [scan completion](../topics/tasks.md#scan-completion) | Allowed transitions, terminal outcomes and cancellation; completion report and ready Objects in both arrival orders |
| [Asset retirement](../topics/identity-and-access.md#asset-retirement) | Progress without Asset confirmation; retained evidence and protected results; assignment/provisioning/report races, retry, revocation and Dataset boundaries |
| [Object availability and transfer](../topics/objects.md) | Private staging with cleanup, whole-file retries, completed-request deduplication, ready-only publication and continued uploads without reopening Cancelled Tasks |
| [Plugin Operations](../topics/plugins.md#operations) and [stopping](../topics/plugins.md#protecting-active-work) | Caller disconnection, lost acceptance responses, retained effects and protected local lifecycle changes |
| [Runtime lifecycle](../adr/0015-separate-start-stop-restart-and-reset.md) | Retention and interrupted-work classification; Reset cleanup; writing-release mismatch refusal; rejection of old-dataset submissions with discovery still available |
| [Client and setup compatibility](../adr/0005-allow-compatible-client-versions.md) | Supported versions, unsupported-client rejection and retained configuration/Plugin checks |
| [SDK modes](#sdk-as-the-supported-entry-point) and [access boundaries](../topics/identity-and-access.md#callers-and-permissions) | Full-picture reads for every authenticated client with optional synchronization; allowed Plugin Task issuance; assigned-Asset reports on every mutation path; no public Plugin management methods/endpoints |
| [Movement history](#movement-history) | Sparse accepted-report capture, retry deduplication, independent historical reads and retention until Reset |
| [Change publication](#change-publication), [synchronization gaps](#detectable-synchronization-gaps) and [activity history](#activity-history) | Consistent committed changes and attributed actions; slow consumers detect gaps and rebuild a current picture |
| [Operational protections](#basic-operational-protections) | Secret redaction, protected credential storage, local actor attribution and explicit resource-limit failures |
| [Asset report acceptance](#shared-asset-report-acceptance) and [Task transitions](#task-transitions) | Accepted, duplicate and rejected dispositions and independent contact evidence through every reporting path; state-model sequences through the pure transition module |
| [Write commits](#write-commits), [retry identity](#retry-identity) and [Dataset opening](#opening-a-dataset) | Obsolete-Dataset rejection at the commit; first/replay/conflict claims for every retry kind and ended claims for registration, retirement, upload and API-key creation; crash-then-open recovery per module, interrupted Reset completion and activity journal re-import |

The [selected stack](../adr/0016-use-go-sqlite-and-openapi-tooling.md) must also pass a representative generation check without output patches, and [Docker deployment](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) must preserve the lifecycle guarantees across container changes.

### SDK and Core integration requirements

Extensive real SDK–Core integration and behavioral parity testing is an accepted engineering requirement, not an optional follow-up to generated types. The [testing strategy](../testing-strategy.md) defines the required coverage, independent oracles, fault scenarios, bandwidth measurements and release evidence. External systems should be able to reuse that contract suite against the SDK, with a smaller complete-path suite checking the composed system. This confidence depends on tested versions, features and fault conditions; parity is not an unconditional proof that every future gateway or firmware behaves correctly.

### MVP integration checks

The [initial MVP](operating-model.md#initial-mvp) selects simple Move To, independent Elevation Lookup and a separate Object fixture. Exercise them through the SDK against real Core APIs and storage, with a simulated Asset and the example Plugin in its own container.

| Scenario | Acceptance evidence |
| --- | --- |
| Move To | Create an Asset, issue a destination Task, deliver it to the assigned Asset and record its reported outcome without requiring an Object. Exercise cancellation and offline issuance/cancellation followed by Asset-client reconnect reconciliation, including assigned-work retrieval or synchronization, using the accepted Task transitions. |
| Elevation Lookup | Discover the Plugin capability, invoke it for a known fixture position and retrieve the expected elevation. Verify that caller disconnection does not cancel accepted work and that retrying a lost acceptance response retrieves the same Operation. |
| Object transfer | Interrupt an upload, verify that no partial Object is visible, retry from the beginning and compare the downloaded content. Lose the success response and verify that an identical retry returns the same Object with one publication. |
| Plugin lifecycle | Use local management to stop/start the example Plugin while Core remains available. Exercise active-work protection with controlled test timing rather than a slow production algorithm. |
| Stop/Start and Restart | Outside active Asset execution, stop managed Plugins with Core and retain records, ready Objects, setup and logs. Start compatible enabled Plugins with the installation; verify unfinished Core-owned work follows the linked lifecycle decision, without automatic rerun. Report incomplete shutdown rather than claiming success. |
| Reset | Clear operational data, content, transfer state, private Plugin work, activity history and Atlas-managed logs; retain installation setup, installed reference data and Operator profiles/settings. Verify a new Dataset and rejection of obsolete submissions, with interrupted cleanup unable to restore old Plugin work or erase work from an established Reset. |

These are acceptance scenarios, not completed tests. Add them alongside the relevant implementation. Keep the broader scan-result ordering tests in the validation table above for the later scan workflow; do not force Move To and Elevation Lookup into a Task-to-Object-to-Plugin chain.

This is the Core contract milestone. [Later field and extension validation](../testing-strategy.md#core-contract-and-field-validation-milestones) separately checks a real Asset runtime and a Plugin built outside this repository; simulated execution does not prove physical Asset behavior.
