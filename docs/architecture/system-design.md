# Dedicated Atlas systems and shared contracts

Status: accepted direction. [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first plan. [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) retains the generation policy. [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects the technology stack and [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects Docker deployment. These are accepted choices, not completed implementations.

This document owns collaboration rules and interface boundaries. Linked ADRs own the detailed behavioral decisions; the [system outline](system-outline.md) owns the responsibility map. Choices explicitly marked open remain implementation work. The [Modernization comparison](modernization-differences.md) records source differences.

## Architecture

Build the dedicated responsibilities in the [Core system outline](system-outline.md), following [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md). Each module owns its behavior and private data access. Collaborators call explicit interfaces rather than reaching into each other's tables. Keep transactions spanning those interfaces explicit and practical; internal calls can be ordinary code calls.

Storage connections, transactions, API serving, configuration and logging can share concrete utilities. Shared facilities do not establish separate services or a reusable module framework.

[Protocol](../adr/0011-generate-shared-contracts-with-minimal-customization.md) owns shared external contracts. Core implements their guarantees; SDK exposes consumer access. Public wire types may be used directly where they fit, with a small explicit conversion where internal meaning differs.

## SDK as the supported entry point

External operational API consumers, including applications, Assets and Plugins, use the SDK to interact with Core. The local CLI/TUI administers the installation through internal management interfaces and does not use the SDK or public API. A health-check client, Command Interface and data-processing Plugin use the same supported SDK, with behavior appropriate to their needs.

Provide basic API access without starting a synchronized replica. Applications that need a maintained shared picture opt into synchronization and caching through the SDK. An application's role does not select its mode automatically. The SDK should make both uses clear without duplicating endpoint definitions or requiring a second client library outside it. The agreed modes are HTTP pass-through, full synchronization using local reads/queries/feed, and Asset hybrid using a local related subset plus one-off out-of-scope API reads. Every mode writes to Core. Hybrid filtering saves bandwidth and does not limit read authorization. See [SDK data access](../sdk-data-access.md) for recovery, local history and Dataset Reset behavior. Exact method signatures remain open. All external API interaction goes through the SDK, including Object upload and download.

Keep the Core API small and explicit. The SDK owns client-side conveniences such as whole-file upload retries, pagination, submission retry identity and waiting for Operation outcomes. These helpers compose supported API operations and live separately from generated bindings; they do not duplicate endpoint contracts or patch generated code. Add helpers for actual consumer workflows, not a general workflow engine.

Core remains responsible for authentication, authorization, Task transitions, Object readiness and committed-state consistency at its API boundary. The SDK is the supported client entry point, not a substitute for those server responsibilities.

## Local administration

The CLI and TUI share a local management implementation for Core lifecycle, Reset, Hard Reset, updates and installed Plugin management. They use private internal coordination, not the public API or SDK. Local tooling can start Core when it is stopped. Core's Plugins module owns its lifecycle policy; local tools coordinate with it instead of duplicating the rules.

Plugin installation, removal, updates, configuration, enable/disable, start/stop/restart and force stop have no public API endpoints or SDK methods and are outside public Protocol generation. Public consumers can discover Plugin capabilities/status, invoke Operations, query outcomes and request Operation cancellation. Canceling an Operation is distinct from stopping its Plugin. This supersedes the earlier Command Interface Plugin restart action; that application can still display faults.

Local administrative actions contribute to [activity history](#activity-history). [ADR-0002](../adr/0002-core-manages-installed-plugins.md) defines independent Plugin lifecycles, and [ADR-0006](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md) defines active-work protection.

Use the private Docker integration described in [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md). Its host-versus-Core placement, coordination channel and installation/update workflows remain open; no separate management service is required.

[Hard Reset](../adr/0015-separate-start-stop-restart-and-reset.md#hard-reset) is a separate local CLI/TUI action available while Core is running. Its coordinator stops Core and managed Plugins, wipes operational and installation state, and returns to first-time setup. Ordinary Reset preserves Operator profiles, personal settings and installation setup. Neither reset action adds a public endpoint or SDK lifecycle method.

## Identity and access

Every authenticated SDK client, including an Asset or Plugin, may read all operational data through the public API. An authenticated client identity, including managed Plugin integration identity, permits full-picture snapshots and replay as well as individual resource, Object and Operation reads. There are no per-Asset or per-Plugin read filters. Clients still choose basic API access or opt-in synchronization; permission to see everything does not require downloading everything.

All authenticated operators have full control. Existing execution-report and local-administration boundaries remain below. The proposed additional caller-scoped Operation retry and upload-handle ownership rules are not adopted; submission identity retains its existing dataset scope:

- Each Asset has its own authenticated identity, provisioned automatically during enrollment without a manual per-Asset key-management workflow. Deployment tooling supplies enrollment authorization, and the SDK performs registration and identity provisioning automatically without an approval click for each new Asset. The exact bootstrap credential, proof and relay mechanism remain engineering choices; the Asset URL or claimed ID alone does not authorize enrollment. Asset credentials cannot act as another Asset or administer Core. Core checks that reported Entity state comes from that Asset and an execution report comes from the Asset assigned to the Task; a claimed Asset ID in a request is not sufficient. Apply this check on every path that can record Asset execution, including any generic resource mutation path.
- Plugins use ordinary SDK operational APIs across sources, including creating and canceling Tasks with existing Commands. They cannot impersonate an Asset's execution reports. Core provides managed Plugin integration identity; operators do not provision or rotate individual Plugin API keys. That identity cannot manage Atlas credentials, change Core configuration, control Core lifecycle, or install/manage Plugins. Plugin installation/configuration and Core/Plugin process lifecycle are local CLI/TUI controls, absent from the public API and SDK. Credential administration remains separate from Plugin operational access.
- SDK method availability does not grant permission. Core enforces authorization at the API boundary. Keep enrollment simple; credential formats, setup mechanics and route bindings remain implementation choices.

Plugins are trusted code with broad operational access, not isolated tenants. These API rules do not promise host-process sandboxing. A trusted Plugin may receive provider credentials for its own integration. A credential broker or Source Gateway is optional; Atlas does not promise that provider secrets are always hidden from Plugins. Datastream delivery is not a selected successor capability.

Asset principal/ID bindings are installation state retained with credentials across ordinary Reset. All Entity creation checks them, and re-registering a cleared Asset requires proof of its surviving identity. A different principal cannot acquire that ID. See [retained identity after Reset](../adr/0015-separate-start-stop-restart-and-reset.md#retained-asset-identity-after-reset).

### API-key creation retries

Administrative clients prepare an API key locally before requesting creation. The SDK uses a cryptographically secure generator for a secret containing at least 32 random bytes, allocates a stable creation/key identity, and hands the prepared credential to the caller for secure retention before submission. It does not generate a replacement secret on a transport retry. Keep prepared secrets out of diagnostic logs, activity records and ordinary resource caches; caller-side secure storage is explicit, not an SDK operational-picture persistence feature.

`POST /admin/auth/api-keys` accepts the prepared identity, secret and descriptive metadata under an existing administrative credential over an authenticated encrypted transport. Core validates the key format, stores only a verifier plus canonical request facts, and returns metadata without a secret. This supersedes the earlier server-generated, one-time secret response: the caller already has the secret, so losing Core's response cannot lose the key. Non-SDK administrative clients follow the same generation and retention requirements.

Commit the creation identity and credential together, scoped to the installation and bound to the authenticated administrative principal. Concurrent matching retries return the same key metadata; changed secret or initial metadata under the same identity fails explicitly. Compare against original facts, not editable current metadata. A revoked key remains revoked on retry and returns an explicit revoked outcome. Retain creation records across Restart, ordinary Reset and revocation until Hard Reset; key secrets are never recoverable through list/read APIs. Retrying still requires current administrative authorization and the current Dataset precondition where applicable. The SDK must not silently relabel a pre-Reset request; ordinary Reset's retained credentials do not bypass the Dataset boundary. Exact wire encoding and verifier scheme remain implementation details.

### Credential revocation

Revocation applies to ongoing access as well as new HTTP requests. Core tracks live feed connections by authenticated credential, stops authorizing further event delivery when revocation commits, and terminates those connections. Reconnects and recovery calls with that credential fail. Serialize the relevant authorization check with revocation or use equivalent cancellation so already-queued events do not bypass it. Data already transmitted or copied into a client's picture cannot be recalled.

The SDK treats the resulting authorization failure as requiring replacement credentials rather than endless automatic retry with a revoked key. This does not introduce new client-side role rules or pretend to erase previously delivered data. Exact connection-close/error encoding remains Protocol work.

### Asset deletion and access

An allowed Asset deletion also decommissions its authenticated access. Core atomically commits Entity deletion, its retained identity reservation, revocation of every credential bound to that Asset and the deletion change. Serialize deletion against credential provisioning, registration retries, new Task assignment and reporting so none can leave a usable credential or newly assigned Task for a deleted Asset. The existing nonterminal-Task guard remains: rejecting deletion leaves both the Entity and its credentials unchanged. Track and Geofeature deletion does not revoke unrelated identities.

At revocation commit, stop authorizing new reads, writes and feed delivery for those credentials and terminate their live feed connections under the [revocation rule](#credential-revocation). A queued event cannot bypass revocation. Previously transmitted data cannot be recalled. Retain revoked credential state across Restart and ordinary Reset; Reset does not reactivate the removed device. Registration retries cannot resurrect its deleted identity or revive revoked credentials. A deliberate new enrollment must satisfy the current enrollment policy and use a permitted new identity. Keep historical Task, Object and movement associations under the existing retention rules. No separate decommission endpoint is required.

## Bandwidth and authenticated reporting

Design for normal Internet connectivity at Core and constrained links toward Assets. SDK ownership of the client pipeline is intended to permit later transport optimization without changing the meaning of Task, Entity or Object operations. Prefer partial component updates, the Asset hybrid scope, stable retry identities and bounded recovery over repeated full snapshots. Filter before transmission. Do not require the full command catalog, identity metadata or an enrollment exchange on each telemetry update.

Authentication resolves a stable principal kind and, for Assets, its bound Asset ID. Enforce that binding on every reporting path. Provision Asset identities automatically during enrollment and managed Plugin identities through Core. The bootstrap proof, credential encoding, relay delegation and compact authenticated transport remain design work; a gateway connection or a short claimed Asset ID alone is not proof of the originating Asset. Revocation and Dataset boundaries must survive any optimization.

HTTP/OpenAPI remains the selected Core boundary. A future radio transport may encode the same operations compactly and translate through a gateway SDK; no radio packet format, compression algorithm, batching protocol or per-packet overhead guarantee is selected here. Measure application payload bytes, actual transport bytes, retries and recovery separately on representative workloads. See the [integration and parity requirements](../testing-strategy.md).

## Objects hide storage

Clients identify Objects and access their content through Core APIs exposed by the SDK. Physical buckets, filesystem paths and storage-provider details stay inside the Objects implementation, outside public Object fields and Plugin integration requirements.

[ADR-0009](../adr/0009-expose-objects-only-when-ready.md) owns ready-only visibility, private staging, restart-from-beginning upload retries and completed-request deduplication. [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md) owns retention and Reset cleanup across metadata, content and transfer state. Objects implements these guarantees independently of the selected storage provider.

[ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects SQLite and private local Object files. Resumable uploads are deferred; failed transfers restart from the beginning.

## Core tasking and Asset execution

Tasks implements the [Core-owned Command boundary](../adr/0004-core-owns-commands-and-assets-execute-tasks.md), [Task reconciliation](../adr/0007-reconcile-asset-tasks-after-disconnection.md) and [scan result/status contract](../adr/0008-complete-scan-tasks-when-required-results-are-available.md). It validates Command/target contracts and uses [Identity and access](#identity-and-access) for assigned-Asset reporting.

The Asset OS owns execution, interruption and its confirmed onboard queue. Core records immutable submission order and operator reorder requests separately from Asset-confirmed order. Assets execute queued Tasks sequentially in submission order by default, following confirmed reordering of eligible, unstarted queued Tasks; a disconnected Asset may continue its last confirmed order. Immediate Commands are ordinary Tasks that can overlap queued work. Immediate Pause interrupts current queued work, and the Asset reports its paused condition and waits without advancing the queue. Core records intent and outcomes without starting Tasks or gating them on connectivity. See [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md).

Asset check-in and component patches share Protocol-defined partial-update validation, report identity and freshness rules. Core verifies authorship across every reporting path; ordinary operator edits cannot manufacture Asset contact. Registration through Entity creation and subsequent check-in are documented in the [SDK operations catalog](../sdk-operations.md). This replaces the separate execution-runtime registration API.

Registration/fencing machinery from Modernization is not a required subsystem. Reject unauthorized, duplicate or obsolete reports through the smallest contract satisfying these guarantees. Exact reconciliation messages remain open.

## Plugin Operations

[ADR-0002](../adr/0002-core-manages-installed-plugins.md) owns accepted attempts, submission retry identity and retained effects. [ADR-0006](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md) owns stopping and fault outcomes. Plugins implements these contracts separately from Tasks. Use Plugin packaging for an internal capability only when it needs the independently managed extension lifecycle.

SDK helpers manage submission identity and outcome queries; the server remains responsible for acceptance and recorded outcomes. Operations can run beyond an individual HTTP request. [Identity and access](#identity-and-access) allows trusted Plugins to use operational data across sources and issue Asset Tasks, while reserving execution reporting for the assigned Asset and administration for its designated interfaces.

A separate Core-owned Operation attempt record stores submission identity, Plugin/release/capability, input, state, progress and known outcomes. Commit acceptance before dispatch; preserve attempts across Plugin removal and Restart until Reset. Submission retry uniqueness prevents duplicate acceptance, not arbitrary duplicate external effects. See the [storage catalog](../data-components.md#core-support-records).

Removing a Plugin withdraws its capability and any UI contribution; retained results follow their own lifecycle.

[ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) selects a separate Docker container per installed Plugin. Invocation fields, Plugin manifest/distribution details and any UI contribution contract remain open. If supported, Core may expose contribution metadata or serve static assets; the external Command Interface owns rendering, navigation, map interaction and resource views. UI delivery is not a selected implementation.

## Change publication

The module making a change supplies its public representation. This ownership rule is accepted. The write-owning module commits its mutation and change record together in SQLite. A private ordered change log includes replay payloads and deletion records; both feed delivery and changed-since read the committed log. Shared publication code delivers committed records in an order consistent with state. For example, Tasks describes a Task status change; delivery code does not inspect private Task tables to reconstruct its meaning.

This keeps a useful shared delivery function small. It does not establish a general event bus or require every internal call to emit an event. Preserve consistency between resource changes and their published records within the current run.

## Detectable synchronization gaps

Core must not silently drop committed changes while allowing a consumer to treat its picture as current. When a slow consumer, expired replay history or another delivery gap prevents complete replay, make that condition detectable through the synchronization contract. The SDK marks its picture stale and obtains a fresh snapshot with a consistent continuation point before treating it as current again.

Retain a bounded replay window and an explicit earliest recoverable boundary, updated consistently with pruning. Restart retains the remaining window; Reset creates a new Dataset. Scope entry/removal and deletion must be recoverable for Asset hybrid clients without transmitting the full picture. Exact payloads, scope rules, buffer sizes, transport signaling and numeric replay limits remain implementation choices. Full-picture read access is available to every authenticated SDK client; automatic synchronization is still opt-in. Dataset changes additionally follow [the Reset boundary](../adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary).

## Movement history

The initial scope is a small Core store for reported Asset and Track movement, accepted on 22 September 2026. Entities captures position, speed and altitude from accepted ordinary create/update/check-in reports into a separate append-only sample table, in the same transaction as the current-state write. Do not store whole Entity snapshots or infer measurements from the merged Entity. Capture only explicitly supplied quantities: a position requires a complete latitude/longitude pair; speed-only and altitude-only samples are valid; unrelated changes add no sample. A fresh report repeating a stationary position is still an observation, while replaying the same report creates no additional sample.

Each sample records its Entity association, report/sample identity, optional observation time, Core receipt time and supplied measurements. Unknown observation time stays explicitly unknown; receipt time provides the labeled fallback for ordering. Existing Asset report-authority and freshness rules still apply. Store samples in SQLite with an index for Entity/time queries; exact columns, report identity encoding and cursor fields remain schema work. Retain samples across Restart until Reset, without a separate 30-day expiry job. Entity deletion must not silently cascade-delete retained observations or attach them to a replacement Entity. Reserve Entity IDs atomically on creation and retain their deletion markers across Restart until Reset; new Entities cannot reuse them. The same reservation preserves historical Task assignments and Object associations.

Expose one paginated `GET /entities/{entity_id}/movement-history` read with a bounded time range. Return raw samples with their timing and stable ordering, not reconstructed Entity state. Resolve the Entity through its live record or retained Dataset identity/deletion record, including original kind. Deleted Asset/Track IDs remain queryable with an explicit deleted-Entity indicator; an empty interval returns an empty page, while an ID never present in the current Dataset returns not found. A live-Entity lookup must not gate this historical read. Reset clears those historical identities and samples together; retained authentication bindings alone do not create historical coverage. Dataset and Entity association checks plus a stable pagination boundary prevent Reset, identity replacement or concurrent inserts from mixing results. Request bounds and ingestion capacity must be measured against Asset and Track report rates; do not silently sample away observations or truncate a requested interval.

History-only backfill, manual sample editing, server-generated reduced trails, historical-value reconstruction and whole-map replay are deferred. The older pre-identification backfill workflow is therefore not supported initially. A Command Interface can display returned samples without this plan selecting its UI. Movement-history reads are explicit SDK history operations outside the synchronized operational picture; they call the history API in every mode and never populate or advance the live picture. See [SDK data access](../sdk-data-access.md#historical-reads).

## Activity history

Core records who issued or canceled Tasks and who changed Plugins, credentials or configuration. System operations is the proposed home for a shared recording/query facility; Identity and access supplies actor identity, and each owning module supplies action meaning and affected resources. The facility must not infer business actions from diagnostic log strings. The external Command Interface may render the history.

The initial scope is a small structured log, accepted on 22 September 2026: one SQLite activity table, a shared recording helper and `GET /admin/activity` with pagination and actor/action/target/time filters. Record Task issuance and cancellation requests, plus Plugin, credential and configuration changes. Include local CLI/TUI actions, including while Core is stopped. Ordinary telemetry, resource reads, file contents, full before/after snapshots, tamper-evident auditing, export tooling and general replay are outside this scope.

Records contain a stable action identity, authenticated actor identity/type, action, target, time and known outcome. Preserve attribution after a profile or credential is deleted: each activity record retains the stable authenticated actor ID/type and safe display context captured at the time of the action. Profile deletion removes the editable profile/settings, not these historical facts. Retain them until Reset, with no cascading deletion or reassignment to a replacement identity. A selected Operator profile may provide display context, but a shared credential does not prove which human used it; do not invent that attribution. Store safe change summaries and credential identifiers, never secret values.

For database actions, record the activity in the same transaction as the accepted change. An idempotent retry must not create another logical action. For process operations, record the accepted request and later known outcome linked by action identity; an accepted request is not proof of completion. A crash may leave an outcome unknown. Do not claim a transaction spans the process effect. These records explain a limited set of operational actions, not every rejected request or all external effects.

The local CLI/TUI uses the same private management recording facility while Core is stopped; Plugins and public clients cannot directly write arbitrary log entries. Read access follows the operator administrative boundary. History queries use explicit SDK methods outside the synchronized picture. Retain the log across Restart and clear it on Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Exact local coordination, field formats, query limits and failure presentation remain implementation details.

## Basic operational protections

Identify the actor for local administrative actions in activity history, including actions performed through CLI/TUI while Core is stopped. The local identity and recording mechanism remain implementation choices and follow the existing Reset retention boundary; they do not require operator roles or another public administration API.

Protect retained credentials with restrictive access to their storage and provide local replacement/revocation where applicable. Keep credentials and provider secrets out of activity history, diagnostic logs and returned error details. Error messages should explain the failure without reproducing secret-bearing inputs or raw provider responses.

Bound request sizes, upload resource use and concurrent/in-flight work. Exceeding a bound must produce an explicit refusal or failure rather than unbounded resource growth or a false success. Numeric limits and enforcement mechanisms follow the measured workload; they do not restore the old universal 25-second Operation timeout.

## Generation and testing

Follow [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) for generation policy. Count reusable generator extensions as maintained code and justify them by the independent work they remove. Measure simplicity by independently maintained decisions and effort to change behavior; remove superseded implementations after verification.

Use a pinned toolchain and deterministic regeneration. Independently authored wire examples, public behavior, supported compatibility and real API/storage integration are the test oracles, rather than generated snapshots alone.

| Promise | Validation focus |
| --- | --- |
| [Task reconciliation](../adr/0007-reconcile-asset-tasks-after-disconnection.md) and [scan completion](../adr/0008-complete-scan-tasks-when-required-results-are-available.md) | Allowed transitions, terminal outcomes and cancellation; completion report and ready Objects in both arrival orders |
| [Object availability and transfer](../adr/0009-expose-objects-only-when-ready.md) | Private staging with cleanup, whole-file retries, completed-request deduplication, ready-only publication and continued uploads without reopening Canceled Tasks |
| [Plugin attempts](../adr/0002-core-manages-installed-plugins.md) and [stopping](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md) | Caller disconnection, lost acceptance responses, retained effects and protected local lifecycle changes |
| [Runtime lifecycle](../adr/0015-separate-start-stop-restart-and-reset.md) | Retention and interrupted-work classification; Reset cleanup; writing-release mismatch refusal; rejection of old-dataset submissions with discovery still available |
| [Client and setup compatibility](../adr/0005-allow-compatible-client-versions.md) | Supported versions, unsupported-client rejection and retained configuration/Plugin checks |
| [SDK modes](#sdk-as-the-supported-entry-point) and [access boundaries](#identity-and-access) | Full-picture reads for every authenticated client with optional synchronization; allowed Plugin Task issuance; assigned-Asset reports on every mutation path; no public Plugin management methods/endpoints |
| [Movement history](#movement-history) | Sparse accepted-report capture, retry deduplication, independent historical reads and retention until Reset |
| [Change publication](#change-publication), [synchronization gaps](#detectable-synchronization-gaps) and [activity history](#activity-history) | Consistent committed changes and attributed actions; slow consumers detect gaps and rebuild a current picture |
| [Operational protections](#basic-operational-protections) | Secret redaction, protected credential storage, local actor attribution and explicit resource-limit failures |

The [selected stack](../adr/0016-use-go-sqlite-and-openapi-tooling.md) must also pass a representative generation check without output patches, and [Docker deployment](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) must preserve the lifecycle guarantees across container changes.

### SDK and Core integration requirements

Extensive real SDK–Core integration and behavioral parity testing is an accepted engineering requirement, not an optional follow-up to generated types. The [testing strategy](../testing-strategy.md) defines the required coverage, independent oracles, fault scenarios, bandwidth measurements and release evidence. External systems should be able to reuse that contract suite against the SDK, with a smaller complete-path suite checking the composed system. This confidence depends on tested versions, features and fault conditions; parity is not an unconditional proof that every future gateway or firmware behaves correctly.

### MVP integration checks

The [initial MVP](operating-model.md#initial-mvp) selects simple Move To, independent Elevation Lookup and a separate Object fixture. Exercise them through the SDK against real Core APIs and storage, with a simulated Asset and the example Plugin in its own container.

| Scenario | Acceptance evidence |
| --- | --- |
| Move To | Create an Asset, issue a destination Task, deliver it to the assigned Asset and record its reported outcome without requiring an Object. Exercise cancellation and offline issuance/cancellation followed by check-in, using the accepted Task transitions. |
| Elevation Lookup | Discover the Plugin capability, invoke it for a known fixture position and retrieve the expected elevation. Verify that caller disconnection does not cancel accepted work and that retrying a lost acceptance response retrieves the same Operation. |
| Object transfer | Interrupt an upload, verify that no partial Object is visible, retry from the beginning and compare the downloaded content. Lose the success response and verify that an identical retry returns the same Object with one publication. |
| Plugin lifecycle | Use local management to stop/start the example Plugin while Core remains available. Exercise active-work protection with controlled test timing rather than a slow production algorithm. |
| Stop/Start and Restart | Outside active Asset execution, retain records, ready Objects, setup and logs. Verify unfinished Core-owned work follows the linked lifecycle decision, without automatic rerun. |
| Reset | Clear operational data, content, transfer state, activity history and Atlas-managed logs; retain startup setup and Operator profiles/settings. Verify a new dataset and rejection of obsolete submissions. |

These are acceptance scenarios, not completed tests. Add them alongside the relevant implementation. Keep the broader scan-result ordering tests in the validation table above for the later scan workflow; do not force Move To and Elevation Lookup into a Task-to-Object-to-Plugin chain.
