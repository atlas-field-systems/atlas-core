# SDK

This page owns the general Atlas SDK: who uses it and what stays Core's responsibility, HTTP mode and Full synchronization mode behind one read interface, the Local operational picture and its synchronization, recovery and resource limits, write results, Dataset Reset handling, historical reads, helpers, the Asset client, client compatibility, the deferred Asset hybrid mode and the SDK operations catalog.

This is a design, not an implemented SDK interface; exact method names, signatures and the policies marked as proposals remain open. Core-side change publication and gap detection are mechanisms in the system design under [Change publication](../architecture/system-design.md#change-publication) and [Detectable synchronization gaps](../architecture/system-design.md#detectable-synchronization-gaps). Read permissions follow [Callers and permissions](identity-and-access.md#callers-and-permissions), and the Dataset boundary follows [Dataset lifecycle](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).

## Who uses the general SDK

Participants on IP links without bandwidth limits use the Atlas SDK to interact with Core: applications, Command Interfaces, Plugins, IP-connected Assets and radio gateways. A health-check client, Command Interface and data-processing Plugin use the same supported SDK, with behavior appropriate to their needs. The local CLI/TUI administers the installation through internal management interfaces and does not use the SDK or public API.

The boundary is bandwidth, not whether the participant is an Asset. An IP-connected Asset without bandwidth limits uses the general SDK like any other consumer, including the [Asset client](#asset-client) for its reports, and may use either mode; the extra traffic is acceptable on such links. Bandwidth-limited Assets do not run the general SDK: their execution and constrained transport belong to the Asset OS and a radio gateway, through which they reach Core.

The SDK is TypeScript only for now, so an IP-connected Asset's software either uses TypeScript or runs the SDK in a companion process. Another SDK language would be a separate decision.

### Bandwidth and gateways

The general SDK assumes adequate IP bandwidth between its consumers and Core, including a gateway running on a different host or network. A gateway usually runs separately from Core, may run on the Core machine and need not share Core's local network. Adequate IP bandwidth is a deployment assumption, not a measured capacity or throughput guarantee, and IP access does not require internet access when Core is locally reachable. Numeric capacity and latency still require measurement.

Gateways use HTTP mode or Full synchronization mode over their IP connection to Core, can obtain the full operational picture and select what crosses their radio link. No Core-side hybrid filtering is required. The constrained link is between the gateway and bandwidth-limited Assets; adequate gateway-to-Core bandwidth does not establish the capacity or behavior of that radio link. Gateway identity and relay limits follow [Radio gateways](identity-and-access.md#radio-gateways), and gateway translation of Asset reports follows the [relay rules](asset-reporting.md#report-authority-and-relay).

HTTP/OpenAPI remains the selected Core interface. A gateway uses the general SDK on its Core-facing IP link and separate radio software for Asset messages. No radio packet format, compression algorithm, batching protocol or per-packet overhead guarantee is selected; radio delivery, including updates needed by a Command whose dependencies change during execution, remains future gateway work. Compact authenticated transport remains design work; any optimization must preserve the [caller identity](identity-and-access.md#callers-and-permissions) and [revocation](identity-and-access.md#credential-revocation) rules. A future radio gateway may translate operations compactly, but must preserve authenticated Asset origin, process authority, execution evidence, retry identity and Dataset semantics.

Partial component updates, stable retry identities and bounded recovery remain because they preserve useful behavior without another read mode. A future deployment whose IP link is itself constrained may use a dedicated SDK or integration designed for it, without expanding this general SDK's scope.

## Supported entry point and Core responsibilities

External IP interaction with Core goes through the SDK, including Object upload and download. The SDK should make both basic API access and a maintained picture clear without duplicating endpoint definitions or requiring a second client library outside it.

Core remains responsible for authentication, authorization, Task transitions, Object readiness and committed-state consistency at its API boundary. The SDK is the supported client entry point, not a substitute for those server responsibilities.

Protocol describes event and resource shapes. Core owns committed state and the recovery log. The SDK owns the local projection, event ordering, connection recovery and reporting synchronization state. These are public behavioral contracts rather than dependencies on private implementation details.

## Modes

The SDK has two modes. Every mode writes to Core.

| Mode | When application code requests data | Background work | Intended use |
| --- | --- | --- | --- |
| HTTP mode | Resource reads, queries and feed subscriptions pass through to Core's API; never use a local picture | No operational-picture synchronization; an explicit feed subscription connects to Core's feed | Simple integrations and occasional reads |
| Full synchronization mode | Reads and queries use the Local operational picture; feed subscriptions observe applied local changes; no direct API pass-through | Initial load, live feed subscription and recovery keep the picture updated | Interfaces and services that repeatedly read the same operational data |

Basic API access starts no synchronized replica. Applications that need a maintained shared picture opt into synchronization; an application's role does not select its mode automatically. Making HTTP mode the simple default, with an explicit choice to start synchronization, is recommended. The mode is selected at configuration, not by each caller choosing separate API and picture surfaces.

The benefit of Full synchronization mode is shared state within one SDK instance: several components reading the same Entity through that instance use the same maintained picture instead of making repeated HTTP requests. Separate processes or browser tabs do not automatically share memory or a feed connection. A shared service is outside the current design.

### One read interface

Both modes expose the same resource-read, query and feed-subscription methods, with shared arguments and resource and event shapes, based on the same Protocol resource definitions. Selecting Full synchronization mode changes where operational reads are answered, not what an Entity or Task means. Applications do not use a second set of cache-specific read methods.

| Application operation | HTTP mode | Full synchronization mode |
| --- | --- | --- |
| Resource read or list | Matching Core resource endpoint | Read or filter the local picture |
| Full operational query | `GET /queries/full` | Local full Dataset |
| Changed-since query | `GET /queries/changed-since` | Locally retained picture changes |
| Feed subscription | Core's `/feed` | Applied local picture changes |

HTTP reads and local picture reads are the two concrete adapters at one private read-source seam; this does not require a general cache-provider interface. The SDK owns routing, complete-picture coverage, recovery and reconciliation while exposing meaningful readiness, freshness and failure facts.

The same method signature does not imply identical freshness or network traffic.

### Read-source boundary

The mode defines the read-source boundary, with no cross-source fallback:

- HTTP failures do not fall back to cached data.
- In Full synchronization mode, a missing record, stale picture, incomplete coverage, unsupported local query, expired local cursor or missing local history is reported as that limitation. It never triggers an HTTP resource read or query pass-through.
- There is no per-call bypass within Full synchronization mode. A client that needs operational resource API reads uses HTTP mode.

Exact readiness and error responses remain to be designed.

### Data outside the picture

File bytes remain explicit downloads in both modes. Plugin discovery and status, Plugin Operations, Operator profiles, API keys and Core settings are outside the operational picture and use their supported API methods in every mode. Historical reads follow [Historical reads](#historical-reads). Plugin management is [local-only](plugins.md#local-administration) and has no SDK methods. Command Catalog lookup is local to the installed Protocol package in both modes under [Commands and the Command Catalog](tasks.md#commands-and-the-command-catalog).

## Local operational picture

### Contents

The initial synchronized resource set is Entities (Assets, Tracks and Geofeatures), Tasks with their latest execution state, and Object metadata and associations. Operational status is synchronized as part of the Entity record. Only ready Object metadata enters the picture, under [ready-only visibility](objects.md#ready-only-visibility); upload staging and progress remain separate, and Object content is downloaded separately.

Full synchronization mode loads the full operational resource set. Application query filters do not narrow its background scope, and there are no selective subscriptions. The full picture retains unrelated resources and delivers coherent queue state and committed updates to resources that Tasks reference, such as a moving Track or edited Geofeature geometry.

The picture is held in memory without disk persistence and is rebuilt on SDK restart. An incomplete or filtered picture must never be mistaken for the full Dataset. The exact supported local query operations must be documented so callers know which reads can be answered locally.

### Picture ownership

Within the SDK, one Local operational picture module owns the state that must agree: resource versions and deletions, coverage, applied recovery position, local history and cursors, picture rebuild and readiness. Initial loading, feed delivery and replay recovery cooperate through that owner. Reads, queries and local subscriptions observe its reconciled state; individual SDK resource methods do not separately advance cursors or emit picture changes.

HTTP mode does not construct a picture. Keep loading, buffering and history helpers private where useful; depth comes from hiding their coordination, not from putting the entire implementation in one file.

Rejecting obsolete Dataset inputs, invalidating rebuilt pictures and deduplicating notifications have locality in this module, giving reads and subscriptions leverage from one implementation. Both modes still enforce [Dataset Reset handling](#dataset-reset-handling). Snapshot loading, feed delivery and replay recovery are the only picture data inputs; write responses do not participate under [Write results and the picture](#write-results-and-the-picture). Interface shapes, cursor encoding, coverage messages and limits remain design work.

### Background synchronization

Background synchronization is separate from application operations. The synchronizer privately uses these endpoints to maintain the picture; application query and feed calls in Full synchronization mode resolve locally instead of exposing these remote connections.

| Endpoint | SDK responsibility |
| --- | --- |
| `GET /queries/full` | Load all initial pages of operational data and retain the supplied baseline version |
| `GET /feed` | Subscribe to pushed create, update and delete events |
| `GET /queries/changed-since` | Recover events missed during loading, disconnection or a detected gap |

Finish the initial paginated load, then recover changes since its baseline before treating the picture as current. The paginated read is not a frozen snapshot: keep its baseline stable across pages and separate from the versions on individual resources. Subscription acknowledgement and its continuation boundary close the handoff to live delivery. On feed reconnect or a version gap, recover through changed-since. If retained history no longer covers the requested version, Core returns an explicit cursor-expired response and the SDK makes a new initial load.

Proposed synchronization lifecycle:

1. Load every initial page, keeping the server's baseline version.
2. Establish the feed subscription and wait for confirmation that it is active. Buffer live events during catch-up.
3. Drain changed-since from the baseline, then reconcile buffered events. Mark synchronization ready only after recovery covers the subscription boundary and the handoff is complete.
4. Apply pushed changes to local state. Repeated application reads use that state without triggering HTTP reads.
5. On a connection interruption or version gap, report degraded synchronization and recover from the last fully applied cursor. If the cursor has expired, rebuild from a full load and catch up again.

### Synchronization contract with Core

Full synchronization couples Core and the SDK through a documented synchronization contract:

- Feed and recovery expose the same committed changes and version ordering.
- Events carry full resource data for creates and updates, and versioned deletion records for deletes. Object content is not sent through the feed.
- Applying an old response or duplicate event cannot overwrite a newer resource or resurrect a deleted one.
- A global recovery cursor advances only after all relevant changes through that boundary are applied. The version on a single resource or mutation response is not proof that unrelated changes have been consumed.
- Subscription acknowledgement closes the gap between fetching state and listening for future changes.
- Recovery history has a defined retention limit and an explicit expired-cursor response. Overloaded clients reconnect and recover rather than silently dropping changes and claiming to be current.

### Readiness and freshness

The picture represents the latest state the SDK has successfully received. It is not guaranteed to contain a change committed to Core at the exact instant of a local read.

A cache expiry time is not the correctness mechanism. Versions and recovery establish which changes have been applied. Timers still have useful roles for connection liveness, reconnect backoff and reporting how long synchronization has been interrupted. No fixed freshness or latency guarantee is established.

- Before the initial picture is ready, reads report that it is not ready instead of treating an empty cache as an empty Dataset.
- During an interruption, the SDK retains the last known picture and exposes its degraded, stale or disconnected status. Reads remain local; they do not request fresh data directly.
- A missing ID is a local not-found result only when the picture has the required coverage. Otherwise the SDK reports that it cannot answer the lookup.

Proposed caller-visible status includes whether the SDK is initializing, synchronized, recovering, disconnected or stopped, plus its last applied cursor, last successful synchronization time and any current error. A timestamp alone is not proof that the picture matches Core. Exact error and status shapes remain to be specified.

### Synchronization gaps and recovery

When a slow consumer, expired replay history or another delivery gap prevents complete replay, the SDK marks its picture stale and obtains a fresh snapshot with a consistent continuation point before treating it as current again. Core's side of this contract is under [Detectable synchronization gaps](../architecture/system-design.md#detectable-synchronization-gaps).

### Local feed, history and cursors

In Full synchronization mode, a feed event becomes visible to application subscribers after the corresponding change is applied locally. The SDK does not forward raw remote feed messages before reconciliation, and application subscriptions do not open their own Core feed connections. In HTTP mode, the feed operation is a remote API subscription; it does not construct or observe a local picture.

Local changed-since queries require locally retained change history, including deletions; a current-state cache alone cannot answer them. Retain a bounded local change history with configurable limits. When history no longer covers a cursor, return an explicit cursor-expired result; the application can request a fresh local snapshot.

Local cursors belong to one SDK instance and picture rebuild, become invalid when that picture is rebuilt, and cannot be exchanged with Core cursors or another SDK instance. The remote recovery cursor used by the background synchronizer is not interchangeable with an application query cursor.

### Resource limits

Use explicit resource limits and report when the full picture cannot be maintained. Never silently discard resources and claim complete coverage, or present a partial load as ready. Bounded change-history retention is separate from retaining the current resource picture.

## Writes

Both modes use the same methods to submit creates, updates, deletes and Task lifecycle changes to Core. Operator-managed and other descriptive edits use the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits). Asset-originated reports follow [Asset report acceptance](asset-reporting.md#asset-report-acceptance), independently of descriptive-edit preconditions. Track observations, Geofeature geometry edits and Entity deletion follow [Entities, Tracks and Geofeatures](tracks-and-geofeatures.md) and use the same methods in both modes.

The local picture is not a second authority, and there is no SDK offline mutation queue. Core accepts valid Tasks for offline Assets under [Task creation](tasks.md#task-creation), but the client must still reach Core to submit the request.

### Write confirmation

Both modes return Core's authoritative write result once Core confirms the commit and the SDK validates the response and Dataset. The SDK does not wait for the local picture to catch up. For example, a Task creation can return its accepted Task while a synchronized Task-list read still shows the older picture. Acceptance does not establish Asset receipt or execution. Synchronization state is reported separately; ordinary write success is not a local read-after-write guarantee.

A lost HTTP response uses the operation's existing retry identity. Writes rejected by Core never appear as committed picture updates. HTTP mode returns Core's response without maintaining a local picture.

### Write results and the picture

The returned result is separate from picture state. In Full synchronization mode, committed changes reach the picture only through snapshot loading, feed delivery and replay recovery, under their ordering rules. A write response never changes picture reads, emits local feed notifications, appends local history, advances a picture cursor or contributes a reconciliation input, even if it includes a newer resource. The caller may use the returned result separately from picture reads. Exact response envelopes remain Protocol work.

For example, if the picture has applied N and a successful write response for N+2 arrives before N+1, return the write result without waiting for N+1. The picture waits for synchronization to supply the relevant changes, applies N+1 before N+2 and emits each local change once. A single-resource response cannot stand in for other resources changed by the same commit. Version checks on synchronization inputs prevent stale overwrites and resurrection; a late write response cannot change the picture at all.

If synchronization is interrupted or replay expires after a successful write, preserve the write result and recover or rebuild the picture under the ordinary synchronization rules. Keep its stale or not-ready status accurate, invalidate local cursors on rebuild and do not automatically resubmit an accepted mutation. A Dataset change follows [Dataset Reset handling](#dataset-reset-handling) and cannot insert the old result into the new picture. Any separate opt-in helper for waiting until the picture reflects a commit remains engineering work; no such wait is part of ordinary write success.

## Dataset Reset handling

Both modes follow Core's [Dataset boundary](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary): Dataset identity survives Restart and changes on Reset. It is separate from a picture rebuild and from Asset process identity.

Before accepting responses or retrying submissions, the SDK checks Dataset identity. After detecting Reset, it discards the old picture, local history and cursors, pending submissions, obsolete upload identities and recovery handles. It rejects late responses and events from the prior Dataset and never relabels an old write as a new submission. Full synchronization mode returns to not-ready and loads the full picture afresh; HTTP mode rediscovers the Dataset without constructing a local picture. This is background recovery, not an application-read fallback.

A disconnection without a known Reset may retain a visibly stale picture; once Reset is known, that picture cannot be served as the current Dataset. Wire fields and the discovery binding remain implementation details.

## Historical reads

Movement and activity history are explicit, on-demand SDK operations outside the read-operational-data interface and its Entity, Task and Object picture. The same historical methods call `GET /entities/{entity_id}/movement-history` and, for operator administrative clients, `GET /admin/activity` in both modes. This is a declared separate API category, not a cache-miss fallback or per-read bypass on synchronized resource methods.

History results never populate the live picture, emit its local feed events or advance its recovery cursor, and they do not start background synchronization of historical rows. History pagination uses Core cursors and Dataset identity, separate from local picture cursors. Reset invalidates old history requests and results. Local changed-since queries mean bounded local change history, not movement or activity history. No history cache or offline-history promise is introduced. What history Core records and returns follows [Activity and movement history](history.md).

## Helpers

Keep the Core API small and explicit. The SDK owns client-side conveniences such as whole-file upload retries, pagination, submission retry identity and waiting for Operation outcomes. These helpers compose supported API operations and live separately from generated bindings; they do not duplicate endpoint contracts or patch generated code. Add helpers for actual consumer workflows, not a general workflow engine.

The SDK exposes typed methods and documentation for its operations. No machine-readable SDK-operation discovery function is planned without a concrete consumer.

Topic-specific helper rules:

- Task lifecycle helpers, Pause and Resume, assigned-work reads, queue operations and recovery follow [Tasks](tasks.md#routes-and-sdk-operations). Helpers return Core's recorded Task state; a scan completion report may leave its Task nonterminal under [scan completion](tasks.md#scan-completion). Route-level Task status helpers remain for tasking clients, such as an operator requesting cancellation.
- Upload retries, deleted-result retries and protected deletion helpers follow [Objects](objects.md#routes-and-sdk-operations).
- Operation submission identity, retries, outcome queries and cancellation follow [Plugins](plugins.md#routes-and-sdk-operations).
- The SDK preserves an edit's original version precondition under [Concurrent descriptive edits](../architecture/system-design.md#concurrent-descriptive-edits).

## Asset client

The Asset client is the SDK module that owns all Core-facing traffic originating from an Asset, for IP-connected Assets, radio gateways and simulated-Asset test fixtures. Bandwidth-limited Assets do not run it; their gateway does. It covers registration and Enrollment, check-in, component and status reports, Task lifecycle reports, required-result uploads, queue adoption and conflict reports, and reading assigned work. It is the SDK side of [shared Asset report acceptance](../architecture/system-design.md#shared-asset-report-acceptance), with HTTP as its Core-facing transport adapter. SDK consumers submitting Asset-originated reports use the Asset client, which owns their coordination.

The Asset client owns:

- First registration before a normal Asset credential exists, under enrollment authorization, with its retry identity, and re-registration after Reset, under [Asset registration](identity-and-access.md#asset-registration) and [Enrollment](identity-and-access.md#enrollment).
- Required-result uploads: it preallocates the result Object ID under [Object IDs before upload](objects.md#object-ids-before-upload), uses it in the completion report and delegates the whole-file upload to the existing upload operation, retaining its request identity. No new route is added.
- Report identity and ordering, and the Core-issued process generation, matching [Asset report acceptance](asset-reporting.md#asset-report-acceptance) in Core.
- Pause and Resume report correlation and queue revision adoption under [Tasks](tasks.md#pause-and-resume).
- Lost-response retries with stable identities, and discarding obsolete work and submissions when the Dataset changes before re-registering in the new Dataset.
- [Reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation).
- Delivery of committed updates that running Commands depend on, such as [live Geofeature geometry](tracks-and-geofeatures.md#live-geometry-for-existing-tasks), to execution; a gateway does this for its bound Assets.

After an Asset process restart, the Asset OS supplies its onboard execution evidence to the Asset client, which follows [recovery](tasks.md#recovery-after-an-unexpected-asset-restart): it obtains a new process generation, reports what that evidence establishes and keeps uncertain work out of its assigned-work stream until explicit recovery. It never schedules, starts or reruns work; the Asset OS owns scheduling and execution.

The SDK keeps no disk persistence. State that must survive a process restart, such as a pending registration identity, is prepared by the Asset client and handed to the Asset OS or deployment layer to retain before submission, following the [API-key creation](identity-and-access.md#api-keys) pattern.

The Asset client does not implement the Asset OS or a radio protocol. Radio delivery, evidence transfer and authenticated relay delegation remain future work; a gateway identity can relay only for its bound Assets. Exact method names and interface shape remain open.

### Asset startup

1. The Asset client invokes registration with information supplied by the Asset OS or gateway. The SDK uses ordinary Entity creation, not a dedicated registration endpoint.
2. [Enrollment](identity-and-access.md#enrollment) automatically binds an authenticated Asset identity, and Core validates the supplied initial data and creates the Asset with its [initial reporting values](asset-reporting.md#components-and-initial-values).
3. The Asset sends [check-in](asset-reporting.md#check-in) with its Reported data, such as Operational status and position.
4. The Asset sends further reports as needed, containing only changed fields if it chooses. [Contact and freshness](asset-reporting.md#contact-and-freshness) defines which reports refresh Contact.

Registration content, stable Asset IDs and retries follow [Asset registration](identity-and-access.md#asset-registration). Check-in, component updates and status reports follow [Asset reporting](asset-reporting.md), including [partial component updates](asset-reporting.md#partial-component-updates) and [report authority and relay](asset-reporting.md#report-authority-and-relay).

## Compatibility

Core, Assets and SDK clients may use different versions within declared supported compatibility ranges under [ADR-0005](../adr/0005-allow-compatible-client-versions.md). Unsupported versions fail explicitly. Adding a compatible optional field need not force a simultaneous update. Task creation also checks the target Asset's advertised [Command support](tasks.md#command-support), and Command Catalog lookup follows [Commands and the Command Catalog](tasks.md#commands-and-the-command-catalog). The SDK, including the Asset client, maintains the Core-time offset estimate and exposes its uncertainty where a rule depends on it, under [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md). Exact advertisement and negotiation fields remain open.

## Deferred: Asset hybrid mode

Asset hybrid mode and Core's matching Asset-scoped snapshots, feed, replay, dependency membership and scope-continuation contract are deferred under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md). This deferral does not change Core's Task retention, Required-result protection, Asset report authority, retries, reconnect reconciliation or the remaining picture guarantees.

## Operations catalog

The catalog lists the approved SDK workflows and their API mappings. The names describe behavior, not final method names. It is separate from the Protocol Command Catalog: SDK operations such as registration and telemetry updates do not create Tasks. The [endpoint map](../api-endpoints.md) remains the complete route inventory; further SDK coverage follows the approved endpoints without inventing additional API families.

| SDK operation | Behavior | API mapping |
| --- | --- | --- |
| Register Asset | Create the Asset's Entity under [Asset registration](identity-and-access.md#asset-registration); other Reported data follows in the first check-in | `POST /entities` with type `asset` |
| Retire Asset | Operator withdraws participation under [Asset retirement](identity-and-access.md#asset-retirement) | Accepted operation; HTTP binding and SDK signature pending |
| Check in | Report current component data under [Check-in](asset-reporting.md#check-in) | `POST /entities/{entity_id}/checkin` |
| Update Asset components | Submit only changed fields under [partial component updates](asset-reporting.md#partial-component-updates) | `PATCH /entities/{entity_id}` |
| Report Asset status | Convenience operation for an [Operational status](asset-reporting.md#operational-status) report | `PATCH /entities/{entity_id}/status` |
| Read operational data | Resource reads, queries and feed subscriptions through [one read interface](#one-read-interface) | HTTP mode: resource endpoints, `/queries` and `/feed`. Full synchronization mode: local only |
| Read Command Catalog | Command definitions from the installed Protocol package under [the Command Catalog](tasks.md#commands-and-the-command-catalog) | Local; no HTTP request |
| Create Task | One execution of one Command on one Asset under [Task creation](tasks.md#task-creation), including when the Asset is offline | `POST /tasks` |
| Fetch assigned Tasks | Outstanding Tasks with submission and current queue order and confirmation state, following pagination, under [Reading the queue](tasks.md#reading-the-queue); same method in both modes | HTTP mode: `GET /entities/{entity_id}/tasks`. Full synchronization mode: local picture |
| Report Task lifecycle | Assigned-Asset execution reports under [Task status and transitions](tasks.md#task-status-and-transitions); returns Core's actual state | `PATCH /tasks/{task_id}/status` |
| Cancel Task | Request withdrawal under [cancellation requests](tasks.md#cancellation-requests) | `PATCH /tasks/{task_id}/status` |
| Reorder assigned Tasks | Submit a [queue revision](tasks.md#queue-revisions) | `PUT /entities/{entity_id}/task-order` |
| Report queue adoption | Confirm a revision or report a conflict under [Adoption and conflict](tasks.md#adoption-and-conflict) | `POST /entities/{entity_id}/task-order/confirm` |
| Upload Object content | Stream the whole file with a stable request identity under [Uploads](objects.md#uploads) | `POST /objects/upload`; no resume or offset API |
| Read movement history | Paginated samples for one Asset or Track and time range, under [Historical reads](#historical-reads) | `GET /entities/{entity_id}/movement-history` in every mode |
| Read activity history | Operator administrative clients query the action log, under [Historical reads](#historical-reads) | `GET /admin/activity` in every mode |
| Invoke Plugin Operation | Submit a declared capability under [Submission and retries](plugins.md#submission-and-retries) | `POST /plugins/{plugin_id}/operations` |
| Inspect or cancel Plugin Operation | Query progress and outcome or request cancellation under [Operations](plugins.md#operations) | Plugin Operation read, list and cancel endpoints; direct API access outside the picture |

Registration, check-in, component and status updates, Task lifecycle reports from the assigned Asset, required-result uploads and queue adoption reports are Asset-originated and go through the [Asset client](#asset-client). Gateway and Plugin limits follow the [caller permissions](identity-and-access.md#callers-and-permissions). Track observation updates, Geofeature geometry edits and Entity deletion use the ordinary Entity operations under [Entities, Tracks and Geofeatures](tracks-and-geofeatures.md).

## Source reference

The [source reference](../atlas-modernization-reference.md#earlier-sdk-design) records the earlier design and its pinned sources.

## Routes

- Synchronization: `GET /queries/full`, `GET /queries/changed-since` and `GET /feed` in the [Synchronization routes](../api-endpoints.md#synchronization), called by HTTP-mode operations or privately by the background synchronizer.
- Current-Dataset discovery and health remain available across a Dataset change under [Dataset lifecycle](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).
- Each catalog operation's route is listed in the [Operations catalog](#operations-catalog) and owned by its topic page.

## Open questions

- SDK constructor options and method names, including selecting the read mode, argument shapes, the Asset client's interface shape and whether registration offers a convenience option to perform the first check-in.
- Exact readiness, error and status shapes, the synchronization status API and freshness requirements for particular consumers.
- Detailed local query pagination, history limits, cursor encoding, subscription signatures and start boundaries, and initial-load and rebuild notification formats.
- Picture lifecycle and concrete resource limits for the full in-memory picture.
- Mutation-result and version envelopes, change notification details and any opt-in convergence-wait helper.
- How supported compatibility ranges and negotiated contracts are advertised and checked.
- Registration and credential encodings, listed with the [identity open questions](identity-and-access.md#open-questions).
- Report identity, ordering, relay-origin and disposition-mapping questions, listed with the [Asset reporting open questions](asset-reporting.md#open-questions).
- Task, queue, Pause and Resume and deadline fields, listed with the [Tasks open questions](tasks.md#open-questions).
- Upload identity and content-verification details, listed with the [Objects open questions](objects.md#open-questions).
- Radio transport, compact authenticated transport and gateway relay proof.

## Decisions

- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): the general SDK serves IP participants without bandwidth limits through HTTP mode and Full synchronization mode; Asset hybrid and its Core machinery are deferred.
- [ADR-0018](../adr/0018-confirm-writes-when-core-commits.md): writes are confirmed when Core commits, and write responses stay out of picture updates.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): the SDK detects a Dataset change and discards old state rather than replaying old writes.
- [ADR-0005](../adr/0005-allow-compatible-client-versions.md): compatible client versions within supported ranges.
- [ADR-0001](../adr/0001-release-core-sdk-and-protocol-together.md): Core, SDK and Protocol release together.
- [ADR-0011](../adr/0011-generate-shared-contracts-with-minimal-customization.md) and [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md): a TypeScript SDK on generated bindings, with helpers kept separate.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): the SDK maintains the Core-time offset estimate.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- SDK modes: identical read methods, HTTP passthrough, an IP-connected Asset using the Asset client in either mode, local query and feed behavior, referenced-resource updates reaching the full picture, and terminal Tasks after a rebuild.
- Synchronization: pagination during writes, feed and recovery handoff, expired cursors, slow consumers, write responses arriving before or after feed delivery, and Reset during reconciliation.
- Every public SDK operation: validation, partial-field behavior, errors, pagination, request identity and response mapping.
- Reset and Restart: old responses, submissions, retries and cursors rejected in every mode.

The [SDK and Core integration requirements](../testing-strategy.md#sdk-and-core-integration-requirements) require both modes to pass the real SDK and Core parity suite, including their different source and freshness rules and the absence of hidden HTTP read fallback. [Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds picture ordering through SDK reads, queries, subscriptions and status, the Asset client workflows, and measurement of full-picture loading, live delivery, recovery and resource use comparing both modes. [External systems and future radio gateways](../testing-strategy.md#external-systems-and-future-radio-gateways) covers gateways using the SDK.
