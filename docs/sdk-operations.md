# SDK operations catalog

This catalog documents SDK workflows and their API mappings. It is separate from the Protocol Command Catalog, which defines operational instructions executed as Tasks. SDK operations such as registration and updating telemetry do not create Tasks. This is a design document; no SDK implementation or final method signatures exist here yet.

## Initial operations

The initial operations and behaviors below are approved; the names describe behavior, not final SDK method names. The API endpoint map remains the complete route inventory; this catalog starts with the workflows discussed so far.

| SDK operation | Behavior | Existing API mapping |
| --- | --- | --- |
| Register Asset | The Asset creates its Entity with identity, descriptive data, initial components, and supported Command declarations | `POST /entities` with type `asset` |
| Check in | Report current component data and contact after registration, and subsequently as needed | `POST /entities/{entity_id}/checkin` |
| Update Asset components | Submit only changed component fields; Core merges and validates the resulting Entity | `PATCH /entities/{entity_id}` |
| Report Asset status | Convenience operation for an operational status report | `PATCH /entities/{entity_id}/status` |
| Read operational data | Resource reads, queries, and feed subscriptions share the same SDK methods in all three modes | HTTP mode: pass through to resource endpoints, `/queries`, and `/feed`. Full synchronization: local only. Asset hybrid: local scoped reads/feed, with one-off API reads outside scope |
| Read Command Catalog | Return Command definitions from the installed Protocol package | Local operation; no HTTP request |
| Create Task | Request one execution of one Command on one Asset; Core accepts and retains valid Tasks even when the Asset is offline | `POST /tasks` |
| Fetch assigned Tasks | Read outstanding Tasks with submission/current queue order and confirmation state, following pagination; use the same method in all modes | HTTP mode: `GET /entities/{entity_id}/tasks`. Full synchronization: local picture. Asset hybrid: local for its own Asset, one-off API reads for others |
| Report Task lifecycle | Acknowledge, start, report progress, complete, fail, or confirm cancellation of assigned work; return Core's actual state | `PATCH /tasks/{task_id}/status`; authenticated assigned-Asset validation |
| Cancel Task | Request nonterminal cancellation_requested; the Asset subsequently confirms cancelled through the same status system | `PATCH /tasks/{task_id}/status` |
| Reorder assigned Tasks | Submit the complete eligible unstarted list with expected revision and stable request identity | `PUT /entities/{entity_id}/task-order` |
| Report queue adoption | Assigned Asset confirms a requested revision or reports an execution conflict | `POST /entities/{entity_id}/task-order/confirm` |
| Upload Object content | Stream the whole file; restart an interrupted transfer from zero using the same request identity; a previously completed identical request returns its existing Object or an explicit deleted-result error | `POST /objects/upload`; no resume/offset API |
| Read movement history | On-demand paginated samples for one Asset/Track and time range; does not populate the operational picture | `GET /entities/{entity_id}/movement-history` in every mode |
| Read activity history | Operator administrative clients query the limited action log; outside the operational picture | `GET /admin/activity` in every mode |
| Invoke Plugin Operation | Submit a declared capability with stable Dataset-scoped identity; retries retrieve the same attempt | `POST /plugins/{plugin_id}/operations` |
| Inspect/cancel Plugin Operation | Query recorded progress/outcome or request cancellation; caller disconnect does not stop accepted work | Plugin Operation read/list/cancel endpoints; direct API access outside the operational picture |

The SDK exposes typed methods and documentation for these operations. No machine-readable SDK-operation discovery function is planned without a concrete consumer. Local lookup of the Protocol Command Catalog remains a separate agreed SDK function. Further SDK coverage can follow the approved endpoints without inventing additional API families.

## One read interface in all three modes

Callers use the same SDK resource-read, query, and feed-subscription methods in all three modes. In HTTP/simple mode, all these operations pass through to Core's API, including query endpoints and the remote feed. In full-synchronization mode, resource reads and queries use only the local picture and locally retained changes; feed subscriptions observe updates applied to that picture. None of these application operations passes through to Core in full-synchronization mode. Asset hybrid serves its related subset locally and makes one-off API requests for out-of-scope reads, without expanding its subscription. Its feed describes only applied changes in the subset. Applications do not switch to a separate set of cache-specific methods.

