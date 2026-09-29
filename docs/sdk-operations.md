# SDK operations catalog

This catalog documents SDK workflows and their API mappings. It is separate from the Protocol Command Catalog, which defines operational instructions executed as Tasks. SDK operations such as registration and updating telemetry do not create Tasks. This is a design document; no SDK implementation or final method signatures exist here yet.

Under [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md), the general SDK serves participants on IP links without bandwidth limits, including applications, Command Interfaces, Plugins, IP-connected Assets and gateways, through HTTP mode or Full synchronization mode. Gateways may be remote from Core; adequate IP bandwidth is assumed. Bandwidth-limited Assets do not run this SDK and reach Core through a radio gateway. The [Asset client](#asset-client) is the SDK owner of Core-facing Asset reporting workflows for IP-connected Assets, gateways and test fixtures; radio transport and delegation remain future work.

## Initial operations

The initial operations and behaviors below are approved; the names describe behavior, not final SDK method names. The API endpoint map remains the complete route inventory; this catalog starts with the workflows discussed so far.

| SDK operation | Behavior | Existing API mapping |
| --- | --- | --- |
| Register Asset | The Asset creates its Entity with identity, Descriptive data and supported Command declarations; other Reported data follows in the first check-in | `POST /entities` with type `asset` |
| Retire Asset | An operator withdraws participation through one Core operation, retaining the Entity and unresolved work while blocking assignment/provisioning and revoking bound access | Accepted operation; HTTP binding and SDK signature pending under [Asset retirement](topics/identity-and-access.md#asset-retirement) |
| Check in | Report current component data and contact after registration, and subsequently as needed | `POST /entities/{entity_id}/checkin` |
| Update Asset components | Submit only changed component fields; Core merges and validates the resulting Entity | `PATCH /entities/{entity_id}` |
| Report Asset status | Convenience operation for an operational status report | `PATCH /entities/{entity_id}/status` |
| Read operational data | Resource reads, queries, and feed subscriptions share the same SDK methods in both modes | HTTP mode: pass through to resource endpoints, `/queries`, and `/feed`. Full synchronization: local only |
| Read Command Catalog | Return Command definitions from the installed Protocol package | Local operation; no HTTP request |
| Create Task | Request one execution of one Command on one Asset under [Task creation](topics/tasks.md#task-creation), including when the Asset is offline | `POST /tasks` |
| Fetch assigned Tasks | Read outstanding Tasks with submission/current queue order and confirmation state, following pagination; use the same method in both modes | HTTP mode: `GET /entities/{entity_id}/tasks`. Full synchronization: local picture |
| Report Task lifecycle | Acknowledge, start, report progress, complete, fail, or confirm or decline cancellation of assigned work; return Core's actual state | `PATCH /tasks/{task_id}/status`; authenticated assigned-Asset validation |
| Cancel Task | Request withdrawal under [cancellation requests](topics/tasks.md#cancellation-requests) | `PATCH /tasks/{task_id}/status` |
| Reorder assigned Tasks | Submit a [queue revision](topics/tasks.md#queue-revisions) | `PUT /entities/{entity_id}/task-order` |
| Report queue adoption | Assigned Asset confirms a requested revision or reports an execution conflict | `POST /entities/{entity_id}/task-order/confirm` |
| Upload Object content | Stream the whole file; restart an interrupted transfer from zero using the same request identity; a previously completed identical request returns its existing Object or an explicit deleted-result error | `POST /objects/upload`; no resume/offset API |
| Read movement history | On-demand paginated samples for one Asset/Track and time range; does not populate the operational picture | `GET /entities/{entity_id}/movement-history` in every mode |
| Read activity history | Operator administrative clients query the limited action log; outside the operational picture | `GET /admin/activity` in every mode |
| Invoke Plugin Operation | Submit a declared capability with stable Dataset-scoped identity; retries retrieve the same Operation | `POST /plugins/{plugin_id}/operations` |
| Inspect/cancel Plugin Operation | Query recorded progress/outcome or request cancellation; caller disconnect does not stop accepted work | Plugin Operation read/list/cancel endpoints; direct API access outside the operational picture |

Registration, check-in, component and status updates, Task lifecycle reports from the assigned Asset, required-result uploads and queue adoption reports are Asset-originated. SDK consumers submitting these reports use the [Asset client](#asset-client), which owns their coordination. Gateway and Plugin limits follow the [caller permissions](topics/identity-and-access.md#callers-and-permissions). Tasking clients still use the route-level Task status helpers, for example to request cancellation.

Track observation updates use one publisher per Track. Within one Dataset, the same authenticated publisher may continue an existing Track after Plugin uninstall and reinstall with fresh observations; another publisher uses a separate Track, and Core does not merge or transfer ownership automatically. A silent Track retains its last-known values and exposes observation age; silence does not delete it or refresh its coordinates. There is no universal Track expiry for execution: a Command requiring current observations defines acceptable age and stale handling, while a last-known Command may continue and the Asset applies that policy. A Plugin that intentionally fuses sources publishes a separate Track. Descriptive Track edits use the [concurrent-edit protection](architecture/system-design.md#concurrent-descriptive-edits), and deletion obeys the [required Entity reference guard](topics/tasks.md#required-entity-references). See [ADR-0022](adr/0022-one-publisher-per-track.md#publisher-continuity).

Tasks with Geofeature references follow [live geometry](topics/tasks.md#live-geofeature-geometry) until their Command's cutoff.

The SDK exposes typed methods and documentation for these operations. No machine-readable SDK-operation discovery function is planned without a concrete consumer. Local lookup of the Protocol Command Catalog remains a separate agreed SDK function. Further SDK coverage can follow the approved endpoints without inventing additional API families.

## One read interface in both modes

Callers use the same SDK resource-read, query, and feed-subscription methods in both modes. In HTTP mode, all these operations pass through to Core's API, including query endpoints and the remote feed. In Full synchronization mode, resource reads and queries use only the local picture and locally retained changes; feed subscriptions observe updates applied to that picture. None of these application operations passes through to Core in Full synchronization mode. Applications do not switch to a separate set of cache-specific methods.

Create, update, delete, and Task lifecycle operations submit to Core in both modes. File bytes and permitted administrative resources outside the operational picture still use their API endpoints. Plugin installation, settings and process control are local CLI/TUI actions, not SDK operations; their uninstall/reinstall behavior follows [ADR-0021](adr/0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall). Before the initial picture is ready, local reads return an explicit not-ready result. During interruption, reads use the last known picture with its disconnected/stale condition exposed. Exact error/status shapes remain to be specified; the same method signature does not imply identical freshness. A full-synchronization read never falls back to HTTP because of a local miss, stale data, or an unsupported local query. HTTP failures never fall back to the local picture. Source selection follows the configured mode. See [SDK data access](sdk-data-access.md).

The background synchronizer privately uses remote `/queries` and `/feed` to maintain the picture. Application-facing query and feed operations remain available, but resolve locally in Full synchronization mode. Local feed subscribers observe changes after application to the cache, not raw remote messages. Missing local query history or coverage is reported without an API pass-through. Local change history is bounded with configurable limits. Local cursors are scoped to one SDK picture, expire when history is unavailable, and become invalid on rebuild; they are not interchangeable with Core cursors. On expiry, callers can request a fresh local snapshot. Detailed limits, encoding, and subscription-start behavior remain to be specified. HTTP mode does not maintain the synchronized picture.

Full synchronization mode maintains the full operational dataset in memory, with no persistence or selective synchronization. It rebuilds on SDK restart and reports resource-limit failures rather than silently dropping resources. Writes return Core's confirmed result without waiting for that picture, following [ADR-0018](adr/0018-confirm-writes-when-core-commits.md). Picture reads, local feed and history still follow [ordered reconciliation](sdk-data-access.md#writes), independently of write completion. Synchronization failures do not cause accepted writes to be resubmitted. Writes rejected by Core do not appear locally as committed data.

Core, Assets and SDK clients use declared supported compatibility ranges; unsupported versions fail explicitly. Catalog lookup remains local, and Task creation validates target Command support. All modes follow the [dataset Reset boundary](sdk-data-access.md#dataset-reset-boundary), discarding obsolete state and submissions without automatically replaying them into a new Dataset.

The earlier [Asset hybrid mode](sdk-data-access.md#asset-hybrid-mode) and Core's matching Asset-scoped synchronization are deferred under ADR-0020. Core Task retention and the reporting workflows below remain required.

A scan completion report may leave its Task nonterminal under [scan completion](topics/tasks.md#scan-completion); the SDK returns Core's recorded status.

Historical reads are explicit API-backed operations in every SDK mode, separate from the read-operational-data methods. Their results and cursors never update the local operational picture. See [historical reads](sdk-data-access.md#historical-reads).

Upload retries resend the complete file after interruption. Producers retain the source file until publication succeeds. The SDK allocates the Object ID before upload and retains it alongside a stable Dataset-scoped request identity, so reports can reference results before their files arrive and a lost success response does not create another Object; it does not keep persistent partial-transfer progress or add an offline write queue. Reset invalidates the old request identity. Detailed content-equivalence verification follows [ADR-0009](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries).

A retry after an allowed Object deletion returns an explicit deleted-result error. The SDK never allocates a replacement identity and silently uploads again; an intentional new upload requires new Object and request identities. [Upload identity contract](adr/0009-expose-objects-only-when-ready.md#retrying-an-upload-after-allowed-deletion).

## Asset client

Accepted on 26 September 2026, with consumer scope revised by [ADR-0020](adr/0020-limit-general-sdk-to-http-and-full-sync.md). The Asset client is the SDK module for Core-facing Asset reporting by IP-connected Assets, gateways and simulated-Asset test fixtures. Bandwidth-limited Assets do not run it; their gateway does. It registers an Asset, submits Asset-originated reports and reads assigned work, owning:

- First registration before a normal Asset credential exists, its retry identity and re-registration after Reset, under [Asset registration](topics/identity-and-access.md#asset-registration).
- Required-result uploads: the Asset client preallocates the result Object ID, uses it in the completion report and delegates the whole-file upload to the existing upload operation, retaining its request identity. No new route is added.
- Report identity and ordering, and the Core-issued process generation, matching [Asset report acceptance](architecture/system-design.md#shared-asset-report-acceptance) in Core.
- Pause/Resume report correlation and queue revision adoption under [Tasks](topics/tasks.md#pause-and-resume).
- Lost-response retries with stable identities, and discarding obsolete work and submissions when the Dataset changes before re-registering in the new Dataset.
- [Reconnect reconciliation](topics/tasks.md#disconnection-and-reconnect-reconciliation).

After an Asset process restart, the Asset client follows [recovery](topics/tasks.md#recovery-after-an-unexpected-asset-restart) using the Asset OS's onboard execution evidence, obtaining a new process generation and keeping uncertain work out of its assigned-work stream until explicit recovery. It never schedules, starts or reruns work; the Asset OS still owns execution. It keeps no disk persistence; the Asset OS or deployment layer retains any identity that must survive a process restart. HTTP is the Core-facing transport. Radio delivery, evidence transfer and authenticated relay delegation remain future work; a gateway identity can relay only for its bound Assets. Exact method names remain open.

## Tasks

Task lifecycle helpers, Pause and Resume, assigned-work reads, queue operations and recovery follow [Tasks](topics/tasks.md#routes-and-sdk-operations). Exact helper names and wire envelopes remain schema work.

## Protected Object deletion

Object deletion helpers return Core's conflict for a [protected required result](adr/0009-expose-objects-only-when-ready.md#required-result-protection). A rejected deletion must not remove the Object from a synchronized picture.

## Asset startup

1. The Core-facing Asset client invokes registration with information supplied by the Asset OS or gateway. The SDK uses ordinary Entity creation, not a dedicated registration endpoint.
2. [Enrollment](topics/identity-and-access.md#enrollment) automatically binds an authenticated Asset identity, and Core validates the supplied initial data and creates the Asset with its [initial reporting values](topics/asset-reporting.md#components-and-initial-values).
3. The Asset sends [check-in](topics/asset-reporting.md#check-in) with its Reported data, such as Operational status and position.
4. The Asset sends further reports as needed, containing only changed fields if it chooses. [Contact and freshness](topics/asset-reporting.md#contact-and-freshness) defines which reports refresh Contact.

Registration content, stable Asset IDs and retries follow [Asset registration](topics/identity-and-access.md#asset-registration).

## Reporting and derived data

Check-in, component updates and status reports follow [Asset reporting](topics/asset-reporting.md), including [partial component updates](topics/asset-reporting.md#partial-component-updates), [Contact and freshness](topics/asset-reporting.md#contact-and-freshness) and [report authority and relay](topics/asset-reporting.md#report-authority-and-relay).

Track observations are authored by the Track's single publisher. Within one Dataset, the same authenticated publisher may continue an existing Track after Plugin uninstall and reinstall with fresh observations; different publishers use different Tracks, and deliberate Plugin fusion creates its own Track. A silent Track retains its last-known values and exposes observation age; silence does not delete it or refresh its coordinates. Descriptive edits are separate and Core does not merge publishers automatically. [ADR-0022](adr/0022-one-publisher-per-track.md) also permits same-publisher corrections to current observations through ordinary updates, preserving actual age and history without replacing newer observations. Publisher transfers are deferred, and existing Tasks retain their original references.

## Remaining decisions

- SDK method names, argument shapes, the Asset client's interface shape, and whether registration offers a convenience option to perform the first check-in.
- Registration and credential encodings, listed with the [identity open questions](topics/identity-and-access.md#open-questions).
- Report identity, ordering, relay-origin and disposition-mapping questions listed with the [Asset reporting open questions](topics/asset-reporting.md#open-questions).
- Task, queue, Pause/Resume and deadline fields listed with the [Tasks open questions](topics/tasks.md#open-questions).

These operations use the [approved endpoint map](api-endpoints.md), [component catalog](data-components.md), and [Asset reporting](topics/asset-reporting.md) rules.
