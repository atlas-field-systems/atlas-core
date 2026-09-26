# SDK data access

The SDK has three agreed read modes: HTTP, full synchronization, and Asset hybrid. They share the same application-facing operations; the selected mode determines their data source. This is a design document, not an implemented SDK interface. Exact method names and the detailed policies marked as proposals remain open.

## Agreed modes

| Mode | When application code requests data | Background work | Intended use |
| --- | --- | --- | --- |
| HTTP / direct | Resource reads, queries, and feed subscriptions pass through to Core's API; never use the local picture | No operational-picture synchronization; an explicit feed subscription connects to Core's feed | Simple integrations and occasional reads |
| Full synchronization | Reads and queries use the local picture; feed subscriptions observe applied local changes; no direct API pass-through | Initial load, live feed subscription, and recovery keep the picture updated | Interfaces and services that repeatedly read the same operational data |
| Asset hybrid | Related reads/queries use the local subset; out-of-scope reads use one-off API requests; feed observes only applied subset changes | Core-filtered initial load, feed, and recovery for the Asset and its Task dependencies | Assets on constrained links |

All three modes expose the same SDK resource-read, query, and feed-subscription methods, with shared arguments and resource/event shapes. HTTP operations use Core's API. Full-synchronization operations use only the local picture and its applied changes. Asset hybrid serves its synchronized subset locally and makes one-off API requests for reads outside that subset; its feed stays local to the subset. Applications do not use a second set of cache-specific read methods. All modes use the same Protocol resource definitions. Selecting synchronized-cache mode changes where operational reads are answered, not what an Entity or Task means. Command Catalog access remains local to the installed Protocol package in all modes and never needs a Core API request.

The mode defines the read-source boundary. HTTP failures do not fall back to cached data. In full-synchronization mode, a missing record, stale picture, incomplete coverage, or unavailable query must not trigger an HTTP resource read. There is no per-call cache bypass within full-synchronization mode. Asset hybrid's one-off API reads apply only outside its synchronized scope; an in-scope miss, stale data, or not-ready picture does not trigger fallback. Exact readiness/error responses remain to be designed.

Background synchronization is separate from application operations. The synchronizer privately uses Core's `/queries/full`, `/queries/changed-since`, and `/feed` to maintain the picture. Application-facing query and feed methods are available in all modes; full-synchronization queries/feed and hybrid in-scope queries/feed operate locally instead of exposing those remote connections. HTTP mode does not maintain or read an operational picture.

The benefit is shared state within an SDK instance. Multiple components reading the same Entity through that instance use the same maintained picture instead of making repeated HTTP requests. Separate processes or browser tabs do not automatically share memory or a feed connection. A shared service is outside the current design. The agreed full-synchronization mode keeps the full picture in memory without disk persistence or selective subscriptions. Asset hybrid instead synchronizes the agreed subset described below.

Recommend direct mode as the simple default and an explicit choice to start synchronization. The SDK should own subscription, recovery, and cache reconciliation so application code does not have to implement them.

## Resource reads, queries, and feed

All three are part of the SDK's read-operational-data interface. The selected mode controls the data source for each operation:

| Application operation | HTTP mode | Full synchronization | Asset hybrid |
| --- | --- | --- | --- |
| Resource read/list | Matching Core resource endpoint | Read/filter the local picture | Local within scope; one-off API read outside scope |
| Full operational query | `GET /queries/full` | Local full dataset | Local scoped dataset; an explicitly broader read uses the API |
| Changed-since query | `GET /queries/changed-since` | Locally retained picture changes | Local scoped history; separate out-of-scope API queries use Core cursors |
| Feed subscription | Core's `/feed` | Applied local picture changes | Applied local subset changes only; never expands the subscription |

For full synchronization and Asset hybrid, a feed event becomes visible to application subscribers after the corresponding change is applied locally. The SDK does not forward raw remote feed messages before reconciliation. Application subscriptions do not open their own Core feed connections. In HTTP mode, the feed operation is a remote API subscription; it does not construct or observe a local picture.