Create, update, delete, and Task lifecycle operations submit to Core in all three modes. File bytes and permitted administrative resources outside the operational picture still use their API endpoints. Plugin installation, settings and process control are local CLI/TUI actions, not SDK operations. Before the initial picture is ready, local reads return an explicit not-ready result. During interruption, reads use the last known picture with its disconnected/stale condition exposed. Exact error/status shapes remain to be specified; the same method signature does not imply identical freshness. A full-synchronization read or hybrid in-scope read never falls back to HTTP because of a local miss, stale data, or an unsupported local query. HTTP failures never fall back to the local picture. Source selection follows the mode and, for hybrid reads, the requested scope. See [SDK data access](sdk-data-access.md).

The background synchronizer privately uses remote `/queries` and `/feed` to maintain the picture. Application-facing query and feed operations remain available, but resolve locally in full-synchronization mode and within hybrid scope. Local feed subscribers observe changes after application to the cache, not raw remote messages. Missing local query history or coverage is reported without an API pass-through. Local change history is bounded with configurable limits. Local cursors are scoped to one SDK picture, expire when history is unavailable, and become invalid on rebuild; they are not interchangeable with Core cursors. On expiry, callers can request a fresh local snapshot. Detailed limits, encoding, and subscription-start behavior remain to be specified. HTTP mode does not maintain the synchronized picture.

Full-synchronization mode maintains the full operational dataset in memory, with no persistence or selective synchronization. It rebuilds on SDK restart and reports resource-limit failures rather than silently dropping resources. After a successful operational write, it reconciles Core's authoritative result before resolving the write, emits the applied change once, and deduplicates the matching feed event without regressing newer state. Failed writes do not appear locally as committed data.

