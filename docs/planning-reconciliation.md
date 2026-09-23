# API planning reconciliation

Status: the API/architecture recommendations were accepted on 22 September 2026. The endpoint map, SDK plans, canonical glossary and affected ADRs now record those decisions. Manual Plugin configuration recovery closes the last reconciliation choice. No runtime implementation is introduced.

The planning session and architecture merged in PR #1 originally disagreed. This record explains the resolutions; [the documentation guide](agents/domain.md) still assigns authority to the glossary, architecture and ADRs. The separate planning glossary has been consolidated into [CONTEXT.md](../CONTEXT.md).

## Accepted resolutions

| Topic | Resolution | Authoritative detail |
| --- | --- | --- |
| Access | Broad operational reads and no operator roles; Core enforces Asset ownership of reported state and assigned Task execution. Automatically provision Asset identity during enrollment. Managed Plugins need no operator-managed keys and cannot impersonate Assets or administer Core | [Identity and access](architecture/system-design.md#identity-and-access) |
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
| Hybrid scope | Filter transmission to save bandwidth while retaining full-picture read permission. In-scope reads/feed stay local; out-of-scope reads use one-off HTTP requests | [SDK hybrid mode](sdk-data-access.md#asset-hybrid-mode) |

## Scope review after PR feedback

On 22 September 2026 the user accepted the lower-complexity options after reviewing the older Atlas implementation:

- Uploads restart from the beginning after interruption. Resumability is deferred. Safe staging, cleanup, ready-only publication and recognition of a completed retry remain required. [ADR-0009](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries) supersedes the earlier same-run resume promise, including partial-transfer retention.
- Movement history is a small Core sample store with one paginated read, explicit report capture and retry deduplication, retained until Reset. Backfill, historical editing, reduced trails and historical-state reconstruction are deferred. [Movement contract](architecture/system-design.md#movement-history).
- Activity history is a small structured log for Task issuance/cancellation and Plugin, credential and configuration changes, including local management, with honest authenticated attribution, no secrets and retention until Reset. [Activity contract](architecture/system-design.md#activity-history).

These historical reads use explicit SDK API methods outside the synchronized picture. They do not change the source-selection rules for live reads, local queries or feed subscriptions. The component catalog and endpoint map now include both stores and their read routes.

## Plugin configuration recovery

Accepted: if applying saved Plugin settings prevents startup, leave the Plugin faulted and report the failed apply. The local operator explicitly restores the last working settings and restarts, or corrects the candidate and applies again. Preserve the failed candidate and last working revision; do not automatically restore, restart or rerun Operations. [ADR-0006](adr/0006-protect-active-plugin-work-during-lifecycle-changes.md#local-configuration) owns this policy and the save/apply and active-work rules.

## Latest review decisions

Accepted after the five follow-up review findings: cancellation intent is `cancellation_requested` in the Task status system, with assigned-Asset `cancelled` confirmation. One status-update endpoint replaces separate lifecycle endpoints. Queue edits submit the complete eligible unstarted list with expected revisions; Assets report adoption or conflict. Started Tasks cannot be reordered. [Task contract](adr/0007-reconcile-asset-tasks-after-disconnection.md).

The storage inventory now includes durable Operation attempts, bounded synchronization changes/deletion records and retention boundaries, plus authenticated principal kind and Asset binding. Asset enrollment remains automatic, and Plugins do not acquire a manual key-management workflow. [Catalog](data-components.md).

Extensive real SDK–Core integration and behavioral parity tests are required, with reusable external-system scenarios, failure injection and measured bandwidth. Composed gateway/firmware tests supplement pairwise parity. [Testing strategy](testing-strategy.md). Low-bandwidth links shape partial updates, scoped synchronization and future transport design without selecting a radio encoding now. [Bandwidth contract](architecture/system-design.md#bandwidth-and-authenticated-reporting).

Immediate Commands and paused Asset/Task states are now accepted under the [Task contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling). Pause is an immediate Task that interrupts current queued work, puts the Asset into its own idle/holding behavior, and preserves the queued path. Independent immediate actions can overlap movement without changing the path. An immediate Resume Command continues the interrupted Task before the remaining queue; unsafe-to-resume work reports failure. Control/report correlation, stale/conflicting delivery and queue continuation after that failure remain open. Exact schemas, authentication/enrollment proof, Task/queue report envelopes, whole-file upload retry verification and SDK method signatures remain implementation design work.