Local changed-since queries require locally retained change history, including deletions. A current-state cache alone cannot answer them. Retain a bounded local change history with configurable limits. When history no longer covers a cursor, return an explicit cursor-expired result; the application can request a fresh local snapshot. Local cursors belong to one SDK instance and picture generation, become invalid when that picture is rebuilt, and cannot be exchanged with Core cursors or another SDK instance. Exact limits, pagination, subscription start boundaries, and initial-load/rebuild notification formats are engineering details still to specify. Expired local cursors and missing local history report that limitation; they never trigger a direct query pass-through. Hybrid out-of-scope API queries are separate operations and must not reinterpret a local cursor as a Core cursor. The remote recovery cursor used by the background synchronizer must not be assumed interchangeable with an application query cursor.

## What is cached

Start with the synchronized resources already identified in the API map:

- Entities, including Assets, Tracks, and Geofeatures.
- Tasks and their latest execution state.
- Object metadata and associations.

Only ready Object metadata enters the picture; upload staging and progress remain separate. Object file content is downloaded separately. Plugin discovery/status and Operations, operator profiles, API keys and Core settings are outside this operational picture and use their supported API methods. Plugin management itself is local-only and has no SDK methods.

In full-synchronization mode, operational ID lookups and list/filter reads use only the local picture. If the local picture cannot answer, the SDK reports that limitation rather than querying HTTP. The exact supported query operations must be documented so callers know which reads can be answered locally. An incomplete or filtered picture must never be mistaken for the full dataset.

Full-synchronization mode maintains the full operational dataset in memory and rebuilds it on SDK restart. Disk persistence and arbitrary selective subscriptions remain outside this agreed full-synchronization mode. Asset hybrid has a defined narrower scope and does not change full-synchronization behavior. Use explicit resource limits and report when the full picture cannot be maintained; never silently discard resources and claim complete coverage. Bounded change-history retention is separate from retaining the current resource picture.

## Historical reads

Movement and activity history are explicit, on-demand SDK operations, outside read-operational-data and its Entity/Task/Object picture. The same historical methods call `GET /entities/{entity_id}/movement-history` and, for operator administrative clients, `GET /admin/activity` in all three modes. This is a declared separate API category, not a cache miss fallback or per-read bypass on synchronized resource methods.

History results never populate the live picture, emit its local feed events, or advance its recovery cursor. They do not start background synchronization of historical rows. History pagination uses Core cursors and Dataset identity, separate from local picture cursors. Reset invalidates old history requests/results. Local changed-since queries continue to mean bounded local change history, not movement or activity history. No history cache or offline-history promise is introduced.

## Asset hybrid mode

Asset hybrid is the agreed third mode, designed to reduce bandwidth on an Asset's link. It automatically synchronizes:

- The Asset's own Entity.
- Its outstanding Tasks and their outcomes as they occur.
- Task cancellation requests and queue-order changes, including confirmation state.
- Directly referenced Entities and Object metadata needed to execute those Tasks.

Reaffirmed on 23 September 2026: keep the maintained subset because Task dependencies can change while the Asset works. For example, when a Task depends on a Track, its relevant telemetry updates reach the Asset through the feed without repeated application polling or reissuing the Task. A one-time work document is not a substitute for this behavior. Future edge radio designs should preserve it through their transport translation; no new radio transport or delivery-latency guarantee is selected here.

File bytes remain explicit downloads. Unrelated Assets, Tasks, and Objects are not included in the background subscription. Exact dependency declarations and retention of completed Tasks remain to be specified; synchronization does not recursively subscribe to the entire relationship graph.

Hybrid scope limits bandwidth, not authorization. Every authenticated client may still request the full operational picture.

Core filters initial queries, recovery queries, and live feed delivery before transmission. Downloading everything and discarding unrelated records in the SDK would not meet the bandwidth goal. The scope applies consistently across loading and recovery, including resources entering and leaving the subset. A scope removal must not be confused with global deletion, and unrelated Core changes must not trigger false recovery gaps. Exact filter and cursor mechanics remain engineering details.

Reads within the synchronized scope use the local picture. Reads outside it make a one-off API request without expanding the background subscription. Those responses do not become local feed updates or imply ongoing synchronization of the fetched data. The local feed always describes only changes applied to the synchronized subset. Query results must make their coverage clear; a scoped snapshot must never appear to be the entire Core dataset.

In-scope reads retain the same readiness and freshness rules as full synchronization. An unready or stale local picture does not trigger fallback. One-off API failures remain API failures. Local cursors stay scoped to the SDK instance, picture generation, and subset; out-of-scope Core queries use separate Core cursors. Exact request/result scope metadata remains to be specified.

