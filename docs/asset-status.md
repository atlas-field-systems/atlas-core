# Asset status

> Planning-session record, pending reconciliation with the architecture merged in PR #1. "Approved" and "agreed" below describe this session; they do not supersede existing ADRs. See [conflicts and document authority](planning-reconciliation.md).

Every Asset requires status, communications, and heartbeat components. Asset status replaces the separate execution-session API previously proposed in the endpoint map. This is a planning document; no implementation exists in this repository.

The replacement direction, separate operational and connection states, and reconciliation after exceptional interruption are agreed. Initial operational status `unknown`, initial communications `offline`, and initial heartbeat `last_seen: null` are agreed. Core accepts and retains valid Tasks even when the Asset is offline. The six operational status values below are agreed. Assets own sequential Task execution; Core does not use reported operational status or communication state to schedule their work. Detailed transition/report validation remains open. The status endpoints are part of the approved endpoint map.

## Earlier design

Atlas Modernization stored operational status in `components.status.value` and connection state in `components.communications.link_state`. Check-in refreshed the heartbeat and could report telemetry and operational status together. Its status guide defines connection states but accepts an operational status string rather than supplying the complete operational lifecycle table needed here.

This design uses that status reporting approach as a reference. It does not retain the older execution-session registration, readiness, shutdown, or session-scoped Task polling API.

## Operational status table

These agreed values describe the Asset's reported operational condition, separately from Task lifecycle states. They communicate state; they are not Core scheduling gates.

| Status | Meaning |
| --- | --- |
| `unknown` | No usable operational report is available yet |
| `initializing` | The Asset is starting or preparing its capabilities |
| `ready` | The Asset is prepared to perform its advertised capabilities |
| `busy` | The Asset is executing work |
| `error` | A reported fault prevents normal operation; details explain the fault |
| `stopped` | The Asset has deliberately stopped operational activity |

Agreed initial value: `unknown` when the Asset is created without an operational report. Even an Asset that only reports observations has a status; being `ready` does not invent tasking capabilities that it has not advertised.

### Proposed transition examples

| Situation | Example transition | Meaning |
| --- | --- | --- |
| Asset begins startup | `unknown` or `stopped` → `initializing` | Preparation is in progress |
| Preparation completes | `initializing` → `ready` | Advertised capabilities are available |
| Work starts | `ready` → `busy` | At least one operation is executing |
| Queue is drained | `busy` → `ready` | Asset reports that it is available again; finishing one Task need not imply an empty queue |
| A fault occurs | Any operational state → `error` | Report a reason; do not invent a Task outcome |
| Fault recovery | `error` → `initializing` or `ready` | Asset reports recovery |
| Deliberate stop | An active state → `stopped` | Asset reports stopping |

These are examples, not an exhaustive transition validator. A reconnect can reveal a transition Core never observed. The design must distinguish a current state report from an instruction to perform a transition; reporting `stopped` is not a stop Command, and reporting `busy` is not Task acceptance.

## Communication state table

Communications is required on every Asset and remains separate from operational status.

The selected states are `high_bandwidth`, `healthy`, `degraded`, and `offline`. High bandwidth means sufficient capacity for unrestricted Atlas communication; it is not tied to a specific connection technology. Record connection type, such as Wi-Fi or Ethernet, separately.

| Communication state | Meaning |
| --- | --- |
| `high_bandwidth` | Communication is working with sufficient capacity for unrestricted Atlas communication |
| `healthy` | Communication is working as expected for a constrained link |
| `degraded` | Communication is available but impaired, regardless of connection type or nominal capacity |
| `offline` | Communication is unavailable |

Healthy is relative to the link's expected performance. A constrained link is not degraded merely because it is slower than Wi-Fi.

Degraded or offline takes precedence over high bandwidth when communication deteriorates. A Wi-Fi connection can therefore be degraded or offline.

Core derives communication state from the Asset or transport integration's reported connection type, capacity class, and link-quality observations, using configured expectations for that link. A single timeout must not assume every link has Wi-Fi timing. Initial state before the first report is `offline`.

**TODO:** Define capacity/quality criteria, transitions, link expectations, and how observations are represented. The four states above replace the earlier table's connected/disconnected/unknown vocabulary.

### Heartbeat and freshness

Heartbeat is required on every Asset and begins with `last_seen: null`. Registration creates the record and is followed by check-in. Every accepted fresh Asset-originated update refreshes Core-recorded contact, including telemetry patches, status updates, and check-ins. A separate heartbeat packet is not required while other reports are arriving.

The Asset authors its reported Entity data; interfaces send Tasks rather than edit the Asset directly. Core maintains derived fields, but its own changes never refresh heartbeat. Clients cannot supply Core's contact timestamp. Fresh Asset-originated Task acknowledgements, starts, progress, and outcomes also refresh contact. Interface-originated Task creation or cancellation does not.

Continuous, near-real-time reporting during operations is the expected model. Fresh reports establish contact; duplicates and historical backlog do not. Delayed updates never overwrite newer component values. Freshness windows, report ordering, and relay-origin fields remain to be specified. These rules cover brief interruptions and retries rather than a planned long-disconnected store-and-forward workflow.

A disconnected Asset may still be physically executing a Task. Connectivity must not silently turn a Task into failed, completed, or cancelled. Keep the last reported operational status and its report time visible; an old `ready` report does not prove current availability. Core derives connection state; link-specific timeout thresholds and freshness indicators remain open. Core does not infer execution policy from the reported communication quality.