Core, Assets and SDK clients use declared supported compatibility ranges; unsupported versions fail explicitly. Catalog lookup remains local, and Task creation validates target Command support. All modes follow the [dataset Reset boundary](sdk-data-access.md#dataset-reset-boundary), discarding obsolete state and submissions without automatically replaying them into a new Dataset.

The agreed [Asset hybrid mode](sdk-data-access.md#asset-hybrid-mode) synchronizes the Asset's own Entity, outstanding Tasks and subsequent outcomes, cancellation requests, queue-order changes, and directly referenced Entities/Object metadata needed for those Tasks. Core filters before transmission across initial queries, recovery, and feed. Reads outside the subset make one-off API requests without adding subscriptions or emitting local feed updates for the fetched data. Writes still go to Core; in-scope results reconcile into the local picture. File bytes remain on-demand downloads. Dependency fields, terminal-Task retention, and scope membership/cursor details remain to be specified.

Scan completion reports may remain pending until all required Objects are ready; the SDK must return Core's actual recorded Task status rather than assume a successful completion-report request made it terminal. See [ADR-0008](adr/0008-complete-scan-tasks-when-required-results-are-available.md).

Historical reads are explicit API-backed operations in every SDK mode, separate from the read-operational-data methods. Their results and cursors never update the local operational picture. See [historical reads](sdk-data-access.md#historical-reads).

Upload retries resend the complete file after interruption. Producers retain the source file until publication succeeds. The SDK allocates the Object ID before upload and retains it alongside a stable Dataset-scoped request identity, so reports can reference results before their files arrive and a lost success response does not create another Object; it does not keep persistent partial-transfer progress or add an offline write queue. Reset invalidates the old request identity. Detailed content-equivalence verification follows [ADR-0009](adr/0009-expose-objects-only-when-ready.md#upload-failures-and-retries).

A retry after an allowed Object deletion returns an explicit deleted-result error. The SDK never allocates a replacement identity and silently uploads again; an intentional new upload requires new Object and request identities. [Upload identity contract](adr/0009-expose-objects-only-when-ready.md#retrying-an-upload-after-allowed-deletion).

## Task status updates

Task lifecycle helpers share `PATCH /tasks/{task_id}/status`; there are no separate cancellation request/confirmation endpoints. The caller supplies a requested status or progress-only update and transition-specific data. Core derives report authority from authentication and applies the [Task transition rules](adr/0007-reconcile-asset-tasks-after-disconnection.md#task-transitions). A tasking client requests `cancellation_requested`; the assigned Asset confirms `cancelled`. Helpers must return the authoritative recorded state, including pending Object readiness or retained cancellation intent, rather than echoing the requested status as success.

The [testing strategy](testing-strategy.md) requires these helpers and the queue operations to pass real SDK–Core parity, retry and race scenarios. Exact helper names and wire envelopes remain schema work.

## Immediate Commands and Pause

Task creation selects supported queued/immediate scheduling through the same SDK operation and `POST /tasks`. Pause and Resume are immediate Commands. Lights and similar supported Commands can be queued or immediate; an immediate lights change can run alongside Move To without changing the path. Task identity, retries and outcomes remain visible in both cases. The Asset's outstanding-work reads and hybrid picture include immediate control Tasks even while it is paused.

The Asset reports its paused condition through ordinary Entity status reporting and reports the interrupted Task's suspension through the Task status endpoint. The Pause Task completes once applied. A separate immediate Resume continues the interrupted Task first, or reports that Task failed if it cannot safely resume. The resumed Task keeps its identity/progress; it is not a new execution. The SDK must not optimistically set these states merely because task creation succeeded. See the [Pause and scheduling contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queued-and-immediate-scheduling); the Asset validates Command-specific expiry and preserves newer Pause/Resume intent despite delayed older requests. Control/report correlation fields remain open.

## Assigned Task queue

The Asset fetches all outstanding assigned Tasks, following pagination as needed. Retained work must first satisfy the recovery/reconciliation contract; fetching it does not authorize repeating an execution. Eligible queued work executes locally one at a time, oldest submission first by default, following confirmed queue reordering. Repeated move-to Tasks form a sequence of destinations. Fetching or caching the Tasks does not automatically acknowledge or start them.

Core assigns a permanent increasing submission sequence within each Asset's queue when accepting a Task. Reads return that default order; a repeated read or Task-creation retry does not create another execution or move a Task to the end. The Asset acknowledges a Task when it accepts it into its local queue and reports in progress when execution begins. Eligible, unstarted queued Tasks, including acknowledged Tasks, can be reordered without rewriting submission sequence. Requested and Asset-confirmed order are separate; started, paused, cancellation-requested and terminal Tasks cannot move. A disconnected Asset can continue using its last received order. Use whole-list requests with expected revisions and stable retry identity, plus assigned-Asset adoption/conflict reports, under the [queue contract](adr/0007-reconcile-asset-tasks-after-disconnection.md#queue-revisions). Communication state does not gate Task creation or change Core scheduling behavior. Core accepts and retains valid Tasks even while the Asset is offline; the Asset owns execution when it receives them. See [Asset status](asset-status.md).

## Recovery and historical Tasks

After unexpected Asset-process restart, reconcile retained Tasks before executing any uncertain work. Hold the affected queue if execution cannot be established; neither reading outstanding Tasks nor reinitializing the SDK authorizes a rerun. See [recovery](adr/0007-reconcile-asset-tasks-after-disconnection.md#recovery-after-an-unexpected-asset-restart). Failed resumption leaves the Asset paused until a new explicit Resume.

Task reads can filter to current work for normal interfaces. Terminal records stay in Core until Reset and have no delete operation; their visibility in a particular interface is not a retention rule.

Deleting an Object through the SDK returns Core's conflict if any Task has an accepted required-result reference to that Object. The SDK must not remove it from a synchronized picture on a rejected deletion. Required-result protection begins at declaration acceptance and lasts until Reset, regardless of later Task status; optional attachments follow ordinary deletion rules.

## Asset startup

1. The Asset invokes registration with the information it already knows. The SDK uses ordinary Entity creation, not a dedicated registration endpoint.
2. Enrollment automatically binds an authenticated Asset identity, and Core validates the supplied initial data and creates the Asset. Deployment tooling supplies enrollment authorization; the SDK completes enrollment without a per-Asset approval step or manually managed API key. The credential/proof encoding remains engineering work; choosing an Asset ID is not proof of identity. Before its first report, operational status defaults to `unknown`, communications is `offline`, and heartbeat has `last_seen: null`.
3. The Asset sends check-in with current component data and any additional information now available. Core records contact and derives communication state from reported link observations and configured expectations.
4. The Asset sends further reports as needed. It can send only changed fields instead of resending its full Entity. Every accepted fresh Asset-originated update refreshes contact, including telemetry and status updates.

Registration may supply substantial initial data; it is not a request to create empty component placeholders. Supplying optional initial data does not exempt the record from required-component validation. Each Asset has a stable ID that survives restarts. Registration retries reuse that Asset ID and the same registration request identity, so a lost response does not create another Asset. Reconnecting resumes the existing record without overwriting its state with startup defaults. Exact request identity format, retention, and response semantics remain to be defined; registration is not a replacement upsert.

## Partial component updates

For example, an Asset can send only a changed heading through the Entity patch route. This illustrates the JSON structure, not a final SDK signature:

```json
{
  "components": {
    "telemetry": {
      "heading": 90
    }
  }
}
```

Existing position and other omitted fields remain unchanged. If telemetry is absent, the resulting new component must still satisfy its complete schema; a partial payload cannot create an invalid component.

Supplied scalar fields replace previous values. Nested fields merge; arrays replace completely. Explicit null removes an optional component or clears a nullable field. Removing required components fails validation. Core commits the validated result atomically and emits the corresponding Entity change. The physical storage layout need not match the JSON envelope.

## Reporting and derived data

The Asset authors its reported Entity state. Interfaces submit Tasks rather than directly editing Asset state. An integration can relay data originating from an Asset; exact origin and report-ordering fields remain open. Core verifies Asset identity on every reporting path, including generic Entity patches and Task lifecycle calls. A valid key or claimed Asset ID alone is insufficient. This introduces no operator roles. Managed Plugins receive integration identity without manually managed keys and cannot impersonate Assets.

Core owns receipt timestamps, resource versions, and derived communication state. Fresh Asset-originated updates refresh contact; Core-derived changes do not. A telemetry-only update refreshes contact without refreshing the operational status report time. Fresh Asset-originated Task acknowledgements, starts, progress, and outcomes also refresh the assigned Asset's contact. Interface-originated Task creation or cancellation does not.

Atlas expects continuous, near-real-time telemetry during operations such as flying to an area, taking photographs, and returning. Long disconnected missions with occasional telemetry uploads are not the operating model. No numeric reporting interval or latency guarantee is selected yet.

Core distinguishes fresh reports from arrival of delayed data. Duplicate reports and historical backlog do not establish current contact, and delayed updates never overwrite newer component values. These rules handle brief transport interruptions, retries, and reordering. An unchanged measurement in a newly generated report can still establish contact. Exact ordering fields, freshness windows, and clock assumptions remain open; do not infer current reachability merely from a newly received old packet.

## Remaining decisions

- SDK method names, argument shapes, and whether registration offers a convenience option to perform the first check-in.
- Registration request identity format, deduplication retention, and reconnect response semantics for the agreed stable-ID/retry model.
- Report identity/ordering fields, relay origin, freshness windows, and clock assumptions that enforce the agreed fresh-contact and no-regression rules.
- Version preconditions for frequent component reports and how the SDK handles conflicts.
- Exact Task sequence/queue field encodings and report ordering; Pause/Resume correlation, deadline/clock fields and validation for conflicting immediate actions beyond the accepted control-order policy.

These operations use the [approved endpoint map](api-endpoints.md), [component catalog](data-components.md), and [Asset status model](asset-status.md).
