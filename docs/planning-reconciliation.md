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
| Task cancellation | Keep six execution statuses and a separate cancellation request. Accepted work becomes cancelled only after confirmation; the request does not hide its execution status | [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) |
| Task order | Core records immutable submission order and requested versus Asset-confirmed reorder state. Assets execute sequentially by default and can follow their last confirmed order while disconnected; Core does not start Tasks or gate on connectivity | [ADR-0007](adr/0007-reconcile-asset-tasks-after-disconnection.md) |
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

Exact schemas, authentication/enrollment mechanics, queue revision handling, cancellation confirmation, whole-file upload retry verification and SDK method signatures remain implementation design work rather than competing architecture decisions.