All writes still go to Core. Their effects enter the local picture only through synchronization when they belong in the synchronized scope; write responses neither update nor expand that scope. Asset hybrid adds neither disk persistence nor an offline-write queue.

## Keeping the picture current

The background synchronizer uses these remote endpoints internally. These calls maintain the picture; they are separate from the local query/feed operations exposed to applications in synchronized mode:

| Endpoint | SDK responsibility |
| --- | --- |
| `GET /queries/full` | Load all initial pages of operational data and retain the supplied baseline version |
| `GET /feed` | Subscribe to pushed create, update, and delete events |
| `GET /queries/changed-since` | Recover events missed during loading, disconnection, or a detected gap |

Proposed lifecycle, carrying forward the older feed contract:

1. Load every initial page. Keep the server's baseline version separate from the versions on individual resources; the paginated read is not a frozen snapshot.
2. Establish the feed subscription and wait for confirmation that it is active. Buffer live events during catch-up.
3. Drain changed-since from the baseline, then reconcile buffered events. Mark synchronization ready only after recovery covers the subscription boundary and the handoff is complete.
4. Apply pushed changes to local state. Repeated application reads use that state without triggering HTTP reads.
5. On a connection interruption or version gap, report degraded synchronization and recover from the last fully applied cursor. If the cursor has expired, rebuild from a full load and catch up again.

Full-synchronization mode loads the full operational resource set; Asset hybrid loads its defined subset. Application query filters do not expand either mode's background scope. If resource limits prevent a complete picture, expose the failure rather than presenting a partial load as ready.

## Core and SDK contract

This mode does couple Core and the SDK through a documented synchronization contract:

- Feed and recovery expose the same committed changes and version ordering.
- Events carry full resource data for creates and updates, and versioned deletion records for deletes. Object content is not sent through the feed.
- Applying an old response or duplicate event cannot overwrite a newer resource or resurrect a deleted one.
- A global recovery cursor advances only after all relevant changes through that boundary are applied. The version on a single resource or mutation response is not proof that unrelated changes have been consumed.
- Subscription acknowledgement closes the gap between fetching state and listening for future changes. The older protocol uses a subscription barrier with a version watermark.
- Recovery history has a defined retention limit and an explicit expired-cursor response. Overloaded clients reconnect and recover rather than silently dropping changes and claiming to be current.

Protocol describes event and resource shapes. Core owns committed state and the recovery log. The SDK owns the local projection, event ordering, connection recovery, and reporting synchronization state. These are public behavioral contracts rather than dependencies on private implementation details.

### Local operational picture ownership

Within the SDK, one local operational picture module owns the state that must agree: resource versions and deletions, coverage, applied recovery position, local history/cursors, picture generation, and readiness. Initial loading, feed delivery and replay recovery cooperate through that owner. Reads, queries and local subscriptions observe its reconciled state; individual SDK resource methods do not separately advance cursors or emit picture changes.

Full synchronization and Asset hybrid share these reconciliation rules while retaining their different coverage. HTTP mode does not construct a picture. HTTP reads and local picture reads are the two concrete adapters at the agreed read-source seam; this does not require a general cache-provider interface. Keep loading, buffering and history helpers private where useful. Depth comes from hiding their coordination, not from putting the entire implementation in one file.

