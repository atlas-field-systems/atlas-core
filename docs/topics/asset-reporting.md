# Asset reporting

This page owns what an Asset reports and how Core treats it: Operational status, Communication state, Contact and freshness, check-in, partial component updates and Asset report acceptance.

Identity, Enrollment and registration follow [Identity and access](identity-and-access.md). Task lifecycle, queues, Pause/Resume and reconnect reconciliation follow [Tasks](tasks.md). Movement samples follow [movement history](../architecture/system-design.md#movement-history), and Track observations follow [ADR-0022](../adr/0022-one-publisher-per-track.md).

## Components and initial values

Every Asset requires three components: `status` holds its Operational status, `communications` its Communication state and `heartbeat` its Contact. They belong to the Asset's Entity record and appear in ordinary reads and the SDK's synchronized operational picture. Changes to them are versioned Entity changes delivered through `/feed` and `/queries/changed-since`; there is no separate status stream.

[Asset registration](identity-and-access.md#asset-registration) creates the record with the values below and does not carry Operational status. The first check-in reports it.

| Component | Value before the first report |
| --- | --- |
| Operational status | `unknown` |
| Communication state | `offline` |
| Contact | `last_seen: null` |

Core does not invent a contact timestamp.

## Operational status

Operational status is the Asset's reported operational condition, separate from Task lifecycle states. Its values communicate state; they are not Core scheduling gates. Assets own queued and immediate Task execution, and Core does not use reported Operational status or Communication state to schedule their work.

| Status | Meaning |
| --- | --- |
| `unknown` | No usable operational report is available yet |
| `initializing` | The Asset is starting or preparing its capabilities |
| `ready` | The Asset is prepared to perform its advertised capabilities |
| `busy` | The Asset is executing work |
| `paused` | The Asset has handled an immediate Pause Command, suspended current queued work if any, and is waiting in its own idle behavior; queued work does not advance |
| `error` | A reported fault prevents normal operation; details explain the fault |
| `stopped` | The Asset has deliberately stopped operational activity |

Every Asset has an Operational status, even one that only reports observations. Being `ready` does not invent tasking capabilities the Asset has not advertised. Plugins are not Assets and do not report Operational status; their Operations and lifecycle follow [ADR-0002](../adr/0002-core-manages-installed-plugins.md).

The status routes apply only to Asset Entities. A status report carries the status and an optional reason and details. Status supplied through the status routes, check-in or any permitted Entity patch shares one set of validation, transition and update rules. Detailed transition and report validation remains open.

### Transition examples

These proposed examples are not an exhaustive transition validator.

| Situation | Example transition | Meaning |
| --- | --- | --- |
| Asset begins startup | `unknown` or `stopped` → `initializing` | Preparation is in progress |
| Preparation completes | `initializing` → `ready` | Advertised capabilities are available |
| Work starts | `ready` → `busy` | At least one operation is executing |
| Queue is drained | `busy` → `ready` | Asset reports that it is available again; finishing one Task need not imply an empty queue |
| Immediate Pause is applied | `busy` or `ready` → `paused` | Asset confirms suspension and its idle condition; the queued path is retained |
| Immediate Resume is applied | `paused` → `busy` or `ready` | Resume suspended work first; if none exists, release the waiting queue. Failed resumption follows the failure policy; report Task outcomes separately |
| A fault occurs | Any operational state → `error` | Report a reason; do not invent a Task outcome |
| Fault recovery | `error` → `initializing` or `ready` | Asset reports recovery |
| Deliberate stop | An active state → `stopped` | Asset reports stopping |

A reconnect can reveal a transition Core never observed. Core distinguishes a current state report from an instruction to perform a transition: reporting `stopped` is not a stop Command, and reporting `busy` is not Task acceptance.

### What Operational status does not establish

- A Task outcome. Core infers no Task outcome from a status report, including `error`. An Asset report and a Task report arrive separately, and one does not imply the other.
- Current availability. Core keeps the last reported Operational status and its report time visible; an old `ready` report does not prove the Asset is available now.
- Command support. A status value does not contain the Command Catalog; see [Command support](#command-support).
- Retirement. [Asset retirement](identity-and-access.md#asset-retirement) is a Core-owned administrative condition, not an Operational status.

### Report times

The proposed reporting metadata records when Core received the Operational status and when it last changed. The status read returns the status, its report times and any reason and details. A telemetry-only update refreshes Contact without refreshing the Operational status report time. Contact freshness and the freshness of each reported component remain distinct. Exact fields and timestamps remain open.

## Communication state

Communication state is Core's assessment of its link with an Asset. It is required on every Asset and separate from Operational status.

| Communication state | Meaning |
| --- | --- |
| `high_bandwidth` | Communication is working with sufficient capacity for unrestricted Atlas communication |
| `healthy` | Communication is working as expected for a constrained link |
| `degraded` | Communication is available but impaired, regardless of connection type or nominal capacity |
| `offline` | Communication is unavailable |

High bandwidth is not tied to a specific connection technology. Connection type, such as Wi-Fi or Ethernet, is recorded separately. Healthy is relative to the link's expected performance: a constrained link is not degraded merely because it is slower than Wi-Fi. When communication deteriorates, degraded or offline takes precedence over high bandwidth, so a Wi-Fi connection can be degraded or offline.

### Derivation and link expectations

Core derives Communication state; no participant reports the state itself. Core uses the connection type, capacity class and link-quality observations reported by the Asset or its gateway, together with configured expectations for that link. A single timeout must not assume every link has Wi-Fi timing. The state is `offline` until the first report. Core does not infer execution policy from Communication state.

Under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md), a gateway reaches Core through the general SDK over an adequate IP link, and constrained radio communication runs between the gateway and its Assets.

## Contact and freshness

Contact is Core's record of the latest fresh accepted report from an Asset, held in the `heartbeat` component as `last_seen`. Core records the receipt time in [Core time](../adr/0025-use-core-time-as-the-installation-reference-clock.md); clients cannot supply it.

### What refreshes Contact

Every accepted fresh Asset-originated report refreshes Contact:

- check-in;
- component updates, including telemetry-only patches;
- Operational status updates;
- Task acknowledgements, starts, progress and outcomes;
- queue adoption and conflict reports.

A separate heartbeat packet is not required while other reports are arriving. An unchanged measurement in a newly generated report can still establish Contact when fresh. When a Task or queue report refreshes Contact, the Entity's heartbeat change commits and publishes atomically with the Task or queue change.

These never refresh Contact:

- Core's own derived changes;
- interface-originated Task creation or cancellation, and operator reorder requests;
- operator edits to Descriptive data, such as an alias;
- duplicate reports and historical backlog;
- a live gateway connection, which does not by itself establish Contact with an Asset behind it.

### Fresh, duplicate and historical reports

Core distinguishes fresh reports from the late arrival of delayed data. A report is fresh contact evidence only when the Asset's current process generated it within its freshness window, judged in Core time. Position in the report sequence never decides Contact: a previously unrecorded historical outcome delivered as the newest report after reconnection is recorded without making a disconnected Asset appear recently reachable. Core does not infer current reachability merely from a newly received old packet.

Delayed reports never overwrite newer component values. [Report acceptance](#asset-report-acceptance) applies this per affected state.

Continuous, near-real-time reporting is the expected model during operations such as flying to an area, taking photographs and returning. Long disconnected missions with occasional telemetry uploads are not. These rules handle brief transport interruptions, retries and reordering, not a planned long-disconnected store-and-forward workflow. No numeric reporting interval, freshness window or latency guarantee is selected.

### Losing Contact

A disconnected Asset may still be physically executing a Task. Loss of Contact must not silently turn a Task into failed, completed or cancelled; [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) resolves it.

## Check-in

Check-in is an Asset's report of its current Entity data: Reported data such as Operational status, position and Command support. It establishes Contact when fresh, and Core records its receipt time. It does not deliver or reconcile Tasks; [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) combines it with Task catch-up and outcome reports.

Registration is followed by the first check-in, and the Asset checks in again as needed, directly or through its gateway. Check-in and component updates share Protocol-defined [partial-update](#partial-component-updates) validation, report identity and freshness rules, so later reports can contain only changed component fields.

### Command support

Assets advertise supported Protocol Commands on their Entity record. Command support is Reported data: only the Asset supplies it, at registration and check-in, rather than through a separate readiness session. It is distinct from Operational status. Dropping support for a Command does not remove outstanding Tasks that use it; [dropped Command support](tasks.md#dropped-command-support) defines how the Asset reports them.

## Partial component updates

Clients send partial component JSON through the existing Entity routes: the Entity patch and check-in. There is no separate registration, telemetry or per-component update endpoint. For example, an Asset can send only a changed heading. This illustrates the JSON structure, not a final SDK signature:

```json
{
  "components": {
    "telemetry": {
      "heading": 90
    }
  }
}
```

Existing position and other omitted fields remain unchanged. The merge rules are:

- Omitted fields remain unchanged.
- Supplied scalar fields replace previous values.
- Nested fields merge.
- Arrays replace completely.
- Explicit null removes an optional component or clears a nullable field.
- Removing a required component fails validation.
- A partial payload that creates an absent component must still satisfy that component's complete schema; it cannot create an invalid component.

Core validates the complete resulting resource against Protocol-defined component schemas and applicability, commits it atomically and emits the corresponding Entity change. The physical storage layout need not match the JSON envelope.

Operator-managed and other descriptive edits require the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits). Asset-originated reports use [report acceptance](#asset-report-acceptance) and ordering instead of that precondition.

## Report authority and relay

The Asset authors its Reported data. Interfaces send Tasks rather than editing the Asset directly, and an operator cannot submit Asset-reported components. Operators may edit Descriptive data, such as the alias, without passing through report acceptance; such edits never touch Contact. Core owns Derived data: Communication state, Contact, receipt timestamps and resource versions.

Core verifies the reporting Asset's identity on every reporting path under the [Asset caller rules](identity-and-access.md#assets).

A [radio gateway](identity-and-access.md#radio-gateways) relays reports only for its bound Assets. Through the translation it preserves each Asset's report origin, process authority, current work and required live data. A gateway restart does not by itself establish that an Asset process restarted or lost execution knowledge, and a gateway cannot invent execution evidence.

## Asset report acceptance

Every Asset-originated report passes through one acceptance contract before anything is applied: check-in, component and Operational status updates, Task lifecycle reports and queue adoption or conflict reports. Acceptance gives two independent answers. The disposition decides what to apply:

| Disposition | Meaning | Effect |
| --- | --- | --- |
| Accepted | A new report from the bound Asset's current process | Apply each reported fact that does not move its affected state backwards, judged per affected state: Task outcomes, component values and movement samples with their observation time. A newer recorded value is never overwritten |
| Duplicate | A report already accepted | No new effect; return current recorded state |
| Rejected | Wrong principal, obsolete process, or not an Asset report | No effect; explicit rejection |

Separately, contact evidence says whether an accepted report proves the Asset is reachable now, under the [freshness rule](#fresh-duplicate-and-historical-reports). Only then does acceptance refresh Contact.

Report deduplication, ordering of affected state and proof of fresh contact stay distinct. Later telemetry must not discard an unrecorded Task outcome solely because the outcome has an earlier sequence, and accepting historical work must not refresh Contact. An obsolete process is identified by the Core-issued process generation and authority transfer from [Asset recovery](tasks.md#recovery-after-an-unexpected-asset-restart). [Asset registration](identity-and-access.md#asset-registration) is not a report.

Core persists accepted-report identities and ordering boundaries across same-release Restart, atomically with the affected component values, Contact and movement samples. Reset clears that state, and Core rejects reports for the old Dataset. Ordering may require per-component or report-stream boundaries. No complete packet log or specific wire encoding is selected. [System design](../architecture/system-design.md#shared-asset-report-acceptance) describes how Entities and Tasks collaborate to enforce this.

## Earlier design

Atlas Modernization stored Operational status in `components.status.value` and connection state in `components.communications.link_state`. Its check-in refreshed the heartbeat and could report telemetry and Operational status together. Its [Asset status guide](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/ASSET_STATUS_SYSTEM.md) defines connection states but accepts an Operational status string rather than a complete operational lifecycle table.

Atlas uses that reporting approach as a reference. The four Communication states replace its connected, disconnected and unknown vocabulary. Operational status reporting replaces the public execution-session API, including its registration, readiness, shutdown and session-scoped Task polling. Host management still runs Plugin containers.

## Routes and SDK operations

- Check in: `POST /entities/{entity_id}/checkin` in the [Entities routes](../api-endpoints.md#entities), through the SDK's Check in [operation](../sdk-operations.md#initial-operations) and [Asset startup](../sdk-operations.md#asset-startup).
- Update Asset components: `PATCH /entities/{entity_id}` in the [Entities routes](../api-endpoints.md#entities), through Update Asset components.
- Read and report Operational status: `GET` and `PATCH /entities/{entity_id}/status` in the [Asset status routes](../api-endpoints.md#asset-status), through Report Asset status.
- Task lifecycle and queue adoption reports: `PATCH /tasks/{task_id}/status` in the [Tasks routes](../api-endpoints.md#tasks) and `POST /entities/{entity_id}/task-order/confirm` in the [Entities routes](../api-endpoints.md#entities). They refresh Contact under this page.
- The SDK's [Asset client](../sdk-operations.md#asset-client) submits every Asset-originated report and owns its report identity, ordering and the Core-issued process generation.

## Open questions

- Detailed Operational status transition and report validation.
- Exact status report metadata fields and timestamps.
- Communication state capacity and quality criteria, transitions, link expectations, link-specific timeout thresholds and freshness indicators, and how link observations are represented.
- Report identity and ordering fields and scope, freshness windows, relay-origin fields and relay proof, and Core-time offset estimation.
- SDK mapping for accepted, duplicate and rejected reports and their conflict results.

## Decisions

- [ADR-0004](../adr/0004-core-owns-commands-and-assets-execute-tasks.md): Core owns Commands and Assets execute Tasks.
- [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md): Task and queue reports, process generation and authority transfer, and no Task outcome inferred from lost Contact.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): acceptance state survives Restart and is cleared by Reset.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): IP-connected Assets and gateways report through the general SDK's Asset client; constrained links sit behind gateways.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): Contact freshness is judged in Core time.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Asset identity and contact: fresh versus duplicate and stale reports, queue reports and Contact, operator actions that never establish Contact, and alias edits that do not disturb reporting.
- Asset-process recovery: later telemetry before an unrecorded Task outcome, and historical traffic that does not establish fresh Contact.
- Reset and Restart: retained acceptance state, and duplicate or delayed reports that cannot refresh Contact or overwrite newer data.
- Every public SDK operation: absent, null and partial-field behavior.
- Task queues: no Core scheduling gate based on Communication state.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds shared acceptance through Entity and Task reporting against real SQLite, closing the reporting contract in the first Asset reporting workflow, and the accepted, duplicate and rejected dispositions through every reporting route. [Radio gateway testing](../testing-strategy.md#external-systems-and-future-radio-gateways) requires that a gateway's live connection never turns a delayed report into fresh Contact.