## API and reporting

Status belongs to the Asset's Entity record and is included in ordinary reads and the SDK's synchronized operational picture. The approved endpoints provide a status view and update:

| Method and path | Purpose |
| --- | --- |
| `GET /entities/{entity_id}/status` | Read an Asset's status, report times, and associated reason/details |
| `PATCH /entities/{entity_id}/status` | Report an operational status update and optional reason/details |
| `POST /entities/{entity_id}/checkin` | Report current component data and establish contact; Core records receipt time |

The status-specific endpoints apply to `asset` Entities. They share validation and update semantics with status supplied through check-in or any permitted Entity patch. Status updates produce versioned Entity changes through `/feed` and `/queries/changed-since`; no separate status stream is needed.

Proposed reporting metadata includes when Core received the status and when it last changed. Any accepted fresh Asset-originated update refreshes contact, but a telemetry-only update does not refresh the operational status report time. Contact freshness and the freshness of each reported component remain distinct. Exact fields and timestamps remain to be designed.

The SDK registers an Asset through `POST /entities`, then sends check-in through the existing endpoint. Registration carries initial descriptive data, components, and advertised capabilities. Assets retain a stable ID across restarts; registration retries reuse both the Asset ID and request identity. Reconnection resumes existing state without reapplying startup defaults. Subsequent updates can contain only changed component fields. See the [SDK operations catalog](sdk-operations.md); no registration or per-component update endpoint is added.

Assets advertise supported Protocol Commands on their Entity record. Reporting and updating that declaration uses the Entity/check-in contract rather than a separate readiness session. It remains distinct from operational status: a status value does not contain the Command Catalog.

## Task integration

Assets fetch their full outstanding Task list, following pagination as needed, and queue Tasks locally. They execute one at a time, oldest submission first by default, following confirmed reordering of unstarted Tasks. Several move-to Tasks can therefore define a path. A busy Asset can receive further Tasks; Core does not reject them merely because another Task is running.

Core assigns a permanent increasing submission sequence per Asset when accepting each Task. The sequence defines default execution order independently of client clocks, and assigned-work reads return that order. Exact field encoding remains to be designed. Retrying Task creation must not create another queue entry or change the original Task's order. Fetching the list does not itself acknowledge or start Tasks.

Communication state does not gate Task creation or change Task scheduling or execution behavior in Core. The Asset controls execution. Core still validates Protocol schemas, supported Commands, and legal Task lifecycle transitions; it does not act as the Asset's scheduler. Losing connectivity does not change existing unfinished Tasks.

Core accepts and retains valid Tasks even when the Asset is offline. Tasks keep their assignment order until the Asset receives them and controls execution. This replaces the earlier offline Task-creation rejection rule.

Planned shutdowns and restarts are expected only after unfinished work has been resolved. If an exceptional interruption occurs, reconcile with the Asset before deciding the outcome of unfinished Tasks. Do not automatically fail them merely because connectivity was lost or the Asset restarted.

Assigned work is discovered through `GET /entities/{entity_id}/tasks`, using an outstanding-work filter, and through Task change events. The Asset tracks and executes its queue and reports transitions through the Task lifecycle routes. The Asset reports `acknowledged` when accepting a Task into its local queue and `in_progress` when execution begins. Exact filtering remains to be specified.

Unstarted Tasks, including acknowledged Tasks, can be reordered. Submission sequence stays immutable. Requested queue order is distinct from the order confirmed by the Asset; disconnected Assets can continue their last received order. Running and terminal Tasks cannot be moved.

A cancellation request does not immediately terminate work already accepted by the Asset. Keep its execution state until the Asset confirms cancellation or reports another valid outcome. The request itself cannot establish that physical execution stopped. The existing six Task status values remain unchanged.

Existing Task lifecycle routes remain, but they no longer require the former execution-session identity in the approved API design. Task IDs, immutable Asset assignment, idempotency, and legal lifecycle transitions still matter. Current status is not a substitute for all of those rules.

The earlier model used a process identity to reject late reports from an older process and to fail outstanding Tasks on restart. A status value alone cannot distinguish an old process reporting `ready` from its replacement reporting `ready`. This replacement intentionally leaves that mechanism unselected rather than quietly adding the old session identifier under a different name. Decide how to reject stale execution reports and handle restarts before implementing task execution.

Pending decisions:

- The mechanics of reconciling unfinished Tasks after an exceptional interruption, without assuming an outcome from Asset status alone.
- How late or duplicate reports and multiple processes claiming the same Asset are handled.
- Detailed sequence encoding and Asset behavior after cancellation or failure of a queued Task.
- Task reorder revision/conflict rules and the mutation/confirmation API for the agreed eligible states.
- Cancellation confirmation API, never-accepted work, and delivery/acknowledgement races.

## Scope and source

This replaces the public Asset execution-session design across the current planning documents. It does not remove the host manager's responsibility for running Plugin containers. Taskable Plugins follow the same Asset status model through their managed internal integration, without individual Plugin API keys.

Source snapshot: Atlas Modernization commit `8edee4e2743fbf0f85c16dfe638d9222141cf279`, read locally:

- [Asset status guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/ASSET_STATUS_SYSTEM.md).
- [Earlier Task and execution-session design](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md), retained as historical context for the safeguards that need a replacement decision.