For synchronized modes, rejecting obsolete Dataset inputs, invalidating rebuilt pictures and deduplicating notifications have locality in this module, giving reads and subscriptions leverage from one implementation. All modes still enforce the [Dataset Reset rules](#dataset-reset-boundary). The [write-confirmation rule](#writes) remains independent: a committed result can return while the picture is behind. Snapshot loading, feed delivery and replay recovery are the only picture data inputs; write responses do not participate. Interface shapes, cursor encoding, coverage messages and limits remain design work.

## Freshness and failures

The picture represents the latest state the SDK has successfully received. It is not guaranteed to contain a change committed to Core at the exact instant of a local read.

A cache expiry time is not the correctness mechanism for this mode. Versions and recovery establish which changes have been applied. Timers still have useful roles for connection liveness, reconnect backoff, and reporting how long synchronization has been interrupted. No fixed freshness or latency guarantee is established yet.

Proposed caller-visible status includes whether the SDK is initializing, synchronized, recovering, disconnected, or stopped, plus its last applied cursor, last successful synchronization time, and any current error. A timestamp alone is not proof that the cache matches Core.

The read-source, startup, and interruption behavior below is agreed. Exact error/status shapes remain to be specified:

- Before the initial picture is ready, report that it is not ready instead of treating an empty cache as an empty server dataset.
- During an interruption, retain the last known picture and expose its degraded status. Synchronized reads remain local; they do not request fresh data directly.
- A missing ID is a local not-found result only when the cache has the required coverage. Otherwise report that it cannot answer the lookup.
- No automatic fallback or per-read HTTP bypass is allowed in full-synchronization mode. Full-synchronization clients use HTTP mode for API reads. Asset hybrid makes API requests only for reads outside its synchronized scope.

The SDK feed-subscription method lets synchronized-mode consumers observe applied picture changes without polling or opening a direct remote subscription. HTTP mode exposes the remote feed through that same method. Exact subscription signatures, start boundaries, and synchronization status exposure remain to be specified.

## Writes

All three modes use the same methods to submit creates, updates, deletes, and Task lifecycle changes to Core. The local picture is not a second authority and this design does not introduce offline mutation queues.

The [SDK operations catalog](sdk-operations.md) describes Asset self-registration through Entity creation, subsequent check-in, and partial component updates. Assets author their own reported state; command interfaces submit Tasks. Every accepted fresh Asset-originated Entity update or Task lifecycle report refreshes Core-recorded contact. Duplicates and historical backlog do not; delayed reports cannot overwrite newer component values. These source-report rules are distinct from SDK feed recovery, which still replays committed changes to rebuild the local picture. Core accepts and retains valid Tasks even when the assigned Asset is offline. The client must still reach Core to submit the request; this does not introduce an SDK offline-write queue.

All modes return Core's authoritative write result once Core confirms the commit and the SDK validates the response and Dataset, following [ADR-0018](adr/0018-confirm-writes-when-core-commits.md). Do not wait for the local picture to catch up. For example, a Task creation can return its accepted Task while a synchronized Task-list read still shows the older picture. Acceptance does not establish Asset receipt or execution. Report synchronization state separately; ordinary write success is not a local read-after-write guarantee.

The returned result is separate from local picture state. In full-synchronization or Asset hybrid mode, apply in-scope committed changes only through snapshot loading, feed delivery and replay recovery, under their ordering rules. A write response never changes picture reads, emits local feed notifications, appends local history or contributes a reconciliation input, even if it includes a newer resource. The caller may use the returned result separately from picture reads. Exact response envelopes remain Protocol work.

For example, if the picture has applied N and a successful write response for N+2 arrives before N+1, return the write result without waiting for N+1. The picture waits for synchronization to supply the relevant changes, applies N+1 before N+2 and emits each local change once. A single-resource response cannot stand in for other resources changed by the same commit. Version checks on synchronization inputs prevent stale overwrites and resurrection; a late write response cannot change the picture at all. Hybrid recovery uses Core's scoped continuation/barrier proof for excluded changes; it must not download out-of-scope resources or wait for every integer sequence to appear.

If synchronization is interrupted or replay expires, preserve the successful write result and recover or rebuild the picture under the ordinary synchronization rules. Keep its stale/not-ready status accurate, invalidate local cursors on rebuild and do not automatically resubmit an accepted mutation. A Dataset change follows the Reset rule below and cannot insert the old result into the new picture. Any separate opt-in helper for waiting until the picture reflects a commit remains engineering work; no such wait is part of ordinary write success.

Writes rejected by Core never appear as committed cache updates. HTTP mode returns Core's response without maintaining a local picture; hybrid out-of-scope writes retain their existing HTTP behavior.

Picture reconciliation and notification deduplication follow the agreed rule above; exact result/version envelopes remain to be specified. Asset status is synchronized as part of the Entity record. Assets use the same assigned-Task read method in all modes and execute their queued Tasks sequentially, oldest submission first by default, following confirmed reordering. Supported immediate Tasks are delivered independently of queued position, including while paused; independent actions do not change the queued path. Immediate Pause suspends current queued work. Core validates Task lifecycle reports but does not schedule execution from Asset status. Reading or caching a Task does not acknowledge or start it; the Asset reports those transitions explicitly. See [Asset status](asset-status.md) for the replacement design and open reconciliation decisions.

## Dataset Reset boundary

All three modes follow [ADR-0015](adr/0015-separate-start-stop-restart-and-reset.md#dataset-boundary). A Dataset identity is created on first initialization, survives Restart, and changes on Reset. It is separate from an SDK picture generation or Asset process identity.

Before accepting responses or retrying submissions, the SDK checks Dataset identity. After detecting Reset, discard the old picture, local history/cursors, pending submissions and obsolete upload identities and recovery handles. Reject late responses/events from the prior Dataset and never relabel an old write as a new submission. Full synchronization and Asset hybrid return to not-ready and load their respective scopes afresh; HTTP mode rediscovers the Dataset without constructing a local picture. This is background recovery, not an application-read fallback.

Core rejects old-dataset writes, Task reports, Operation submissions and obsolete upload identities/replay handles. Health, authentication and current-Dataset discovery remain available so clients can recover. A disconnection without a known Reset may retain a visibly stale picture; once Reset is known, that picture cannot be served as the current Dataset. Restart alone does not invalidate Dataset identity or promise active-mission continuity. Wire fields and the discovery binding remain implementation details.

## Integration and bandwidth requirements

All three modes must pass the real SDK–Core [integration and parity suite](testing-strategy.md), including their different request-routing and freshness behavior. Shared public method names do not imply identical network traffic. Full synchronization must not perform application-read HTTP fallback; hybrid must filter before transmission and measure subset/dependency/recovery traffic. Future radio gateways may translate operations compactly, but must preserve authenticated Asset ownership, retry identity and Dataset semantics. HTTP assumptions do not set the bandwidth budget of a future radio link.

## Protocol compatibility

Core, Assets and SDK clients may use different versions within declared supported compatibility ranges, following [ADR-0005](adr/0005-allow-compatible-client-versions.md). Unsupported versions fail explicitly; exact advertisement and negotiation fields remain open. Task creation also checks the target Asset's advertised Command support. Adding a compatible optional field need not force a simultaneous update. Command Catalog lookup stays local to the installed Protocol package and requires no catalog download.

## Open decisions

- Hybrid scope/dependency encoding, terminal-Task retention, scope-entry/removal events, and request/result coverage metadata.
- SDK constructor/options and method names for selecting the read mode.
- Exact readiness/error/status shapes and freshness requirements for particular consumers.
- Detailed local query pagination, history limits/cursor encoding, and local feed start/rebuild behavior.
- Cache lifecycle and concrete resource limits for the full in-memory picture.
- Mutation-result/version envelopes, change notification details, and synchronization status API.
- How supported compatibility ranges and negotiated contracts are advertised and checked.

## Earlier design reference

The locally available Atlas Modernization snapshot at `8edee4e2743fbf0f85c16dfe638d9222141cf279` already defines this synchronization approach. Its feed is the live path; changed-since is durable recovery. The new mode should reuse that contract where it fits rather than reproducing its private classes or inheriting every fallback default.

The older `AtlasClient` combined typed HTTP access with an optional sync engine. `sync: "all"` selected the full resource subscription, and `client.sync.start()` started synchronization. Covered point reads used the cache only while sync was running and healthy; otherwise they called Core. `{ fresh: true }` explicitly bypassed cache. Neither automatic fallback nor the per-call bypass is carried forward: the new SDK uses only the selected mode's read source. Local list/query behavior should be specified separately rather than inferred from point reads.

The old cache was held in memory per client instance, with no disk persistence. It exposed sync health, degradation, subscriptions, and a global last-applied version rather than a per-record expiry time. A configurable changed-since poll defaulted to 120 seconds as a reconciliation backstop and could be disabled with `pollIntervalMs: 0`; that interval is historical behavior, not a selected freshness limit for this design. The old SDK also had a separate bounded in-memory file-content cache, which does not imply that file bytes belong in the synchronized operational picture.

- [Change-feed behavior](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-change-feed/README.md).
- [Initial-load and recovery pagination](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/PAGINATION.md).
- [SDK](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/README.md).
- [Detailed SDK read and synchronization contract](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-sdk/README.md).
- [Client options and defaults](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/client.ts).
- [Sync engine and read fallback](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/sync-engine.ts).
