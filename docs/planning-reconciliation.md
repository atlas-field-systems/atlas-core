# API planning reconciliation

Status: the API/architecture recommendations were accepted on 22 September 2026. The endpoint map, SDK plans, canonical glossary and affected ADRs now record those decisions. Manual Plugin configuration recovery closes the last reconciliation choice. No runtime implementation is introduced.

The planning session and architecture merged in PR #1 originally disagreed. This record explains the resolutions; [the documentation guide](agents/domain.md) still assigns authority to the glossary, architecture and ADRs. The separate planning glossary has been consolidated into [CONTEXT.md](../CONTEXT.md).

This is a dated decision history. The [28 September SDK decision](#sdk-and-gateway-decisions-28-september-2026) supersedes the Asset hybrid portions below. Other accepted behavior remains in force.

The [28 September Plugin storage decision](#plugin-storage-decision-28-september-2026) extends Reset to Plugin-private operational storage.

The [first documentation grilling round](#documentation-grilling-round-one-28-september-2026) additionally settles descriptive-edit conflicts, Track publishers, required Entity-reference deletion and private Plugin work on uninstall.

The [second round](#documentation-grilling-round-two-28-september-2026) settles publisher continuity, live Geofeature geometry, full Plugin-owned uninstall cleanup and silent Track retention.

The [third round](#documentation-grilling-round-three-28-september-2026) settles offline geometry, adoption evidence, the scan collection boundary and Command-specific Track freshness.

The [fourth round](#documentation-grilling-round-four-28-september-2026) settles current-observation corrections and defers publisher transfers, closing the product choices raised in these rounds.

The [documentation weak-spot review](#documentation-weak-spot-review-28-september-2026) settles identity lifetime, Open enrollment, gateway identity, IP-connected Assets, cancellation declined, control validity, Core time, geometry cutoffs, Object storage limits and glossary terms.

## Accepted resolutions

| Topic | Resolution | Authoritative detail |
| --- | --- | --- |
| Access | Broad operational reads and no operator roles; Core enforces Asset ownership of reported state and assigned Task execution. Automatically provision Asset identity during enrollment. Managed Plugins need no operator-managed keys and cannot impersonate Assets or administer Core | [Identity and access](topics/identity-and-access.md) |
| Plugin administration | Installation, configuration and process controls are local CLI/TUI actions. Public clients discover Plugins, submit Operations, query outcomes and request cancellation | [Local administration](architecture/system-design.md#local-administration), [endpoint map](api-endpoints.md#plugins) |
| Plugin taskability | Plugins are not Assets; remove the inherited `custom_plugin` component. Plugins may create Tasks for real Assets through existing Commands | [ADR-0004](adr/0004-core-owns-commands-and-assets-execute-tasks.md), [component catalog](data-components.md) |
| Plugin Operations | Durable attempts with progress, outputs and confirmed outcomes can continue after caller disconnection. Retries retrieve an attempt; deliberate reruns create another | [ADR-0002](adr/0002-core-manages-installed-plugins.md) |
| Task cancellation | Use nonterminal cancellation_requested status and assigned-Asset-confirmed cancelled; preserve execution facts and do not infer a stop from the request | [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) |
| Task order | Core records immutable submission order and requested versus Asset-confirmed reorder state. Assets execute queued Tasks sequentially by default and can follow their last confirmed order while disconnected; Core does not start Tasks or gate on connectivity | [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) |
| Objects | Stage upload identity and metadata separately. Publish only ready Objects; content is immutable, descriptive metadata remains editable | [ADR-0009](adr/0009-expose-objects-only-when-ready.md) |
| Compatibility | Allow explicitly supported compatible versions and reject unsupported clients. Validate Asset Command support. SDK Command Catalog lookup stays local | [ADR-0005](adr/0005-allow-compatible-client-versions.md), [SDK access](sdk-data-access.md#protocol-compatibility) |
| Storage | SQLite with typed relational fields and validated JSON. OpenAPI defines public contracts; private SQL defines storage and sqlc generates access code. Do not generate tables from public resource models | [ADR-0016](adr/0016-use-go-sqlite-and-openapi-tooling.md), [component catalog](data-components.md) |
| Vocabulary | Tracks can be stationary or moving; Geofeatures are defined spatial designations with geometry. One canonical glossary | [CONTEXT.md](../CONTEXT.md) |
| Reset | Every SDK mode checks Dataset identity; discard obsolete pictures, history, responses and pending submissions without replaying old writes into a new Dataset | [ADR-0015](adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary), [SDK boundary](sdk-data-access.md#dataset-reset-boundary) |
| Scan completion | Require the assigned Asset's completion report and all its declared required ready Objects, in either arrival order | [ADR-0008](adr/0008-complete-scan-tasks-when-required-results-are-available.md) |
| Hybrid scope, superseded 28 September | Originally selected transmission filtering with local in-scope reads and one-off HTTP outside scope. Now deferred with matching Core machinery | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md) |

## Scope review after PR feedback

On 22 September 2026 the user accepted the lower-complexity options after reviewing the older Atlas implementation:

- Uploads restart from the beginning after interruption. Resumability is deferred. Safe staging, cleanup, ready-only publication and recognition of a completed retry remain required. [ADR-0009](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries) supersedes the earlier same-run resume promise, including partial-transfer retention.
- Movement history is a small Core sample store with one paginated read, explicit report capture and retry deduplication, retained until Reset. Backfill, historical editing, reduced trails and historical-state reconstruction are deferred. [Movement contract](architecture/system-design.md#movement-history).
- Activity history is a small structured log for Task issuance/cancellation, Asset retirement and Plugin, credential and configuration changes, including local management, with honest authenticated attribution, no secrets and retention until Reset. [Activity contract](architecture/system-design.md#activity-history).

These historical reads use explicit SDK API methods outside the synchronized picture. They do not change the source-selection rules for live reads, local queries or feed subscriptions. The component catalog and endpoint map now include both stores and their read routes.

## Plugin configuration recovery

Accepted: if applying saved Plugin settings prevents startup, leave the Plugin faulted and report the failed apply. The local operator explicitly restores the last working settings and restarts, or corrects the candidate and applies again. Preserve the failed candidate and last working revision; do not automatically restore, restart or rerun Operations. [ADR-0006](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md#local-configuration) owns this policy and the save/apply and active-work rules.

## Latest review decisions

Accepted after the five follow-up review findings: cancellation intent is `cancellation_requested` in the Task status system, with assigned-Asset `cancelled` confirmation. One status-update endpoint replaces separate lifecycle endpoints. Queue edits submit the complete eligible unstarted list with expected revisions; Assets report adoption or conflict. Started Tasks cannot be reordered. [Task contract](adr/0007-reconcile-asset-tasks-after-disconnection.md).

The storage inventory now includes durable Operation attempts, bounded synchronization changes/deletion records and retention boundaries, plus authenticated principal kind and Asset binding. Asset enrollment remains automatic, and Plugins do not acquire a manual key-management workflow. [Catalog](data-components.md).

Extensive real SDK–Core integration and behavioral parity tests are required, with reusable external-system scenarios, failure injection and measured bandwidth. Composed gateway/firmware tests supplement pairwise parity. [Testing strategy](testing-strategy.md). The later [gateway decision](adr/0020-limit-general-sdk-to-http-and-full-sync.md) places constrained transport between gateways and Assets and defers Core-scoped synchronization; useful partial reports and transport validation remain required without selecting a radio encoding now. [Bandwidth contract](architecture/system-design.md#bandwidth-and-authenticated-reporting).

Immediate Commands and paused Asset/Task states are now accepted under the [Task contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling). Pause is an immediate Task that interrupts current queued work, puts the Asset into its own idle/holding behavior, and preserves the queued path. Independent immediate actions can overlap movement without changing the path. An immediate Resume Command continues the interrupted Task before the remaining queue; unsafe-to-resume work reports failure. Newer Pause/Resume intent wins; failed resumption leaves the Asset paused until a new explicit Resume. Command-specific validity and optional deadlines are checked by the Asset. Unexpected process restarts require reconciliation and holding uncertain work before execution. Exact schemas, authentication/enrollment proof, Task/queue report envelopes, whole-file upload retry verification and SDK method signatures remain implementation design work.


## Latest grilling decisions

The user accepted Command-specific immediate validity rules and optional deadlines, newer Pause/Resume intent winning over delayed older controls, holding the queue after unsafe resumption, limited reconciliation after unexpected Asset-process restart, and automatic SDK enrollment using deployment-provided authorization. The [Task contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#control-ordering-and-expiry) and [identity contract](architecture/system-design.md#identity-and-access) define these boundaries.

Completed Tasks cannot be deleted; ordinary interfaces may hide past Tasks without deleting their records. On 23 September 2026 the user extended required-result protection to run from declaration acceptance until Reset, including unfinished Tasks and pending uploads. The [Object contract](adr/0009-expose-objects-only-when-ready.md#required-result-protection) bases protection on authoritative Task references, prevents metadata bypass, and serializes declaration/publication/deletion checks. Optional attachments are not automatically protected.

## Architecture review decisions, 23 September 2026

The [decision authority rules](agents/domain.md#decision-authority) govern acceptance of review suggestions. The following decisions resolve the discussed recommendations, without claiming implementation:

| Topic | Disposition | Authoritative detail |
| --- | --- | --- |
| Asset reporting authority | Establish private process/report authority before implementing recovery; exact proof and ordering remain engineering work | [Recovery](adr/0007-reconcile-asset-tasks-after-disconnection.md#recovery-after-an-unexpected-asset-restart) |
| Asset replica, superseded 28 September | Hybrid delivery is deferred. Commands may still require live resource updates; full sync and future radio integration must preserve their meaning | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md) |
| Write confirmation | Return Core's committed result without waiting for the local picture; Task acceptance does not establish Asset receipt or execution | [ADR-0018](adr/0018-confirm-writes-when-core-commits.md) |
| Plugin lifetime | Plugins operate with Core and stop when it is spun down; local management mechanics remain engineering choices | [Runtime lifetime](adr/0015-separate-start-stop-restart-and-reset.md#core-and-plugin-runtime-lifetime) |
| Scan results | Evaluate upload-first; either-order reporting and declaration-time protection remain accepted until a successor decision. Completed still requires usable results | [Evaluation boundary](adr/0008-complete-scan-tasks-when-required-results-are-available.md#upload-first-evaluation) |
| Testing | Separate simulated Core contract evidence from later real-Asset and independent-Plugin evidence | [Milestones](testing-strategy.md#core-contract-and-field-validation-milestones) |
| Initial SDK | TypeScript is sufficient to start; keep mandatory SDK use without requiring another language | [Stack](adr/0016-use-go-sqlite-and-openapi-tooling.md#tradeoffs-and-implementation-checks) |

Keep cancellation requests and queue reordering under their [existing contracts](adr/0007-reconcile-asset-tasks-after-disconnection.md), not new Commands/Tasks. Retain [Protocol-defined components](data-components.md#component-definitions), Entity identity reservations and the exclusion of active mission continuity across Core restart. A single UUID/hash is not accepted as a replacement for all retry, authorization and retention rules. Retained setup evolution and local activity recording while Core is stopped still need concrete engineering designs; this review does not select a database split or a migration tool.

## Module ownership decisions, 26 September 2026

The user accepted all three ownership directions from the documentation architecture review. They refine the dedicated-module design without introducing implementation or changing the existing lifecycle, Object or synchronization guarantees.

| Topic | Accepted direction | Authoritative detail |
| --- | --- | --- |
| Local lifecycle | One shared host-side management module owns Docker control, lifecycle execution and interrupted-action recovery; Core retains Plugin policy | [Local lifecycle coordination](architecture/system-design.md#local-lifecycle-coordination), [host placement](adr/0017-deploy-core-and-plugins-as-docker-containers.md#ownership-and-lifecycle) |
| Object publication | Objects keeps publication and recovery together; durable content precedes the ready metadata/retry identity/change-record commit. Tasks retains required-result declarations and transitions | [Object ownership](architecture/system-design.md#object-publication-and-recovery-ownership), [publication ordering](adr/0009-expose-objects-only-when-ready.md#publication-and-recovery-ordering) |
| SDK picture | One SDK module owns coupled picture state. Only snapshot/feed/replay update it; write responses confirm the write without entering reconciliation | [Picture ownership](sdk-data-access.md#local-operational-picture-ownership), [write confirmation](adr/0018-confirm-writes-when-core-commits.md) |

The user selected host-side Docker control, file-first publication and synchronization-only picture updates in the same review. Engineering still needs to specify supervision and private coordination, filesystem durability primitives and SDK wire/interface shapes under these decisions. These remaining details do not reopen the selected ownership or add a general runtime, storage or cache framework.

### Reporting and hybrid coverage ownership

In the follow-up review on 26 September 2026, the user accepted two further ownership decisions. These refine internal collaboration; detailed behavior and interface choices remain open where the linked contracts say so.

The hybrid coverage decision and subset-retention choices in this section were superseded on 28 September by [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). Report acceptance, typed Command references and Core's Task retention remain required.

| Topic | Accepted direction | Authoritative detail |
| --- | --- | --- |
| Asset report acceptance | Entities owns shared acceptance; Tasks collaborates in the same transaction and retains Task validation; Identity and access verifies the principal | [Shared acceptance](architecture/system-design.md#shared-asset-report-acceptance) |

The user also selected explicit Protocol-defined Command dependency references, validated by Tasks, and retention of each Asset's terminal Task records in its hybrid subset until Reset. The former hybrid contract recorded these choices and their transfer/memory tradeoff. The user subsequently chose to end subscriptions needed only by terminal Tasks, while retaining shared dependencies needed by other nonterminal Tasks and always retaining the Asset's own Entity. These historical subset rules did not change Core retention or historical references; [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md) now defers the subset itself.

### Asset ownership follow-up

The user accepted both remaining ownership directions from the follow-up architecture report. These are planning decisions, not implemented modules or changes to the accepted reporting and deletion behavior.

| Topic | Accepted direction | Authoritative detail |
| --- | --- | --- |
| Asset report acceptance | Entities owns shared report acceptance state and commit coordination; Identity and access and Tasks retain their domain decisions | [Acceptance ownership](architecture/system-design.md#shared-asset-report-acceptance) |
| Asset deletion | Entities keeps deletion admission, serialization and commit coordination behind its existing interface, collaborating with Tasks, Identity and access, and Synchronization | [Deletion coordination](architecture/system-design.md#asset-deletion-coordination) |

Start with report acceptance when implementing reporting. Define the narrower deletion workflow when implementing deletion. Package layout, private interface shapes and concurrency mechanisms remain engineering work; neither direction adds a general framework or a public operation.

## Module ownership decisions, second review, 26 September 2026

A second architecture review looked for rules that every caller had to repeat. The user accepted all eight deepening directions and the fixes for the contradictions it found. They refine module ownership, including the reporting and hybrid coverage decisions above, without changing what Atlas promises to operators, Assets or Plugins.

| Topic | Accepted direction | Authoritative detail |
| --- | --- | --- |
| Asset reports | Refines shared acceptance in Entities: it decides accepted, duplicate or rejected for every Asset-originated report, separately decides whether the report is fresh contact evidence, and owns process generation; Entities and Tasks apply effects only from its accepted value | [Shared acceptance](architecture/system-design.md#shared-asset-report-acceptance) |
| Write commits | One SQLite database grouped by Dataset or installation lifetime; shared commit code rejects obsolete Datasets and appends module-supplied change and activity records | [Write commits](architecture/system-design.md#write-commits), [storage](adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope) |
| Task transitions | One pure transition module in Tasks decides every lifecycle transition; queue revisions stay separate | [Task transitions](architecture/system-design.md#task-transitions) |
| Asset side of the SDK | One Asset client owns all Asset-originated traffic, report identity, process generation, Pause/Resume correlation, queue adoption and reconnect reconciliation | [Asset client](sdk-operations.md#asset-client) |
| Retry identity | One mechanism returns first, replay, conflict or ended for seven retry kinds; each contract keeps its facts and retention | [Retry identity](architecture/system-design.md#retry-identity) |
| Dataset opening | Every stateful module opens retained or fresh; Reset is Start with a fresh Dataset, completed after interruption by a host-recorded directive | [Opening a Dataset](architecture/system-design.md#opening-a-dataset), [Reset execution](adr/0015-separate-start-stop-restart-and-reset.md#reset-execution) |
| Hybrid dependencies, superseded 28 September | Originally required Tasks to publish dependency sets for Synchronization. Publication and indexing used solely for hybrid coverage are now deferred; typed Command references retain their meaning | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md), [change publication](architecture/system-design.md#change-publication) |
| Required-result holds | Tasks places holds through Objects and learns which held Objects are already published; later publication returns the Tasks whose holds it satisfies, so both arrival orders resolve and the dependency runs one way | [Object ownership](architecture/system-design.md#object-publication-and-recovery-ownership) |

The review also resolved four contradictions between documents:

- **Check-in.** Some documents said check-in reconciles Tasks, while the operations catalog made it an Entity report. Check-in now means only the Entity report, and [reconnect reconciliation](../CONTEXT.md) names the workflow.
- **Queue order.** The responsibility map gave the Asset OS "queue order" while ADR-0007 kept requested and confirmed revisions in Core. The Asset OS owns execution and the confirmed order it adopts; Core records submission sequence, requested revisions and confirmations.
- **Activity while Core is stopped.** Local actions are journaled on the installation mount and imported when the retained Dataset or a new installation's first Dataset opens, keeping SQLite accessed only by Core. This resolves the local activity recording left open in the 23 September architecture review above.
- **Credentials and separate storage.** Separate operational and installation storage could not keep registration and Asset deletion atomic with credential facts. One database grouped by lifetime settles the database split that review left unselected.

## Deep-module review correction, 27 September 2026

The user accepted the revised review direction: optimize the knowledge and coordination removed from callers, not the size of each implementation. [Code conventions](agents/code-conventions.md#structure-and-interfaces) owns that review criterion, including the distinction between hiding mechanisms and exposing meaningful readiness, freshness and uncertainty.

| Topic | Disposition | Authoritative detail |
| --- | --- | --- |
| Unified SDK | Retain one public resource-read, query and feed interface. The three-mode scope selected here was reduced to HTTP and full synchronization on 28 September; the unified interface, local queries, changed-since history and no-fallback semantics remain | [SDK boundary](architecture/system-design.md#sdk-as-the-supported-entry-point), [current mode contract](sdk-data-access.md#agreed-modes) |
| Workflow ownership | Keep complete required coordination behind its existing domain owner. Internal separation is justified by reduced coupling, not by exporting mechanism choices or creating more services | [Architecture](architecture/system-design.md#architecture), [conventions](agents/code-conventions.md#structure-and-interfaces) |
| Asset retirement | Add one owned administrative operation that ends participation without requiring an unavailable Asset to confirm its Task outcomes. Preserve ordinary deletion's guard, retained evidence and required-result protection | [ADR-0019](adr/0019-retire-assets-without-inventing-task-outcomes.md) |

The earlier review's storage-format compatibility change, alternative terminal-Task replication, observation/source ownership model and route-as-one-Task proposal remained hypotheses at this correction, not accepted redesigns. The later [first documentation grilling round](#documentation-grilling-round-one-28-september-2026) accepts one publisher per Track; it does not adopt the earlier observation redesign as a whole. This correction changes none of their existing contracts and adds no new planning tickets. Existing workload measurement and real-Asset validation requirements remain required; the correction does not claim that those tests ran.

Retirement is the deliberate new behavior, not a relabeling of existing deletion. Its exact wire binding and SDK method remain to be designed within the agreed single-operation boundary. Other simplifications require their own evidence and an explicit scope decision before changing supported behavior.

The subsequent full-document review assigns publication-triggered Task completion to [Objects' publication workflow](architecture/system-design.md#object-publication-and-recovery-ownership), with Tasks retaining transition decisions. This supersedes the second review's upload-handler coordination and one-way dependency restriction. Both arrival orders, required-result holds and atomic completion remain required; callers use one domain operation.

## SDK and gateway decisions, 28 September 2026

The user confirmed that the constrained link is between a gateway and Assets. A gateway usually runs separately from Core, may run on the Core machine and need not share its local network. Its IP connection is assumed adequate for the full operational picture. The general SDK serves Core-facing software; Asset firmware and constrained transport need not use it.

| Topic | Accepted direction | Authoritative detail |
| --- | --- | --- |
| General SDK | Keep HTTP pass-through and full synchronization behind the unified interface; remove Asset hybrid from current scope | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md) |
| Core synchronization | Defer automatic Asset membership, hybrid snapshots/feed/replay, scope events and dependency publication used solely for hybrid coverage | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md#what-changes) |
| Gateway and Asset responsibilities | Gateways may read the full picture and choose what crosses radio. Preserve Core-facing enrollment, reporting and reconciliation helpers for gateways and fixtures, per-Asset authority and Task meaning. A dedicated constrained-IP SDK is a future option, not current work | [Deployment boundary](adr/0020-limit-general-sdk-to-http-and-full-sync.md#deployment-and-responsibilities) |
| Implementation evidence | Require real failure tests, a concrete reporting protocol in the first reporting slice and proof of Protocol code generation before expanding the shared contract | [Testing strategy](testing-strategy.md), [generation](architecture/system-design.md#generation-and-testing) |

These decisions narrow synchronization scope. They do not claim implemented code, measured full-picture capacity, a completed radio protocol or executed failure tests.

## Plugin storage decision, 28 September 2026

The user accepted Atlas-managed storage for Plugin-private operational work. [ADR-0021](adr/0021-manage-plugin-operational-storage-through-reset.md) selects one working directory per Plugin for private files or SQLite. Restart preserves it without automatic reruns; Reset clears it while retaining separate setup and installed reference data. The [testing strategy](testing-strategy.md) requires real cleanup-failure and recovery evidence, including preservation of new work when retrying an established Reset. This records the contract without claiming implementation or executed tests.

## Documentation grilling round one, 28 September 2026

After reviewing the four scenario-based recommendations, the user said, "I agree with all your recommendations." This authorizes the following decisions, recorded in their authoritative homes.

| Decision | Accepted behavior | Authority |
| --- | --- | --- |
| Stale descriptive edits | Reject stale edits to operator-managed data for caller review. Asset reports keep their ordering contract, so an unrelated alias edit does not reject a valid position report | [Concurrent descriptive edits](architecture/system-design.md#concurrent-descriptive-edits) |
| Track publishers | Each Track has one publisher for observed fields. Different publishers create separate Tracks; a Plugin may deliberately combine observations into its own Track. Operator descriptive edits remain separate | [ADR-0022](adr/0022-one-publisher-per-track.md) |
| Required Entity references | Block deletion of a Track or Geofeature while an unfinished Task requires it and identify the blockers. Do not fabricate cancellation or outcomes; unavailable Assets may leave protection in place until Reset | [ADR-0023](adr/0023-protect-required-entity-references-during-tasks.md) |
| Plugin uninstall | Stop the Plugin, clear its private operational work and start any reinstall with an empty working directory. Published resources and recorded Operation outcomes retain their own lifetimes; disabling preserves private work | [Uninstall and reinstall](adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall) |

At the end of this round, publisher continuity/reassignment, observation correction/freshness, changes to referenced Geofeatures and uninstall treatment of retained setup remained open. The [second round](#documentation-grilling-round-two-28-september-2026) resolves several of them. The documentation and required scenarios record intended behavior; no implementation, runtime validation or new issue is claimed.

## Documentation grilling round two, 28 September 2026

The user agreed with Q5 and Q7, and with Q8's silent-Track recommendation. For Q6 the user rejected frozen geometry and said, "We should. Adjust to the new geometry." The earlier frozen-geometry recommendation was a proposal only and was never accepted.

| Decision | Accepted behavior | Authority |
| --- | --- | --- |
| Publisher continuity | The same authenticated publisher may supply fresh observations to its existing Tracks after reinstall within the same Dataset. Different publishers cannot automatically take over | [Publisher continuity](adr/0022-one-publisher-per-track.md#publisher-continuity) |
| Geofeature edits | Existing Tasks adjust to new geometry through the same immutable reference. An edit does not create a new Task or reopen a terminal outcome | [ADR-0024](adr/0024-use-live-geofeature-geometry-in-tasks.md) |
| Plugin setup on uninstall | Remove Plugin-owned configuration, usable credentials, downloaded reference data and installation artifacts along with private work. Published resources and recorded outcomes remain; disabling preserves the installation | [Uninstall and reinstall](adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall) |
| Silent Tracks | Retain last-known observations and expose their age. Silence alone does not delete a Track or make its coordinates current; explicit deletion remains guarded | [Observation age](adr/0022-one-publisher-per-track.md#observation-age) |

At the end of this round, geometry adoption during disconnection, its completion boundary and consumer freshness remained open. The [third round](#documentation-grilling-round-three-28-september-2026) resolves those choices. Observation correction and publisher reassignment were left for the [fourth round](#documentation-grilling-round-four-28-september-2026). Authentication proof, revision fields and wire encodings remain engineering work. These decisions add documentation and required evidence, not implementation or executed tests.

## Documentation grilling round three, 28 September 2026

The user said, "I agree with your recommendations," in response to Q9 through Q12. This authorizes the following refinements to the accepted live-reference and observation-age decisions.

| Decision | Accepted behavior | Authority |
| --- | --- | --- |
| Offline geometry | Continue with last received geometry within existing Command limits, then adopt the latest on reconnect. Contact loss alone does not stop otherwise valid work | [Disconnection and adoption](adr/0024-use-live-geofeature-geometry-in-tasks.md#disconnection-and-adoption) |
| Adoption evidence | Distinguish an edit saved in Core from the assigned Asset reporting it applied the geometry. Core and gateway receipt are insufficient, and confirmation is not another Core permission step before execution | [Disconnection and adoption](adr/0024-use-live-geofeature-geometry-in-tasks.md#disconnection-and-adoption) |
| Collection boundary | Core's acceptance of valid collection-finished evidence closes geometry changes for that scan. Earlier edits must be accounted for; later edits require another scan. Required uploads still gate Completed | [Geometry and collection-finished reports](adr/0008-complete-scan-tasks-when-required-results-are-available.md#geometry-and-collection-finished-reports) |
| Track freshness for execution | Each Command defines whether current observations are required, acceptable age and stale-data behavior. Last-known-position Commands may continue. Core exposes age and the Asset applies the rule, with no universal cutoff | [Track data used by Commands](adr/0022-one-publisher-per-track.md#track-data-used-by-commands) |

Observation correction and publisher reassignment remained open at the end of this round and are resolved in the [fourth round](#documentation-grilling-round-four-28-september-2026). Report correlation, revision fields, exact Command freshness limits and wire encodings remain engineering work. The required scenarios cover both geometry/report commit orders and Object arrival orders without changing pause, cancellation, terminal immutability or result retention. No runtime implementation or executed tests are claimed.

## Documentation grilling round four, 28 September 2026

The user said, "I agree with recommendations," in response to Q13 and Q14.

| Decision | Accepted behavior | Authority |
| --- | --- | --- |
| Correcting observations | The same publisher may correct the current value through ordinary updates while preserving actual observation time and recorded history. Corrections cannot make old data fresh or overwrite newer observations. Historical sample editing stays deferred | [Correcting current observations](adr/0022-one-publisher-per-track.md#correcting-current-observations) |
| Publisher transfers | Defer transfers in the initial scope, including operator-directed transfers. A different publisher creates a separate Track, and existing Tasks retain their references without automatic retargeting. Same-publisher continuity after reinstall remains supported | [Publisher transfers](adr/0022-one-publisher-per-track.md#publisher-transfers) |

All fourteen product questions in these four rounds have accepted answers. This closes that decision tree without claiming the whole implementation plan is complete. Identity proof, report ordering/correlation, schemas, Command thresholds and measured capacity remain engineering work. The documentation and required scenarios record the agreed behavior; no runtime implementation or executed tests are claimed.

## Documentation weak-spot review, 28 September 2026

An audit of the documentation for contradictions, undefined terms, behavioral gaps and structure produced four question rounds. The user accepted every recommendation except the first attribution proposal, which was replaced by the simpler wording below, and clarified the SDK boundary in their own words: Assets on IP links without bandwidth limits use the SDK like any other consumer.

| Decision | Accepted behavior | Authority |
| --- | --- | --- |
| Revoked identities | Deletion or retirement revokes an Asset identity until Hard Reset. A replacement uses a new Asset ID | [Retained identity](adr/0015-separate-start-stop-restart-and-reset.md#retained-asset-identity-after-reset) |
| Re-registration after Reset | Automatic with the surviving credential; enrollment authorization is needed only for first Enrollment | [Retained identity](adr/0015-separate-start-stop-restart-and-reset.md#retained-asset-identity-after-reset) |
| Lost credentials | A local action re-provisions a credential for the same identity, separately from revocation, and the CLI/TUI lists retained and revoked IDs | [Retained identity](adr/0015-separate-start-stop-restart-and-reset.md#retained-asset-identity-after-reset) |
| Open enrollment | A local test setting, off by default, enrolls any connecting Asset with its own identity. It survives Reset, is reported by health and the Command Interface, is recorded in activity history, applies to Assets only and never overrides revocation. Assets it enrolled stay enrolled and marked when it is switched off | [Identity and access](architecture/system-design.md#identity-and-access) |
| Gateway identity | Each gateway has its own identity that reads and relays only for its bound Assets, with no administrative rights. Making gateways Assets is a future proposal, not accepted | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md#deployment-and-responsibilities) |
| IP-connected Assets | Assets without bandwidth limits use the general SDK and its Asset client directly. The SDK stays TypeScript only for now | [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md#deployment-and-responsibilities) |
| Cancellation | Every request is recorded regardless of declared support. An Asset that cannot withdraw the Task declines, returning it to the execution status its reports establish | [Task transitions](adr/0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) |
| Control validity | Pause never expires. Resume carries a declared expiry; an expired Resume fails and the Asset stays paused | [Control ordering and expiry](adr/0007-reconcile-asset-tasks-after-disconnection.md#control-ordering-and-expiry) |
| Reference clock | Core time judges observation age, freshness, deadlines and expiry | [ADR-0025](adr/0025-use-core-time-as-the-installation-reference-clock.md) |
| Registration and Command support | Registration carries only Descriptive data and Command support. Command support is Asset-reported; dropped support leaves outstanding Tasks for the Asset to fail as unsupported | [Queued and immediate scheduling](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling) |
| Geometry | Each Geofeature-referencing Command declares its cutoff, by default the terminal report, and Core records the applied revision. Before the cutoff, edits that would invalidate a Task's input are rejected | [Geometry cutoff](adr/0024-use-live-geofeature-geometry-in-tasks.md#geometry-cutoff-and-applied-revision) |
| Object storage | A quota keeps headroom for operational writes; a missing Object file is a per-Object integrity fault and Core still opens | [Storage limits](adr/0009-expose-objects-only-when-ready.md#storage-limits-and-integrity-faults) |
| Activity attribution | Activity history records which authenticated caller acted, not a person | [Glossary](../CONTEXT.md) |
| Vocabulary | Installation, Installation setup, Operational status, Communication state, Contact, Enrollment, Asset registration, Operation, Plugin capability, Interrupted Operation, field authorship terms, SDK mode names, Required result and the other entries added to the glossary | [Glossary](../CONTEXT.md) |
| Documentation structure | Apply these content decisions first, then reorganize into one owning page per topic, one topic per change, with this log as history rather than authority and `docs/research/` left unchanged | This log |

These records are history. The linked documents own the current rules.
