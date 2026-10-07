# SDK

This page owns the general Atlas SDK: who uses it and what stays Core's responsibility, HTTP mode and Full synchronization mode behind one read interface, the Local operational picture and its synchronization, recovery and resource limits, write results, Dataset Reset handling, historical reads, helpers, the Asset client, client compatibility, the deferred Asset hybrid mode and the SDK operations catalog.

The [delivered SDK foundation](../../Atlas%20SDK/README.md) provides generated transport, validation adapters and representative local Catalog lookup. Operational methods and the connection, query, synchronization and retry contracts below remain implementation specifications for [#65](https://github.com/atlas-field-systems/atlas-core/issues/65), [#71](https://github.com/atlas-field-systems/atlas-core/issues/71), [#77](https://github.com/atlas-field-systems/atlas-core/issues/77) and the client side of [#79](https://github.com/atlas-field-systems/atlas-core/issues/79). Core-side change publication and gap detection are mechanisms in the system design under [Change publication](../architecture/system-design.md#change-publication) and [Detectable synchronization gaps](../architecture/system-design.md#detectable-synchronization-gaps). Read permissions follow [Callers and permissions](identity-and-access.md#callers-and-permissions), and the Dataset boundary follows [Dataset lifecycle](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).

## Who uses the general SDK

Participants on IP links without bandwidth limits use the Atlas SDK to interact with Core: applications, Command Interfaces, Plugins, IP-connected Assets and radio gateways. A health-check client, Command Interface and data-processing Plugin use the same supported SDK, with behavior appropriate to their needs. The local CLI/TUI administers the installation through internal management interfaces and does not use the SDK or public API.

The boundary is bandwidth, not whether the participant is an Asset. An IP-connected Asset without bandwidth limits uses the general SDK like any other consumer, including the [Asset client](#asset-client) for its reports, and may use either mode; the extra traffic is acceptable on such links. Bandwidth-limited Assets do not run the general SDK: their execution and constrained transport belong to the Asset OS and a radio gateway, through which they reach Core.

The SDK is TypeScript only for now, so an IP-connected Asset's software either uses TypeScript or runs the SDK in a companion process. Another SDK language would be a separate decision.

### Bandwidth and gateways

The general SDK assumes adequate IP bandwidth between its consumers and Core, including a gateway running on a different host or network. A gateway usually runs separately from Core, may run on the Core machine and need not share Core's local network. Adequate IP bandwidth is a deployment assumption, not a measured capacity or throughput guarantee, and IP access does not require internet access when Core is locally reachable. Numeric capacity and latency still require measurement.

Gateways use HTTP mode or Full synchronization mode over their IP connection to Core, can obtain the full operational picture and select what crosses their radio link. No Core-side hybrid filtering is required. The constrained link is between the gateway and bandwidth-limited Assets; adequate gateway-to-Core bandwidth does not establish the capacity or behavior of that radio link. Gateway identity and relay limits follow [Radio gateways](identity-and-access.md#radio-gateways), and gateway translation of Asset reports follows the [relay rules](asset-reporting.md#report-authority-and-relay).

HTTP/OpenAPI remains the selected Core interface. A gateway uses the general SDK on its Core-facing IP link and separate radio software for Asset messages. Core trusts that authenticated gateway to translate and construct reports for its bound Assets under [ADR-0028](../adr/0028-trust-gateways-to-author-bound-asset-reports.md). Radio messages need not carry Core-format envelopes or originating Asset signatures. No radio packet format, compression algorithm, batching protocol or per-packet overhead guarantee is selected; radio delivery, including updates needed by a Command whose dependencies change during execution, remains future gateway work. Translation preserves the reported Asset's identity, process authority, execution evidence, retry identity and Dataset semantics, together with [caller authorization](identity-and-access.md#callers-and-permissions) and [revocation](identity-and-access.md#credential-revocation). Gateways are relay integrations in the current scope; their possible future taskability remains open.

Partial component updates, stable retry identities and bounded recovery remain because they preserve useful behavior without another read mode. A future deployment whose IP link is itself constrained may use a dedicated SDK or integration designed for it, without expanding this general SDK's scope.

## Supported entry point and Core responsibilities

External IP interaction with Core goes through the SDK, including Object upload and download. The SDK should make both basic API access and a maintained picture clear without duplicating endpoint definitions or requiring a second client library outside it.

Core remains responsible for authentication, authorization, Task transitions, Object readiness and committed-state consistency at its API boundary. The SDK is the supported client entry point, not a substitute for those server responsibilities.

Operational SDK methods own response-validation integration under [public wire conventions](../architecture/system-design.md#public-wire-conventions) and [mutation-outcome handling](#mutation-outcomes-and-retries). Slice 0 exposes configurable middleware for binding qualification; it does not select the future operational constructor or require consumers to manage that wiring themselves.

Protocol describes event and resource shapes. Core owns committed state and the recovery log. The SDK owns the local projection, event ordering, connection recovery and reporting synchronization state. These are public behavioral contracts rather than dependencies on private implementation details.

## Modes

The SDK has two modes. Every mode writes to Core.

| Mode | When application code requests data | Background work | Intended use |
| --- | --- | --- | --- |
| HTTP mode | Resource reads, queries and feed subscriptions pass through to Core's API; never use a local picture | No operational-picture synchronization; an explicit feed subscription connects to Core's feed | Simple integrations and occasional reads |
| Full synchronization mode | Reads and queries use the Local operational picture; feed subscriptions observe applied local changes; no direct API pass-through | Initial load, live feed subscription and recovery keep the picture updated | Interfaces and services that repeatedly read the same operational data |

Basic API access starts no synchronized replica. Applications that need a maintained shared picture opt into synchronization; an application's role does not select its mode automatically. HTTP mode is the default; starting Full synchronization mode requires an explicit constructor option. The mode is selected at configuration, not by each caller choosing separate API and picture surfaces.

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

The [query and status contract](#query-and-status-contract) defines readiness and errors.

### Data outside the picture

File bytes remain explicit downloads in both modes. Plugin discovery and status, Plugin Operations, Operator profiles and API keys are outside the operational picture and use their supported API methods in every mode. Historical reads follow [Historical reads](#historical-reads). Core configuration inspection and editing are [local-only](dataset-lifecycle.md#core-configuration), as is [Plugin management](plugins.md#local-administration); neither has SDK methods. Authenticated health and readiness remain remote operations. Command Catalog lookup is local to the installed Protocol package in both modes under [Commands and the Command Catalog](tasks.md#commands-and-the-command-catalog).

## Local operational picture

### Contents

The initial synchronized resource set is Entities (Assets, Tracks and Geofeatures), Tasks with their latest execution state, and Object metadata and associations. Operational status is synchronized as part of the Entity record. Only ready Object metadata enters the picture, under [ready-only visibility](objects.md#ready-only-visibility); upload staging and progress remain separate, and Object content is downloaded separately.

Full synchronization mode loads the full operational resource set. Application query filters do not narrow its background scope, and there are no selective subscriptions. The full picture retains unrelated resources and delivers coherent queue state and committed updates to resources that Tasks reference, such as a moving Track or edited Geofeature geometry.

The picture is held in memory without disk persistence and is rebuilt on SDK restart. An incomplete or filtered picture must never be mistaken for the full Dataset. The exact supported local query operations must be documented so callers know which reads can be answered locally.

### Picture ownership

Within the SDK, one Local operational picture module owns the state that must agree: resource versions and deletions, coverage, applied recovery position, local history and cursors, picture rebuild and readiness. Initial loading, feed delivery and replay recovery cooperate through that owner. Reads, queries and local subscriptions observe its reconciled state; individual SDK resource methods do not separately advance cursors or emit picture changes.

HTTP mode does not construct a picture. Keep loading, buffering and history helpers private where useful; depth comes from hiding their coordination, not from putting the entire implementation in one file.

Rejecting obsolete Dataset inputs, invalidating rebuilt pictures and deduplicating notifications have locality in this module, giving reads and subscriptions leverage from one implementation. Both modes still enforce [Dataset Reset handling](#dataset-reset-handling). Snapshot loading, feed delivery and replay recovery are the only picture data inputs; write responses do not participate under [Write results and the picture](#write-results-and-the-picture). The [synchronization wire and application boundary](#synchronization-wire-and-application-boundary) and [query and status contract](#query-and-status-contract) define these interfaces and limits.

### Applied-change journal

Keep one bounded in-memory journal of changes applied to the Local operational picture. Local changed-since queries and feed subscriptions consume this same journal, including deletions, instead of maintaining independent history and notification paths. The Local operational picture owner updates resource state and appends its accepted public changes before exposing them to local subscribers. Duplicate or obsolete synchronization input creates no second local change. Subscriber callbacks observe completed application rather than partially updated picture state.

Keep local journal position separate from Core's recovery position. A Core cursor advances only after all relevant changes through its boundary have been applied; a newer resource version or an initial-load page cannot advance it by itself. Rebuilding the Local operational picture invalidates its previous journal and local cursors. If pruning overtakes a local cursor or a slow subscriber, report the gap explicitly rather than silently omitting changes. Write responses never enter the journal. Commit grouping and subscription boundaries follow the [wire contract](#synchronization-wire-and-application-boundary) and [local subscription contract](#local-subscriptions-and-rebuilds).

### Background synchronization

Background synchronization is separate from application operations. The synchronizer privately uses these endpoints to maintain the picture; application query and feed calls in Full synchronization mode resolve locally instead of exposing these remote connections.

| Endpoint | SDK responsibility |
| --- | --- |
| `GET /queries/full` | Load all initial pages of operational data and retain the supplied baseline version |
| `GET /feed` | Subscribe to pushed create, update and delete events |
| `GET /queries/changed-since` | Recover events missed during loading, disconnection or a detected gap |

Finish the initial paginated load, then recover changes since its baseline before treating the picture as current. The paginated read is not a frozen snapshot: keep its baseline stable across pages and separate from the versions on individual resources. Subscription acknowledgement and its continuation boundary close the handoff to live delivery. On feed reconnect or a version gap, recover through changed-since. If retained history no longer covers the requested version, Core returns an explicit cursor-expired response and the SDK makes a new initial load.

Synchronization lifecycle:

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

The [status contract](#query-and-status-contract) exposes initialization, synchronization, recovery, disconnection and stopped states. A timestamp alone is not proof that the picture matches Core.

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

The returned result is separate from picture state. In Full synchronization mode, committed changes reach the picture only through snapshot loading, feed delivery and replay recovery, under their ordering rules. A write response never changes picture reads, emits local feed notifications, appends local history, advances a picture cursor or contributes a reconciliation input, even if it includes a newer resource. The caller may use the returned result separately from picture reads. Responses use the [shared Protocol envelope](../architecture/system-design.md#public-wire-conventions).

For example, if the picture has applied N and a successful write response for N+2 arrives before N+1, return the write result without waiting for N+1. The picture waits for synchronization to supply the relevant changes, applies N+1 before N+2 and emits each local change once. A single-resource response cannot stand in for other resources changed by the same commit. Version checks on synchronization inputs prevent stale overwrites and resurrection; a late write response cannot change the picture at all.

If synchronization is interrupted or replay expires after a successful write, preserve the write result and recover or rebuild the picture under the ordinary synchronization rules. Keep its stale or not-ready status accurate, invalidate local cursors on rebuild and do not automatically resubmit an accepted mutation. A Dataset change follows [Dataset Reset handling](#dataset-reset-handling) and cannot insert the old result into the new picture. There is no convergence-wait helper in the initial SDK. Callers can observe synchronization status and the ordinary local feed separately.

## Dataset Reset handling

Both modes follow Core's [Dataset boundary](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary): Dataset identity survives Restart and changes on Reset. It is separate from a picture rebuild and from Asset process identity.

Before accepting responses or retrying submissions, the SDK checks Dataset identity. After detecting Reset, it discards the old picture, local history and cursors, pending submissions, obsolete upload identities and recovery handles. It rejects late responses and events from the prior Dataset and never relabels an old write as a new submission. Full synchronization mode returns to not-ready and loads the full picture afresh; HTTP mode rediscovers the Dataset without constructing a local picture. This is background recovery, not an application-read fallback.

A disconnection without a known Reset may retain a visibly stale picture; once Reset is known, that picture cannot be served as the current Dataset. Wire fields and discovery follow [connection setup](#connection-setup) and the [Dataset wire boundary](dataset-lifecycle.md#dataset-wire-boundary).

## Connection setup

The SDK constructor takes `base_url`, a caller-supplied credential provider, `mode` with `http` as default or `full`, request timeout and synchronization limits. Node consumers may supply a trusted CA bundle through their HTTPS/WebSocket transport; browser consumers use browser/OS trust. The [offline TLS setup](dataset-lifecycle.md#offline-tls-and-first-time-setup) establishes the HTTPS/WSS address and authorization. No option disables certificate or hostname verification. Credentials stay out of URLs, query cursors and picture state.

An authenticated `GET /health` needs no Dataset precondition. It advertises `dataset_id`, `core_release`, an explicit `supported_protocol_versions` list, Core time and current health facts. Each SDK release declares the Protocol editions it implements. The SDK selects the highest common released SemVer, sends `Atlas-Protocol-Version` on HTTP requests and records the selected edition for feed authentication. No common edition produces `protocol_unsupported` before operational requests; it does not retry with guessed schemas. The response edition must match the request. A release must publish and test its supported editions; matching a major number alone does not establish compatibility.

After discovery, operational requests carry `Atlas-Dataset-ID`. The SDK checks the response Dataset and selected Protocol edition before accepting data or success. Invalid response encoding produces `protocol_error` for reads and `unknown_outcome` for a mutation that might have reached Core. A valid obsolete-Dataset response produces `dataset_invalidated`. Discovery, health and authentication remain possible after Reset.

`/feed` remains a WebSocket, using `wss` at the same trusted origin. Before sending data, Core requires the first client message `authenticate` with `credential`, `dataset_id` and `protocol_version`, even when a nonbrowser client also supplied HTTP credentials. Core authenticates within five seconds, then returns `hello`; it never includes the credential in an acknowledgement. An unauthenticated or rejected socket carries no operational events. Credential revocation ends event authorization at commit, including buffered frames, and closes the socket. Auth failure stops reconnect until the caller supplies replacement credentials. Node reports certificate trust, hostname and expiry failures as safe connection errors. A browser can expose only an opaque `secure_connection_failed`; the SDK preserves that uncertainty and local setup tools diagnose the certificate. Retries do not switch to plaintext or relax trust. Transport loss alone uses bounded reconnect backoff of 250 ms doubling to 10 s with jitter, cancelled on SDK stop.

The Asset client uses the authenticated health exchange to estimate Core time and obtain contact evidence under the [report contract](asset-reporting.md#shared-report-context). A clock or contact challenge is not Task execution evidence or process-transfer authorization. Gateway requests can obtain it only for their bound Assets.

## Synchronization wire and application boundary

Protocol defines these shared structures once. The [publication mechanism](../architecture/system-design.md#change-publication) produces them; the SDK owns their application.

| Structure | Fields and meaning |
| --- | --- |
| Core recovery cursor | Opaque token binding `dataset_id` and a fully committed public-change sequence. Internal sequence numbers are decimal strings, never JSON floating-point counters. A cursor represents all changes through that commit, including deletions |
| Resource change | `dataset_id`, decimal-string `commit_id`, zero-based `change_index`, `change_count`, `resource_kind`, `resource_id`, `resource_version`, `action` of `upsert` or `delete`; `resource` contains the full final public image only for `upsert` |
| Replay page | `changes`, fixed `replay_through`, `applied_through` for the last whole commit in the page, and optional `next_page`. `next_page` is a paging handle, not applied progress |
| Initial-load page | Resources with their versions, one stable `baseline_cursor`, per-kind continuation and the page's observed boundary. Initial pages may observe later state; baseline does not advance with them |
| Feed messages | `hello` states Dataset and selected Protocol; `subscribe` requests the complete Entities/Tasks/ready-Objects feed; `subscribed` confirms the fixed recovery `boundary_cursor`; `change` carries a resource change; `gap` carries reason and last recoverable boundary |

A commit allocates one public-change sequence and emits at most one final image or deletion for each affected resource. An Asset report changing its Entity and Task therefore carries two changes with one commit identity. Resource versions increase on each change, including deletion, and survive Restart. Feed order is commit order and then `change_index`. A replay request starts strictly after its supplied complete cursor and fixes its inclusive upper boundary before reading the first page. Later commits belong to a later replay. Paging handles bind Dataset, original bounds and position; changing options with the handle is `cursor_invalid`.

Replay may split a commit across pages. Stage its fragments privately until every index through `change_count - 1` has arrived and validated. Only then expose all effective resource updates atomically, append one local journal batch and advance the Core cursor. A page continuation never authorizes progress over an incomplete commit. Duplicate equal fragments do nothing; conflicting fragments are a protocol error. A later commit arriving first waits within the bounded buffer while the synchronizer replays from its last complete cursor. It cannot fill a gap with a newer resource or write response.

Initial load uses ID keyset pages with a baseline captured before page one. Stage resources and versioned deletion markers privately. After loading every resource kind, subscribe and capture boundary H, buffer live commits greater than H, and replay every change from the baseline through H. Apply each replay image only if newer than the staged image or tombstone, but account for the entire commit before advancing recovery. This reconstructs coverage without calling the moving pages a frozen snapshot. Then drain complete buffered commits in order and atomically publish the ready picture. A create behind a page's keyset arrives in replay; a deletion after a loaded page removes the staged resource. A tombstone prevents a delayed older page or event resurrecting it. No staged state is readable as a ready Dataset.

The subscribe operation registers delivery and captures H under the same ordered publication boundary. Events strictly after H are queued for that subscription. The acknowledgement supplies H so replay closes the load-to-live gap. If disconnection loses the acknowledgement, discard that connection's buffer and subscribe/replay again from the last complete boundary. If the baseline or a replay handle expires during loading, discard the staged picture and start again. Reset invalidates the whole load rather than relabelling its pages.

Initial synchronization defaults bound the encoded picture payload to 512 MiB and 100,000 resources, inbound fragments to 4 MiB or 1,000 records, local history to 16 MiB or 10,000 commit batches, and a single commit to 4 MiB or 1,000 changes. Limits are configurable downward or upward within deployment-tested ranges. These are engineering starting values, not measured RAM or capacity promises; runtime object overhead must also be measured. Exhausting picture capacity yields `resource_limit` and incomplete coverage. Exhausting the inbound buffer closes the feed and recovers from the last complete cursor. No eviction of current resources is permitted to preserve a false ready state. Core keeps at most 4 MiB pending delivery per synchronization connection. Overflow emits a gap and closes the WebSocket with code 1013; if no gap frame can be sent, that closure still requires replay from the last complete boundary. Core replay retention is bounded by [Core configuration](dataset-lifecycle.md#core-configuration); expired replay returns `410 cursor_expired`. Local history prunes whole batches only.

### Worked synchronization interleaving

This fixture fixes expected outcomes independently of an implementation. A is an Asset, T its Task and X an unrelated Track; the baseline is Core commit 40. Core commits 41 with A/T changes, 42 deleting X and 43 creating U.

| Input or barrier | Expected staged or visible state | Safe Core cursor and local notification |
| --- | --- | --- |
| Initial pages load A at 40 and X at 40; a later page observes T at 41 | Private staging; application reads `picture_not_ready` | Baseline stays 40; no resource notifications |
| Subscribe acknowledges H=42; commit 43 is buffered | Staging only | Replay fixed through 42; 43 cannot advance progress |
| Replay page one has only A, index 0 of commit 41, count 2 | A/T commit remains private and incomplete | Complete cursor stays 40; `next_page` is not a recovery cursor |
| A successful write response for commit 43 arrives | Caller receives U; staging and picture are unchanged | No journal or notification from the response |
| Replay page two has T, index 1 of 41, then delete X at 42 | Finish 41 without overwriting newer T; delete X; load/replay coverage reaches H | Cursor 42; no partial initial notifications |
| Buffered 43 is applied and picture is published | A/T reflect 41, X absent, U present | Cursor 43; one `ready` notification and fresh local cursor at journal position 0 |
| Duplicate 41 and an old page containing X arrive | No stale overwrite or resurrection | Cursor 43; no second journal batch |
| Live 44 updates A/T, split across frames | Both remain at 41 until second frame; then both become 44 | One local batch and cursor 44 after whole application |
| Feed is lost, 45 deletes U, and reconnection replays 45 twice | U absent after one complete application | One deletion notification; cursor 45 |
| Replay is expired or Dataset changes | Invalidate cursors and notify rebuild/Reset; retain no readable old-Dataset picture | New initial load; no accepted mutation is resubmitted |

## Query and status contract

The shared operational methods are resource `get(id)` and `list(query)`, assigned-Task list, full-picture query, changed-since query and feed subscription. Each returns data plus its source boundary and synchronization facts, using one argument/result contract in both modes. The exact resource methods follow the [operations catalog](#operations-catalog); there is no second cache API.

Lists support `ids`, Entity `type`, Task `asset_id`, `status` and `scheduling`, and ready-Object `entity_id`/`task_id` associations. Supplied filters combine with AND; a list of values within one filter combines with OR. An absent filter imposes no restriction; an empty value list matches nothing; null filters and unknown filter names fail validation. There is no implicit substring, spatial, locale or full-text filter. `alias` is an optional exact value filter using the same case-insensitive comparison as [Alias uniqueness and resolution](tracks-and-geofeatures.md#aliases); `alias_is_set=false` selects Entities without an alias. Stored absent optional properties stay absent in results and stored null stays null where its schema allows it.

Ordinary resource lists order by permanent resource ID ascending, compared by UTF-8 bytes; IDs break every tie. Alias is a filter, not an unstable sort key. Page size defaults to 100 with a maximum of 1,000. The returned opaque paging token binds source kind, Dataset, resource kind, filters, page size and last ID. In Full synchronization mode it also binds SDK instance and picture generation. Reads between pages may observe new state, so a record created or newly matching behind the keyset can be absent from that traversal; a matching record after the keyset can appear. Pages expose the observed boundary. A complete coherent picture requires the full-query/replay contract above; an ordinary list traversal is not a frozen snapshot. Deletions do not cause duplicates because the last ID boundary does not change.

Assigned-Task pages order Immediate Tasks by immutable submission sequence, then Queued Tasks by requested queue order, with submission sequence and ID as tie-breakers. They include requested and confirmed revisions and the state supplied by the [queue contract](tasks.md#queue-revisions). Every page token pins that Asset's queue revision. If that queue changes between pages, both sources return `409 page_changed` and the caller restarts the list; telemetry for unrelated resources does not invalidate it. No traversal combines old requested order with new confirmed order. Started/suspended work remains identified separately from editable unstarted order.

A malformed token, wrong query/options/source or another SDK instance's token yields `cursor_invalid`. A pruned Core/local history cursor or an elapsed 60-second ordinary page-token lifetime yields `cursor_expired`. Restart preserves unexpired Core tokens and retained replay; SDK restart or picture rebuild invalidates local tokens. Reset produces `dataset_invalidated` for every old-Dataset token. Application reads cannot use Core recovery cursors as local query cursors.

The SDK exposes `state`, `dataset_id`, `picture_generation`, `coverage`, `last_applied_core_cursor`, `last_synchronized_at` and optional safe `error`. `state` is `initializing`, `synchronized`, `recovering`, `disconnected`, `resource_limited`, `authorization_required` or `stopped`; coverage is `none` or `complete`. HTTP results have `source=http` and the response's Core boundary. Full-mode results have `source=local`, their local journal boundary and current status. A ready empty Dataset returns an empty list, while incomplete coverage returns `picture_not_ready`. During same-Dataset disconnection/recovery, complete last-known coverage remains readable with stale status. Knowing Reset or a required rebuild makes reads not ready immediately. A not-found answer is permitted only with complete coverage. Unsupported local filters fail validation locally, producing zero operational HTTP read requests.

### Local subscriptions and rebuilds

One local journal position represents one wholly applied commit batch. Its opaque cursor binds Dataset, SDK instance, picture generation and position. `changed-since` fixes the current journal upper boundary on its first page, returns ordered whole batches and never includes a write response. Core recovery cursors stay private to background synchronization.

Subscription without a cursor atomically captures the current local boundary and registers for batches after it. It first emits status plus that boundary, not an enumeration of existing resources. Subscription with a valid local cursor replays strictly later retained batches, registers at the captured upper boundary and then continues live without duplicate delivery. Subscriber callbacks run after every resource in a batch has become visible. A slow subscriber overtaken by pruning receives `gap`, stops data delivery and must obtain a local full query before subscribing with its new cursor.

A subscription opened while initializing receives status only. On first readiness it receives `ready` with the new picture generation and local boundary; the consumer loads current state rather than interpreting it as a stream of individual creates. A rebuild sends `rebuilding`, invalidates previous cursors and emits no partial resources. Existing subscriptions remain attached to status and receive `ready` for the replacement picture, then subsequent complete batches. A cursor-based subscription cannot silently replay across that boundary. Reset sends `dataset_changed` with the new Dataset and follows the same not-ready/ready procedure.

HTTP-mode subscriptions use the same whole-commit batch/status/gap event shapes. The HTTP adapter groups remote fragments before notifying the caller, but constructs no operational picture. With no cursor it starts strictly after its subscribed Core boundary; with a valid Core cursor it replays through that fixed boundary and then delivers live changes once. Its paging/history cursors are Core cursors. Full-mode subscriptions use local cursors instead, and their readiness/rebuild statuses concern the picture. The event envelope states the source and boundary so these cursors cannot be exchanged accidentally.

### Independent query fixtures

Use equal permitted filter values on different resources and immutable IDs a, b, c. At boundary 50, a and b match the same permitted filter, c does not; a has an absent optional value and b an allowed null.

| Scenario | Expected HTTP/full-mode answer at matched boundary | Additional source assertion |
| --- | --- | --- |
| First page, size 1, equal non-sort values | a, then b by ID; absence and null preserved | Full mode issues no resource/query HTTP read |
| Delete b and make c match before page two | Page two contains c and does not resurrect b; its boundary is newer | Local traversal changes only after committed synchronization |
| Create matching ID before a between pages | It is absent from that moving traversal; next full/replay includes it | Never claim the ordinary traversal is a frozen snapshot |
| Empty `ids`, ready picture, then initializing picture | Ready returns []; initializing returns `picture_not_ready` | No empty-cache success or hidden fallback |
| Queue revision changes between assigned-Task pages | `page_changed`; a new traversal uses one revision | Unrelated telemetry alone does not cause this error |
| Journal retains local 10..12; query/subscription starts after 10 | Both return batches 11 and 12 once, then subscriber receives 13 | Write responses contribute no batch |
| Subscribe during rebuild; reuse old cursor afterward | Status/rebuilding then ready; old cursor is invalid | Zero partial-state notifications |
| Expire/prune cursor or Reset between pages | Explicit expired or Dataset-invalidated error | No skipped page, old result or implicit remote repair |

## Mutation outcomes and retries

A prepared submission contains the original Dataset, operation kind, stable request identity, original facts and any original edit/queue precondition. Operation submission uses `request_id`; other operations keep their domain-specific identity fields. An error envelope's diagnostic `request_id` is transport correlation, not a new mutation identity. The SDK returns this descriptor before first transmission so a caller or Asset OS can retain it. The SDK retains it in memory while the request is unresolved; SDK restart requires the caller-supplied descriptor. Retention of credential secrets uses secure caller storage, never picture state. Preparing a new descriptor is a deliberate new action, not recovery from a lost response.

| Caller outcome | Evidence and behavior |
| --- | --- |
| `accepted` | Validated same-Dataset Core success confirms commit; return data immediately without awaiting or modifying the picture |
| `rejected` | Validated Core error explicitly refuses this request. Preserve its stable code, original descriptor and any original precondition. A conflict does not authorize changing facts or refreshing the base automatically |
| `unknown_outcome` | Timeout, local request abort after transmission may have begun, connection loss, malformed body or invalid success envelope can hide a commit. Return the descriptor and any validated nonsecret resource identity; never claim no effect |
| `dataset_invalidated` | Reset is known or a valid obsolete-Dataset rejection arrives. Stop old retries and reject late results; do not infer whether an old write committed before Reset |

Local validation or cancellation before transmission reports `not_submitted`; it creates no claim about a server response. Caller timeout settles that call as unknown. A later validated success may update the in-memory descriptor's separately observable resolution to accepted, but does not settle the already-returned call a second time, generate picture input or replay it. If the Dataset changed, the late response is discarded. An authoritative authorization failure requires replacement credentials; it does not reveal whether a prior lost-response request committed.

| Operation | Identity, original facts and safe recovery |
| --- | --- |
| Task creation | Dataset + creation identity; immutable Asset/Command/input/scheduling facts. Retry exact descriptor to recover the original Task; a known Task ID can be read. A new identity deliberately creates new physical work |
| Asset registration | Dataset + registration identity and stable Asset ID; original permitted initial facts. Asset OS retains identity across process restart. Matching retry returns original registration; deleted-result does not recreate it |
| Asset retirement | Dataset + retirement identity, target and parameters. Retry returns recorded retirement or deleted-result; fresh identity on an already-retired Asset is a separate rejected action |
| Object upload | Dataset + upload identity, Object ID, original metadata and verified content facts. Retry whole content from byte zero with the same descriptor; successful/deleted-result replay never republishes |
| Plugin Operation submission | Dataset + submission identity, Plugin installation/release/capability/input version and input. Retry returns the original Operation, including Interrupted; rerun requires a new identity |
| Queue edit | Dataset + edit identity, Asset, reviewed queue revision and ordered IDs. Exact retry recovers adoption request; conflict requires caller review and a deliberate new edit |
| Task/Operation cancellation | Dataset + cancellation identity and target. Retry the same cancellation intent; preserve confirmed final state and create no duplicate attributed action |
| API-key creation | Installation + administrative principal + creation/key identity; prepared secret and initial metadata. Use the retained secret and identity over authenticated TLS. Reset retains claim but rejects old-Dataset requests; deliberate current-Dataset reconciliation must preserve original facts. Revoked result cannot reactivate the key |

The initial SDK does not automatically retry mutations. Read retries and synchronization reconnection are separate and bounded. Whole-file retry helpers require the original descriptor and caller consent for that retry policy; they cannot allocate a replacement Object or upload identity. Exact matching mutation retries go through Core's existing authorization and retry mechanism; a read/list not finding a resource is not proof that a lost request never committed. Descriptive patches preserve their original `If-Match`; without a stable replay claim, reread for review instead of repeating them with a refreshed base.

### Independent mutation fixtures

| Input sequence | Expected caller result and server effect |
| --- | --- |
| Task commits; response lost; caller retries retained descriptor | First call unknown; retry returns the same Task; one creation and one action |
| Core commits; success body is malformed | Unknown outcome, not rejected; exact retry resolves it |
| Same identity with changed input | Explicit retry conflict; no second Task/Operation |
| Caller aborts after transmission; late success arrives | Call remains settled unknown; descriptor resolution can become accepted; no picture mutation |
| Valid Task success while picture is at an earlier boundary | Accepted Task returned immediately; local read stays old until synchronization |
| Unknown old-Dataset submission followed by Reset | Descriptor invalidated; no relabelled new submission; late old result rejected |
| Retry with revoked authority | Authorization failure; no replacement request/secret; original effect may still exist |
| Operator explicitly reruns interrupted work | New identity creates a distinct Operation/Task according to its ordinary contract |

## Historical reads

Movement and activity history are explicit, on-demand SDK operations outside the read-operational-data interface and its Entity, Task and Object picture. The same historical methods call `GET /entities/{entity_id}/movement-history` and, for operator administrative clients, `GET /admin/activity` in both modes. This is a declared separate API category, not a cache-miss fallback or per-read bypass on synchronized resource methods.

History results never populate the live picture, emit its local feed events or advance its recovery cursor, and they do not start background synchronization of historical rows. History pagination uses Core cursors and Dataset identity, separate from local picture cursors. Reset invalidates old history requests and results. Local changed-since queries mean bounded local change history, not movement or activity history. No history cache or offline-history promise is introduced. What history Core records and returns follows [Activity and movement history](history.md).

## Helpers

Keep the Core API small and explicit. The SDK owns client-side conveniences such as whole-file upload retries, pagination, submission retry identity and waiting for Operation outcomes. These helpers compose supported API operations and live separately from generated bindings; they do not duplicate endpoint contracts or patch generated code. Add helpers for actual consumer workflows, not a general workflow engine.

The SDK exposes typed methods and documentation for its operations. No machine-readable SDK-operation discovery function is planned without a concrete consumer.

Topic-specific helper rules:

- Task lifecycle helpers, Pause and Resume, assigned-work reads, queue operations and recovery follow [Tasks](tasks.md#routes-and-sdk-operations). Helpers return Core's recorded Task state under [scan completion](tasks.md#scan-completion), independently of separate result declarations and uploads. Route-level Task status helpers remain for tasking clients, such as an operator requesting cancellation.
- Upload retries, deleted-result retries and protected deletion helpers follow [Objects](objects.md#routes-and-sdk-operations).
- Operation submission identity, retries, outcome queries and cancellation follow [Plugins](plugins.md#routes-and-sdk-operations).
- The SDK preserves an edit's original version precondition under [Concurrent descriptive edits](../architecture/system-design.md#concurrent-descriptive-edits).

## Asset client

The Asset client is the SDK module that owns all Core-facing traffic originating from an Asset, for IP-connected Assets, radio gateways and simulated-Asset test fixtures. Bandwidth-limited Assets do not run it; their gateway does. It covers registration and Enrollment, check-in, component and status reports, Task lifecycle reports, required-result uploads, queue adoption and conflict reports, and reading assigned work. It is the SDK side of [shared Asset report acceptance](../architecture/system-design.md#shared-asset-report-acceptance), with HTTP as its Core-facing transport adapter. SDK consumers submitting Asset-originated reports use the Asset client, which owns their coordination.

The Asset client owns:

- First registration before a normal Asset credential exists, under enrollment authorization, with its retry identity, and re-registration after Reset, under [Asset registration](identity-and-access.md#asset-registration) and [Enrollment](identity-and-access.md#enrollment).
- Required-result uploads: it preallocates the result Object ID under [Object IDs before upload](objects.md#object-ids-before-upload), uses it in the separate result declaration and delegates the whole-file upload to the existing upload operation, retaining its request identity. No upload reservation route is added; result declarations use their separate Task operation.
- Report identity and ordering, and the Core-issued process generation, matching [Asset report acceptance](asset-reporting.md#asset-report-acceptance) in Core.
- Pause and Resume report correlation and queue revision adoption under [Tasks](tasks.md#pause-and-resume).
- Lost-response retries with stable identities, and discarding obsolete work and submissions when the Dataset changes before re-registering in the new Dataset.
- [Reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation).
- Delivery of committed updates that running Commands depend on, such as [live Geofeature geometry](tracks-and-geofeatures.md#live-geometry-for-existing-tasks), to execution; a gateway does this for its bound Assets.

After an Asset process restart, the Asset OS supplies its onboard execution evidence to the Asset client, which follows [recovery](tasks.md#recovery-after-an-unexpected-asset-restart): it obtains a new process generation, reports what that evidence establishes and keeps uncertain work out of its assigned-work stream until explicit recovery. It never schedules, starts or reruns work; the Asset OS owns scheduling and execution.

The SDK keeps no disk persistence. State that must survive a process restart, such as a pending registration identity, is prepared by the Asset client and handed to the Asset OS or deployment layer to retain before submission, following the [API-key creation](identity-and-access.md#api-keys) pattern.

The Asset client does not implement the Asset OS or a radio protocol. Radio delivery, evidence translation and the concrete gateway authority contract remain future work within the accepted [trusted relay boundary](asset-reporting.md#report-authority-and-relay). A gateway uses its own authenticated identity to submit reports only for its bound Assets. Its restart does not establish an Asset-process restart. The Asset client composes the [report wire contract](asset-reporting.md#shared-report-context) and the operations listed below; it adds no execution scheduler.

### Asset startup

The steps below specify direct IP Asset startup. A radio gateway constructs Core-facing reports from its bound Asset's radio evidence under [trusted relay](asset-reporting.md#report-authority-and-relay); its radio-side enrollment and process-authority messages remain engineering work and need not reproduce these signature envelopes.

1. The Asset client invokes registration with information supplied by the Asset OS or gateway. The SDK uses ordinary Entity creation, not a dedicated registration endpoint.
2. [Enrollment](identity-and-access.md#enrollment) automatically binds an authenticated Asset identity, and Core validates the supplied initial data and creates the Asset with its [initial reporting values](asset-reporting.md#components-and-initial-values).
3. The Asset client obtains Core-time/contact evidence through authenticated health. If it must establish process authority, it requests the challenge for candidate generation `expected_generation + 1`; otherwise it requests its current generation's challenge. Health establishes neither process authority nor Task execution.
4. The Asset sends signed [check-in](asset-reporting.md#check-in) with its Reported data, such as Operational status and position. When establishing authority, this first report also carries the retained `authority_claim` under [process establishment and replacement](asset-reporting.md#process-authority-establishment-and-replacement). Core establishes the generation and accepts the report atomically through that existing route.
5. The Asset sends further reports as needed, containing only changed fields if it chooses. [Contact and freshness](asset-reporting.md#contact-and-freshness) defines which reports refresh Contact.

Registration content, stable Asset IDs and retries follow [Asset registration](identity-and-access.md#asset-registration). Check-in, component updates and status reports follow [Asset reporting](asset-reporting.md), including [partial component updates](asset-reporting.md#partial-component-updates) and [report authority and relay](asset-reporting.md#report-authority-and-relay).

## Compatibility

Core, Assets and SDK clients may use different versions within declared supported compatibility ranges under [ADR-0005](../adr/0005-allow-compatible-client-versions.md). Unsupported versions fail explicitly. Adding a compatible optional field need not force a simultaneous update. Task creation also checks the target Asset's advertised [Command support](tasks.md#command-support), and Command Catalog lookup follows [Commands and the Command Catalog](tasks.md#commands-and-the-command-catalog). The SDK, including the Asset client, maintains the Core-time offset estimate and exposes its uncertainty where a rule depends on it, under [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md). Negotiation uses [connection setup](#connection-setup); Plugin capabilities use their own [declared schemas](plugins.md#installation-manifest-and-capability-schemas).

## Deferred: Asset hybrid mode

Asset hybrid mode and Core's matching Asset-scoped snapshots, feed, replay, dependency membership and scope-continuation contract are deferred under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md). This deferral does not change Core's Task retention, Required-result protection, Asset report authority, retries, reconnect reconciliation or the remaining picture guarantees.

## Operations catalog

The catalog lists the approved SDK workflows and their API mappings. The names describe behavior, not final method names. It is separate from the Protocol Command Catalog: SDK operations such as registration and telemetry updates do not create Tasks. The [endpoint map](../api-endpoints.md) remains the complete route inventory; further SDK coverage follows the approved endpoints without inventing additional API families.

| SDK operation | Behavior | API mapping |
| --- | --- | --- |
| Register Asset | Create the Asset's Entity under [Asset registration](identity-and-access.md#asset-registration); other Reported data follows in the first check-in | `POST /entities` with type `asset` |
| Retire Asset | Operator withdraws participation under [Asset retirement](identity-and-access.md#asset-retirement) | `POST /entities/{entity_id}/retire` |
| Check in | Report current component data under [Check-in](asset-reporting.md#check-in) | `POST /entities/{entity_id}/checkin` |
| Update Asset components | Submit only changed fields under [partial component updates](asset-reporting.md#partial-component-updates) | `PATCH /entities/{entity_id}` |
| Report Asset status | Convenience operation for an [Operational status](asset-reporting.md#operational-status) report | `PATCH /entities/{entity_id}/status` |
| Read operational data | Resource reads, queries and feed subscriptions through [one read interface](#one-read-interface) | HTTP mode: resource endpoints, `/queries` and `/feed`. Full synchronization mode: local only |
| Read Command Catalog | Command definitions from the installed Protocol package under [the Command Catalog](tasks.md#commands-and-the-command-catalog) | Local; no HTTP request |
| Create Task | One execution of one Command on one Asset under [Task creation](tasks.md#task-creation), including when the Asset is offline | `POST /tasks` |
| Fetch assigned Tasks | Outstanding Tasks with submission and current queue order and confirmation state, following pagination, under [Reading the queue](tasks.md#reading-the-queue); same method in both modes | HTTP mode: `GET /entities/{entity_id}/tasks`. Full synchronization mode: local picture |
| Report Task lifecycle | Assigned-Asset execution reports under [Task status and transitions](tasks.md#task-status-and-transitions); returns Core's actual state | `PATCH /tasks/{task_id}/status` |
| Declare Task results | Assigned Asset appends protected or optional result references separately from completion, including after Completed, under [result declarations](tasks.md#scan-completion) | `POST /tasks/{task_id}/results` |
| Cancel Task | Request withdrawal under [cancellation requests](tasks.md#cancellation-requests) | `PATCH /tasks/{task_id}/status` |
| Reorder assigned Tasks | Submit a [queue revision](tasks.md#queue-revisions) | `PUT /entities/{entity_id}/task-order` |
| Report queue adoption | Confirm a revision or report a conflict under [Adoption and conflict](tasks.md#adoption-and-conflict) | `POST /entities/{entity_id}/task-order/confirm` |
| Upload Object content | Stream the whole file with a stable request identity under [Uploads](objects.md#uploads) | `POST /objects/upload`; no resume or offset API |
| Read movement history | Paginated samples for one Asset or Track and time range, under [Historical reads](#historical-reads) | `GET /entities/{entity_id}/movement-history` in every mode |
| Read activity history | Operator administrative clients query the action log, under [Historical reads](#historical-reads) | `GET /admin/activity` in every mode |
| Invoke Plugin Operation | Submit a declared capability under [Submission and retries](plugins.md#submission-and-retries) | `POST /plugins/{plugin_id}/operations` |
| Inspect or cancel Plugin Operation | Query progress and outcome or request cancellation under [Operations](plugins.md#operations) | Plugin Operation read, list and cancel endpoints; direct API access outside the picture |

Registration, check-in, component and status updates, Task lifecycle reports from the assigned Asset, result declarations, required-result uploads and queue adoption reports are Asset-originated and go through the [Asset client](#asset-client). Gateway and Plugin limits follow the [caller permissions](identity-and-access.md#callers-and-permissions). Track observation updates, Geofeature geometry edits and Entity deletion use the ordinary Entity operations under [Entities, Tracks and Geofeatures](tracks-and-geofeatures.md).

## Source reference

The [source reference](../atlas-modernization-reference.md#earlier-sdk-design) records the earlier design and its pinned sources.

## Routes

- Synchronization: `GET /queries/full`, `GET /queries/changed-since` and `GET /feed` in the [Synchronization routes](../api-endpoints.md#synchronization), called by HTTP-mode operations or privately by the background synchronizer.
- Current-Dataset discovery and health remain available across a Dataset change under [Dataset lifecycle](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary).
- Each catalog operation's route is listed in the [Operations catalog](#operations-catalog) and owned by its topic page.

## Open questions

- Radio transport and concrete trusted-gateway enrollment, process-authority and freshness messages under [ADR-0028](../adr/0028-trust-gateways-to-author-bound-asset-reports.md).
- Consumer-specific freshness requirements beyond the accepted provisional field sizing profile.
- Additional SDK languages and shared picture services are outside the initial SDK.

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
