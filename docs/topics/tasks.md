# Tasks

This page owns Commands and Tasks: the Command Catalog and Asset Command support, Task creation, the Task lifecycle and cancellation, queued and immediate scheduling, queue revisions, Pause and Resume, Command validity, reconnect reconciliation, recovery after an Asset-process restart, scan completion and the Task side of required Entity references and live geometry.

Asset reports, Contact and report acceptance follow [Asset reporting](asset-reporting.md), and caller authority follows [Identity and access](identity-and-access.md). Object readiness, publication and Required-result protection follow [Objects](objects.md). Entity deletion, Geofeature geometry editing and Track data freshness for Commands follow [Entities, Tracks and Geofeatures](tracks-and-geofeatures.md). Plugin Operations have their own [lifecycle](plugins.md#operation-transitions).

## Commands and the Command Catalog

Atlas defines Command semantics centrally. Atlas Protocol owns the Command Catalog and its schemas; Core validates Tasks against them and implements their server guarantees. Tasks are operational instructions, such as scan area, move to, takeoff, land and return to launch. They are not a general-purpose abstraction for software jobs.

Protocol-defined Commands explicitly identify their typed Entity and Object references, which Tasks validates. Each Command declares its supported scheduling, its [validity behavior](#command-validity-and-deadlines) and, when it references a Geofeature, its [geometry cutoff](#live-geofeature-geometry). Exact declaration and wire encoding remain open.

The SDK returns the Command Catalog from the installed Protocol package through a local function, so catalog access requires no Core request or network connection. There is no public command-catalog endpoint. Core, Assets and SDK clients may use different compatible versions under [ADR-0005](../adr/0005-allow-compatible-client-versions.md); unsupported Asset Commands are rejected explicitly.

Plugins cannot introduce Asset Commands or become Task targets. Their own processing and ingestion are [Plugin work](plugins.md), not Tasks, and an area-search Operation or an ongoing aircraft-data source does not require a taskable Plugin Entity.

### Command support

Assets advertise the subset of catalog Commands they support; they cannot extend the catalog or invent Commands outside it. Command support is Reported data, supplied only by the Asset at registration and check-in under [Asset reporting](asset-reporting.md#command-support). It is separate from the complete catalog and covers the Asset's supported scheduling choices for each Command and whether it supports cancellation and progress.

### Dropped Command support

If an Asset stops advertising a Command, Core keeps its outstanding Tasks that use it. The Asset reports each one Failed with an unsupported reason when it reaches it. New Tasks validate against current support.

## Task creation

A Task records one Command invocation assigned to one Asset. Tasking three Assets creates three Tasks; grouping Tasks remains an [open question](#open-questions). Core records requests and outcomes; the Asset OS owns execution.

A creation request carries the Asset ID, Command, input, scheduling choice and an idempotency key. Assignment, Command, input and selected scheduling are immutable. Core validates:

- the Command against the Protocol catalog and its input against the Command's schema;
- the Asset's current advertised Command support, and a [scheduling](#queued-and-immediate-scheduling) choice permitted by both the Command definition and that support. Unsupported combinations fail validation rather than silently changing scheduling;
- the Command's typed Entity and Object references, including [required Entity references](#required-entity-references);
- that the target Asset is not [retired](identity-and-access.md#asset-retirement). This is administrative admission, not execution scheduling or a connectivity gate.

Core accepts and retains valid Tasks even when the Asset is offline, and keeps them in assignment order until the Asset receives them and controls execution. Communication state and connection loss do not gate Task creation or change Task scheduling or execution behavior in Core. A busy Asset can receive further Tasks; Core does not reject them because another Task is running. These checks require no runtime registration, live readiness gate or server scheduling. The caller must still reach Core to submit the request; the SDK has no offline write queue.

Repeating an idempotency key with the same request returns the original Task; the same key with different tasking data conflicts. A retry does not create another queue entry or change the original Task's order. Task creation uses the shared [retry identity](../architecture/system-design.md#retry-identity) mechanism.

Plugins may initiate Tasks for Assets using existing Protocol-defined Commands through the SDK, without an operator issuing each Task. Core must not prohibit tasking because the caller is a Plugin. Task issuance and cancellation are recorded in [activity history](history.md#activity-history).

### Submission sequence

When Core accepts a Task, it assigns a permanent increasing submission sequence within the assigned Asset's queue. The sequence defines the default relative order of Queued Tasks independently of client clocks, and assigned-work reads return that order. Retries leave it unchanged. Immediate Tasks keep their submission identity and sequence without occupying the queued path. Encode submission sequence as a positive unsigned decimal string under [public wire conventions](../architecture/system-design.md#public-wire-conventions).

## Task status and transitions

Core records transitions from validated instructions and reports. Task statuses are `pending`, `acknowledged`, `in_progress`, `paused`, `cancellation_requested`, `completed`, `failed` and `cancelled`. Server interruption adds no Task status. "Assigned Asset" follows the [report-authority rule](identity-and-access.md#assets), and every Asset report passes [Asset report acceptance](asset-reporting.md#asset-report-acceptance).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset accepts the Task into its local queue |
| In progress | Pending, Acknowledged, Paused | Assigned Asset reports execution has started, or confirms explicit [Resume](#resume) of the suspended Task |
| Paused | Pending, Acknowledged, In progress | Assigned Asset confirms suspension of already-started work after executing immediate [Pause](#pause); report includes execution facts if Core missed the start |
| Cancellation requested | Pending, Acknowledged, In progress, Paused | Tasking client requests withdrawal; Core records intent and notifies the Asset |
| Completed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports successful completion |
| Cancelled | Cancellation requested | Assigned Asset confirms the identified cancellation request |
| Execution status established by accepted reports | Cancellation requested | Assigned Asset [declines](#cancellation-declined) the identified cancellation request |
| Failed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports a definitive unsuccessful outcome |

Reports may skip intermediate execution states when messages arrive late or are missed, but cannot move execution backward. A progress-only report preserves the current status. Reading or caching an assigned Task does not acknowledge or start it; the Asset reports those transitions explicitly.

The Asset decides when its Command execution is complete, including whether uploads belong to that execution. Core validates report authority, ordering and the lifecycle transition, then records the outcome. It does not test physical arrival or wait for result files. Result declaration and availability follow [scan completion](#scan-completion) independently.

Automatic lost-Asset failure and an operator-forced terminal override are not part of this table.

### Cancellation requests

A tasking client requests withdrawal, and Core records it by setting `cancellation_requested` and notifying the Asset. Core records every request whether or not the Asset declares cancellation support. Declared support tells interfaces what to expect: the Command Interface warns when the Asset does not declare it, but Core does not reject the request.

The status alone does not prove execution has stopped. Core retains the request identity and details and execution facts such as started time and progress. Acknowledgement, start and progress reports can update validated execution facts but cannot clear the status; only a confirmation, a declined request or another terminal outcome resolves it. Cancellation intent alone does not win a race against completion or failure.

Cancelled requires the assigned Asset's confirmation, even when Core has no acknowledgement: missing acknowledgement does not prove non-delivery. An offline Task can remain `cancellation_requested` until contact resumes. A confirmation identifies the request; matching retries have no new effect and conflicting terminal outcomes fail. The Asset OS decides how to respond to cancellation, and Core validates and records its reported outcome. Core does not infer the Asset's knowledge of the request from wall-clock timestamps.

Once a terminal outcome is confirmed, the cancellation attempt is retained as history and is not presented as still awaiting action. Cancelling a Task does not cancel its result uploads under [Objects](objects.md#task-cancellation-and-result-uploads).

### Cancellation declined

An Asset that cannot withdraw the Task reports that it declines the identified request. The Task returns to the execution status its accepted reports establish, such as Acknowledged, In progress or Paused, never moving execution backward. The declined request remains part of the Task's record and activity history. Declining is not an outcome: the Task continues to its own terminal report, and a later cancellation is a new request.

### Terminal outcomes and retention

Completed, Cancelled and Failed are terminal. A repeated matching terminal report has no new effect, and a conflicting report cannot change the recorded terminal outcome. Data arriving later, including a late result upload, cannot reopen a terminal Task. Connection loss and Core Stop or Restart do not establish any Asset outcome.

Completed and other terminal Tasks remain execution records until Dataset Reset. Operators cannot delete them or rewrite their outcome; there is no generic Task patch or delete endpoint. Interfaces may show only current work by default, but omitting past Tasks from a view does not erase them from Core. Required-result Objects stay protected until Reset under [Required-result protection](objects.md#required-result-protection), regardless of Task status; optional attachments follow ordinary Object deletion rules.

## Queued and immediate scheduling

Every invocation remains a Task. Creation selects immutable `scheduling`, `queued` or `immediate`, permitted by both the Protocol Command definition and the Asset's advertised support. A Command may support both, allowing the caller to queue a lights change or request it immediately. Pause and Resume require immediate scheduling. Default selection and exact capability fields remain open.

Core accepts, stores and publishes Tasks through the ordinary API; the Asset OS decides execution locally. Core does not start Tasks, release the next Immediate Task or schedule execution from Operational status or Communication state.

### Queued Tasks

The Asset fetches its full outstanding Task list, following pagination as needed, and queues Tasks locally. Queued Tasks execute one at a time in the Asset's confirmed queue order: oldest submission first by default, following confirmed [reordering](#queue-revisions). Several Move To Tasks can therefore define a path. A disconnected Asset may continue its last confirmed order.

The Asset's `operate` code decides when to advance that local queue. It need not wait for Core to receive or acknowledge the preceding completion report. The Asset may include uploads in execution or run them separately while executing the next Task; Core does not impose either policy. Delayed reports may therefore leave several queued Tasks recorded as nonterminal even though only one is physically executing.

### Immediate Tasks

Immediate Tasks do not wait for a Queued Task to finish and are not inserted into or reordered within that queue. Independent immediate actions may execute alongside current work: turning lights on during Move To leaves that movement and the remaining queued path unchanged. Immediate does not imply interrupting all work; the Command defines its effect and the Asset implementation coordinates its hardware resources. Conflicting simultaneous immediate Commands require declared behavior; their arbitration is Command-specific, not a generic Core priority scheduler. Pause and Resume follow [control ordering](#control-ordering-and-expiry).

Outstanding-Task reads and the full synchronized picture include Immediate Tasks independently of queued-work position, including while the Asset is paused. Immediate Tasks retain ordinary retry identity, report authority, lifecycle and outcomes. Several Tasks may therefore be in progress on an Asset while only one Queued Task actively executes; the queued one-at-a-time restriction must not be applied globally.

Immediate means prompt Asset handling once received, not guaranteed zero latency or guaranteed delivery during disconnection.

### Command validity and deadlines

Commands must declare their validity behavior, and a Task may carry an optional execution deadline. No universal deadline or start timeout is selected. The Asset checks validity before acting and reports the outcome; a late request must not silently bypass its validity rule. Core does not schedule starts or infer an execution outcome from elapsed time. Validity and deadlines are judged in [Core time](../adr/0025-use-core-time-as-the-installation-reference-clock.md). Exact deadline fields and uncertainty handling remain open. Pause and Resume validity follows [control expiry](#control-ordering-and-expiry).

## Queue revisions

Core records operator-requested order separately from the order the Asset confirms adopting, and preserves immutable submission sequence. Only Queued Tasks that have never started and remain eligible for execution can be reordered, including acknowledged Tasks. Cancellation-requested and terminal Tasks are excluded. Started Tasks stay excluded while paused; suspension does not make a Task unstarted.

A tasking client submits a complete ordered list of eligible unstarted Queued Task IDs, the expected queue revision and a stable request identity. Core validates assignment, uniqueness, eligibility and completeness against that revision atomically. A matching retry returns the original acceptance; conflicting reuse or an obsolete expected revision fails explicitly. New queue membership, eligibility changes and accepted edits invalidate older edit bases. New Queued Tasks append by submission order unless a later accepted edit changes their position. Core publishes the accepted requested order without implying Asset adoption.

### Adoption and conflict

The assigned Asset reports whether it adopted a particular requested revision. Core stores requested order and revision separately from Asset-confirmed order and revision. Repeated matching reports are harmless; an older confirmation cannot acknowledge a newer request or roll back a later confirmation. A report that the Asset could not apply the revision records the conflict and its relevant execution facts rather than implying adoption. If a Task starts on the Asset before it sees a reorder, the Asset reports that conflict and actual execution; Core must not reject reality merely because operator intent changed. Clients reconcile before submitting a new revision. Confirmation means the Asset adopted an order at that point, not that the queue stops changing afterward.

Accepted fresh adoption and conflict reports refresh the Asset's Contact atomically with the queue change under [what refreshes Contact](asset-reporting.md#what-refreshes-contact); duplicate or historical reports and operator reorder requests do not.

### Reading the queue

Assigned-work responses carry the Tasks-owned aggregate and pin its revision under [queue representation and coherent reads](#queue-representation-and-coherent-reads). Clients fetch all outstanding pages and deduplicate by Task ID before editing the complete eligible order. Queue updates reach synchronized clients in whole commits under [synchronization wire](sdk.md#synchronization-wire-and-application-boundary). No Core readiness gate or execution scheduler is introduced.

## Pause and Resume

Pause and Resume are Protocol-defined Commands issued as ordinary Immediate Tasks. Core records the requests and the reported outcomes; it does not set the Asset's state directly.

### Pause

The Asset handles Pause without waiting for its running Queued Task to finish, suspends that work, enters its Asset-defined idle behavior, reports Operational status `paused` and waits. Starting the next Queued Task would violate that paused condition. Queued Tasks and their order are retained. Pausing an already idle Asset establishes the same paused condition without inventing a suspended Task.

The Pause Task and the suspended Task are distinct. The Pause Task records execution of the control action and completes once the Asset confirms it has entered the paused condition, rather than remaining in progress for the entire wait. A suspended Task reports nonterminal `paused`, with execution and progress information preserved. It does not become Failed, Cancelled or Completed merely because Pause was requested. While paused, the Asset may keep reporting telemetry and handle supported independent immediate actions; those actions do not clear the pause or release the queued path.

Operational status, suspended-Task status and Pause-Task outcome use their own authenticated reporting paths, and Core cannot infer one from another. Reports can arrive separately, and reads must not falsely claim all confirmations arrived together. A failed Pause attempt must not manufacture a paused Asset or suspended Task. A duplicate delivery of the same accepted Pause Task must not reapply the control effect after it has completed; an intentional later Pause is a new Task.

A pending cancellation remains `cancellation_requested` even if the Asset physically suspends the work; suspension is recorded as an execution fact without clearing cancellation intent. Valid completion or failure may still win a race before suspension is confirmed. A late pre-pause start or progress report must not resume a paused Task, and a late pause report cannot reopen a terminal Task. File publication does not change Task status, unpause the Asset or release its queue.

### Resume

The caller submits a distinct immediate Resume Task. The Asset continues the suspended Task before the remaining queued work, preserving the Task ID and progress rather than creating a new execution. It reports the suspended Task back to `in_progress`, reports its Operational status as `busy` and completes the Resume Task when the control action has been applied. Resume completion does not mean the suspended work has finished. A delayed pre-pause start report cannot serve as resume confirmation; the report must establish that it belongs to the applied Resume action.

If the suspended Task cannot safely resume, the Asset reports that Task Failed with a reason instead of pretending to continue it or automatically rerunning it from the beginning. The Resume attempt must accurately report what it achieved. After that failure the Asset remains paused and retains the remaining queue. Advancing requires a new explicit Resume after the operator has reviewed the failure; this is a new control Task, not an automatic retry, and no Core scheduler or approval endpoint is involved. Resume cannot reopen a suspended Task that is already Cancelled, Completed or Failed.

When there is no suspended Task, Resume releases the paused queue and the Asset reports `ready` or `busy` according to its actual work. Resume never bypasses unresolved cancellation intent on a suspended Task: the Asset first confirms or declines that cancellation, and after a decline the Task is `paused` again and Resume can continue it. Duplicate delivery of the same completed Resume Task has no further control effect; an intentional later Resume uses a new Task identity.

No timeout, reconnect, new Queued Task, unrelated immediate action or caller status edit implicitly resumes execution, and requesting Resume alone does not clear a reported pause. Task and Asset reads preserve separately arriving reports rather than manufacturing atomic confirmation.

### Control ordering and expiry

An older Pause or Resume cannot undo newer control intent the Asset has already applied. Conflicting Pause and Resume Tasks are compared by immutable Core acceptance order, reusing the per-Asset submission sequence where possible, rather than by packet arrival order or client wall clocks. The comparison applies to Pause and Resume intent, not to every unrelated immediate action. The Asset must not claim knowledge of a newer request it has not received.

The Asset records older superseded requests explicitly, without applying their effects or silently dropping their Task records. A never-executed expired or superseded request reports a non-success outcome with a reason under the existing Failed contract; no Task status is added. An already-terminal Task stays terminal. A previously applied Pause remains a historical successful action even after a later Resume changes the Asset's state. Delayed reports cannot roll Operational status back over a newer applied control action. A Cancellation requested Task keeps its cancellation intent until the assigned Asset confirms or declines it or reports another terminal outcome under [cancellation requests](#cancellation-requests); control actions never clear it.

Pause never expires: stopping late is still safe, so a delayed Pause applies when the Asset receives it unless newer control intent supersedes it. Resume carries a Command-declared default expiry, because restarting work late is the dangerous direction. The Asset judges expiry in Core time. An expired Resume reports Failed with an expiry reason, and the Asset stays paused until a new Resume. An expired newer control must not trigger fallback execution of an older superseded control.

The Command contract must cover the exact interaction of expiry, validated report order and physical actions already in progress. Core supplies authoritative request order and stores reports; it does not withhold or release execution.

## Disconnection and reconnect reconciliation

Operators and Plugins can issue Tasks and cancel outstanding Tasks while an Asset is disconnected; an operator can, for example, cancel a scan and issue a return Task. The Asset retains its onboard queue, and losing connectivity does not change existing unfinished Tasks. A disconnected Asset may still be physically executing a Task and may continue its last confirmed order.

Reconciliation matches actual execution with current operator intent rather than replaying every historical instruction as executable work. In reconnect reconciliation the Asset checks in, catches up on its current Tasks, cancellations and queue revisions, and reports outcomes of work performed while away. Check-in reports Entity data only; current Tasks arrive through assigned-work reads with an outstanding-work filter or through the full synchronized picture and its Task changes. Per-Asset snapshot, feed and replay synchronization is deferred under [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md). The SDK [Asset client](sdk.md#asset-client) performs this workflow. Core records outcomes on Tasks, keeps results in Objects and preserves cancellation attempts in activity history.

This workflow applies while Core remains running. Retention across Restart and the exclusion of whole-Core Mission resumption follow [Dataset lifecycle](dataset-lifecycle.md). Planned Asset shutdowns and restarts are expected only after unfinished work has been resolved. After an exceptional interruption, Core reconciles with the Asset before deciding the outcome of unfinished Tasks; it does not fail them merely because connectivity was lost or the Asset restarted.

## Recovery after an unexpected Asset restart

After an unexpected Asset-process restart, retained outstanding Tasks are reconciliation input, not instructions to execute every record again. The Asset first establishes which work was completed, still running, suspended or never started, using trustworthy execution evidence from the Asset OS. It reports established outcomes and resumes only work whose execution identity and state are reconciled and whose Command permits the action. Reinitializing the SDK does not authorize rerunning work.

If the Asset cannot establish what happened, it keeps the uncertain work and its queued continuation back for explicit recovery. Core preserves its last known Task state and exposes the uncertainty; it does not infer success, failure, cancellation or a fresh execution from restart or connectivity alone. A normal reconnect of the same running Asset is distinct from losing execution knowledge in a process crash.

An obsolete Asset process must not rewrite reconciled state. Core issues a process generation, and reports carry stable identities with ordering appropriate to the affected state, persisted atomically with accepted effects. [Asset report acceptance](asset-reporting.md#asset-report-acceptance) enforces this in Core, and the SDK Asset client owns it for the Asset, taking the Asset OS's execution evidence as reconciliation input. The replacement process establishes its authority through authenticated reconciliation; an obsolete process cannot reclaim authority merely by sending another hello, and a status value or newly claimed process ID alone is not sufficient. Core-side report rejection does not prove an old process has physically stopped executing. Acceptance does not discard an unrecorded Task outcome solely because later telemetry arrived first.

This does not reinstate the public execution-session API, require transparent mission continuation across Core restart or authorize an operator-forced terminal outcome. No recovery endpoint or Task status is added.

## Scan completion

A scan Task reaches Completed when Core accepts its assigned Asset's valid successful-completion report. The Asset decides whether its Task includes uploading or ends when collection finishes. Core records that choice through the Asset's report; it does not gate completion or queue advancement on Object readiness. Collection-finished, active execution, suspended work and upload progress are distinct facts.

Only the assigned Asset may declare its Task's result references, under the execution-report authority rule. Uploading or modifying an Object is not a completion report. Result declarations are append-only and independent of outcome reporting, and may arrive before or after a terminal outcome. They identify SDK-allocated Object IDs without publishing placeholder Objects; see [Object IDs before upload](objects.md#object-ids-before-upload). No final result-set cardinality or closure is required for completion. This adds no caller ownership restriction to Object uploads.

A valid completion submission returns the recorded terminal Task. A failed, refused, missing or later-published upload does not change that outcome. Result availability and integrity are exposed separately through result references and ready Objects. A later Plugin Operation has its own lifecycle. Required results remain protected from declaration acceptance until Reset under [Required-result protection](objects.md#required-result-protection).

### Collection finished and geometry

For a scan referencing a Geofeature, the assigned Asset reports collection finished with the geometry revision it actually used. Core accepts valid evidence even if the saved zone changed while the report was in transit, and records the saved/applied difference. The report closes collection for that Task; it is not a Core permission step or a new lifecycle status. A terminal report also closes collection if no earlier collection-finished report exists.

Geometry edits and report acceptance serialize so readers see the recorded revision and saved/applied difference coherently. Neither commit order rejects an actual completion because a newer zone exists. During collection the Asset follows received geometry updates within Command limits; once collection is finished, scanning the newer zone requires another Task. Core never infers that an edit was received or applied.

Lifecycle reports carry `applied_geometry`, an array of `{ geofeature_id, geometry_revision }` for the Command's referenced geometry, when reporting adoption or a geometry-dependent outcome. A scan report additionally uses `collection_finished: true` to close collection before its terminal outcome if uploading remains part of execution. Explicit collection finish and successful geometry-dependent completion require the actual applied revision for each required geometry reference. Failure or cancellation can close work that never adopted geometry; absent evidence stays unknown rather than blocking that valid outcome. The accepted Task exposes its finish entries as immutable `collection_geometry`, independently of current saved geometry and later result declarations. A repeated matching finish report is a no-op; conflicting replacement of accepted collection evidence is rejected without changing the recorded outcome.

Tasks verifies each supplied ID against its immutable Command references and asks Entities to validate the [issued geometry revision](tracks-and-geofeatures.md#geometry), under the same write boundary as an edit. It never requires equality with the latest saved revision or claims to verify physical collection. An unknown, zero, future or unrelated revision is invalid evidence. Identical report retry compares original facts before consulting later saved values.

Core keeps accepted collection evidence and every result's declared geometry association. Later declarations may describe outputs from earlier applied revisions without releasing their existing holds or rewriting completion; they use the same reference/issued-revision check, including after Geofeature deletion. A matching report retry preserves the original evidence even after an edit. If the producer can never supply a declared result, expose the unavailable reference; preserve both its hold and the Asset's reported outcome. The Asset may report failure before a terminal outcome if that reflects its own execution policy.

Required Objects may be ready before or after declaration or completion-report acceptance. Collection-finished evidence alone is not a terminal outcome unless the Asset also reports completion. Object publication never evaluates or changes execution status. Confirmed cancellation and every other terminal outcome remain immutable.

## Required Entity references

Commands identify typed Entity references, and Tasks determines which references are required for an accepted Task. While the Task is unfinished, its required Tracks and Geofeatures cannot be deleted, and a new Task cannot require a deleted Entity, under the [required Entity-reference guard](tracks-and-geofeatures.md#required-entity-references). An Asset with nonterminal Tasks cannot be deleted under [Asset deletion and access](identity-and-access.md#asset-deletion-and-access). Neither guard forces a Task outcome.

## Live Geofeature geometry

A Task's immutable input preserves the identity of a referenced Geofeature, not a frozen copy of its geometry. An unfinished Task follows edits to that geometry until its Command's geometry cutoff. Every Command that references a Geofeature declares that cutoff; the default is the Task's terminal report, and a scan's cutoff is its accepted [collection-finished report](#collection-finished-and-geometry). Geometry edits do not create or reissue Tasks, implicitly Resume paused work, clear cancellation intent or reopen terminal outcomes. Before the cutoff, the Geofeature [edit guard](tracks-and-geofeatures.md#edit-guard) protects the Task's input.

Geometry delivery, offline execution and adoption follow [Geofeatures](tracks-and-geofeatures.md#live-geometry-for-existing-tasks).

Core accepts a valid terminal report as what happened, even if it was made against geometry an operator has since edited, and records the geometry revision the Asset reports having used. A Task completed against superseded geometry is therefore visible in its record rather than rejected or held. A Command whose cutoff is an earlier report, such as a scan's collection-finished report, follows the [collection evidence fields and acceptance rules](#collection-finished-and-geometry).

## Queue representation and coherent reads

Tasks owns the `task_queue` aggregate included in every Asset Entity, even when empty. It is Derived data, not a client-editable component. Entity snapshots and changes carry its complete value; Task changes and their affected queue value share one [commit frame](sdk.md#synchronization-wire-and-application-boundary). This uses existing full synchronization, not another resource service or SDK mode. An order edit changes this one aggregate, not a second cached position in every Task resource; consumers derive Task positions from the aggregate.

| Field | Meaning |
| --- | --- |
| `revision` | Decimal-string aggregate revision, increased on membership, eligibility, requested-order, confirmation or execution-fact changes; the precondition for an edit |
| `requested_revision`, `requested_task_ids` | Revision at which the complete eligible, unstarted requested order was last changed, and that order |
| `confirmed_revision`, `confirmed_task_ids` | Nullable revision and exact order the Asset last confirmed adopting; preserved evidence, not an automatically normalized claim of adoption |
| `adoption` | `none`, `adopted` or `conflict`, with the reported revision and a reason on conflict |
| `active_queued_task_id`, `suspended_task_id` | Nullable last-known execution facts explicitly reported by the Asset, with their accepted ordering token; null alone does not establish current Contact |

New Tasks append to requested order. Starting, cancellation-requested and terminal Tasks leave its eligible list. These changes advance `revision` and `requested_revision`; they never imply the Asset adopted the newer order. Confirmed IDs can therefore include now-ineligible work. Reads expose the eligible projection separately from the exact confirmed evidence. Only accepted, newer Asset execution facts change the active/suspended association. A late outcome for A cannot clear an explicitly reported active B, and Task status alone is not a global execution scheduler.

An order-edit request uses `expected_queue_revision`, `request_id` and the complete `task_ids` array. An empty array is valid only when the eligible set is empty. Core checks the precondition, exact membership and order atomically. Confirmation names `requested_revision`, `adopted` and, for a conflict, the actual execution facts and reason, using shared [Asset report context](asset-reporting.md#shared-report-context). Core retains the immutable requested snapshot for outstanding confirmations until Reset. An older confirmation may describe an older adopted snapshot but cannot roll back a newer confirmation or acknowledge a different request. A conflict records reality without adopting the requested order.

Assigned-work pages carry one `queue_revision`, the queue aggregate and an opaque continuation bound to the Asset, Dataset, filter and that revision. A changed aggregate before continuation returns `page_changed` with no mixed page. The caller restarts that read; this creates no acknowledgement, execution or reorder. In Full synchronization mode, assigned-work reads use one applied picture boundary and the same revision rule. Snapshot/replay never expose half of a multi-Task edit.

| Independent fixture | Expected result |
| --- | --- |
| Register an Asset with no Tasks | Revision `0`, requested IDs empty, confirmed revision null, no claimed execution |
| Create A then B; edit their order using the current revision | Submission sequences unchanged; one aggregate changes requested order to B,A; confirmed evidence remains unchanged |
| C is created while the caller prepares that edit | Stale edit conflicts with no partial reordering; new current order includes C |
| A starts before a B,A request reaches the Asset | A becomes ineligible; Asset reports the conflict and actual active A; Core does not infer adoption or failure |
| Confirmation of revision 7 follows confirmation of revision 9 | Preserve confirmation 9; retain historical evidence without rolling it backward |
| Queue becomes empty between assigned-work pages | Continuation fails `page_changed`; restart returns a coherent empty aggregate |
| A,B reorder crosses the replay page boundary | One complete aggregate carries both positions; pagination cannot split its array. If a related Task/Entity commit is split into resource frames, expose neither part until that commit is complete |

## Result declarations and execution fixtures

`POST /tasks/{task_id}/results` takes shared Asset report context and a bounded `declarations` array. Each entry has an `object_id`, `required` boolean and, for geometry-derived output, the referenced `geofeature_id` and actual `geometry_revision`. Only the assigned Asset declares results. Existing Task outcome reports never bundle declarations, so declaration validation cannot reject otherwise valid completion evidence.

Declarations add immutable references; they never replace earlier references or release a hold. An exact duplicate has no new effect. Reusing an entry with different original facts conflicts; an optional association cannot downgrade an already-required reference. A whole declaration batch validates atomically, including known Object identity tombstones and geometry provenance. Unknown, not-yet-published Object IDs are allowed, while already-deleted IDs fail explicitly. Accepted required entries place Object holds in the same transaction as report acceptance and the Task's appended references. Task outcome and Command inputs remain unchanged. Required references have no completion-time finalization or cardinality requirement, and appending after Completed, Failed or Cancelled does not reopen that outcome.

Task reads contain declared references, including unpublished IDs. `GET /tasks/{task_id}/objects` continues to list only ready Objects. Consumers resolve declared IDs against Object state to show unavailable, ready or integrity-faulted results; publication does not change Task execution status. This avoids a second cached readiness truth inside Tasks. The full picture already carries both resource sets.

| Independent packet sequence | Expected Task, queue and Object facts |
| --- | --- |
| A finishes collection, reports Completed, B starts, A's upload stalls | A Completed, reported active work B, A's declared result unavailable; Core has released no execution permission |
| Asset keeps A In progress until its upload completes | Core records that reported policy; B starts when the Asset decides to advance |
| Pause arrives while A's separate upload continues and B moves | Pause suspends B and completes its own control Task on confirmation; A's upload continues; no status for A changes |
| Resume cannot safely continue B | B Failed, Asset stays paused, remaining queue retained until a new explicit Resume |
| Cancellation requested for A before its delayed success report | Valid Asset completion may resolve A Completed; later publication changes no outcome |
| A is already Completed before a cancellation request | Reject the terminal transition; preserve A and its uploads |
| Asset reports Completed before declaring two result IDs | Record completion first; later declarations append both references and protected holds, without reopening A |
| One ready result and one unpublished result are declared together | Both references accepted and protected; their different availability has no effect on the Task outcome |
| A result batch names an already-deleted ID | Reject the entire declaration batch; an independent valid completion report is still accepted |
| Geometry 4 is saved before a delayed finish against geometry 3 | Record the actual finish against 3 and expose saved/applied difference; scanning 4 requires another Task |
| Finish against 3 is accepted before geometry 4 is saved | Preserve the accepted finish and associations; edit does not reopen collection |
| Earlier-geometry outputs were declared before an edit | Preserve every declaration and hold; later output can name its actual newer applied revision |
| Saved revision 4, finish or result names issued revision 3 | Accept actual revision 3; neither an equality check nor edit-first order blocks it |
| Finish/result names revision 0, future revision 5 or another Geofeature | Reject that invalid report atomically; no inferred Task outcome or new hold |
| Geofeature is deleted after terminal outcome, then a result names its issued revision | Accept the valid original reference using retained identity/revision evidence; no Entity resurrection |
| Result never arrives, or its upload repeatedly exceeds quota | Keep the declared unavailable result and any accepted terminal outcome; retrying file delivery does not repeat execution |
| Lost finish/declaration response, then edit and identical retry | Replay original accepted facts with no extra hold, no new finish boundary and no duplicate outcome |

## Routes and SDK operations

- Create Task: `POST /tasks` in the [Tasks routes](../api-endpoints.md#tasks), through the SDK's Create Task [operation](sdk.md#operations-catalog). Pause and Resume use this route with their Commands and immediate scheduling; neither adds a dedicated endpoint.
- Read Tasks: `GET /tasks`, `GET /tasks/{task_id}` and `GET /tasks/{task_id}/objects` in the [Tasks routes](../api-endpoints.md#tasks), through the ordinary read operations in both SDK modes.
- Report lifecycle, progress, cancellation requests, confirmation and decline: `PATCH /tasks/{task_id}/status`, through Report Task lifecycle and Cancel Task. This route replaces the separate acknowledge, start, progress, complete, fail and cancel endpoints. Core validates the authenticated actor and transition-specific payload: tasking clients request cancellation, and the assigned Asset supplies execution reports, confirmation and decline. It is not a generic field-edit endpoint. It returns the actual recorded Task, including a terminal Task with unavailable result files, and SDK helpers return that state rather than echoing the requested status or optimistically setting Pause or Resume state.
- Append result declarations: `POST /tasks/{task_id}/results`, through Declare Task results. This independent Asset report records the [declarations and protection holds](#result-declarations-and-execution-fixtures), including after a terminal outcome.
- Fetch assigned Tasks: `GET /entities/{entity_id}/tasks` in the [Entities routes](../api-endpoints.md#entities) in HTTP mode, or the local picture in Full synchronization mode, through Fetch assigned Tasks.
- Reorder assigned Tasks: `PUT /entities/{entity_id}/task-order`. Report queue adoption: `POST /entities/{entity_id}/task-order/confirm`. Both are in the [Entities routes](../api-endpoints.md#entities).
- Read Command Catalog: a local SDK function; no HTTP request.
- The SDK's [Asset client](sdk.md#asset-client) submits Task lifecycle and queue adoption reports and owns Pause and Resume report correlation, queue revision adoption, required-result uploads, reconnect reconciliation and recovery after a process restart.

## Open questions

The [queue representation](#queue-representation-and-coherent-reads), [shared report context](asset-reporting.md#shared-report-context), [synchronization contract](sdk.md#synchronization-wire-and-application-boundary), [result declarations](#result-declarations-and-execution-fixtures) and [MVP spatial contract](spatial-data.md) settle the corresponding specification tickets. Author their complete OpenAPI schemas and SDK signatures in their implementation slices.

- Command variants beyond the MVP, including their progress details, failure reasons and capability fields.
- Command-specific deadlines and validation for conflicting immediate actions beyond Pause and Resume, preserving the accepted control ordering and Core-time rules.
- Asset-specific execution recovery and behavior after cancellation or failure of queued work. Core records the Asset's evidence and does not select its scheduling policy.
- Grouping Tasks across several Assets remains a proposal.

## Decisions

- [ADR-0004](../adr/0004-core-owns-commands-and-assets-execute-tasks.md): Core owns Commands and Assets execute Tasks; Plugins may create Tasks but are not Task targets.
- [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md): Task reconciliation after disconnection, confirmed cancellation, queued and immediate scheduling, Pause and Resume, and Asset-process recovery.
- [ADR-0026](../adr/0026-record-asset-completion-independently-of-result-availability.md): Asset-reported completion, independent result declarations and actual applied scan geometry; supersedes ADR-0008.
- [ADR-0009](../adr/0009-expose-objects-only-when-ready.md): Object readiness, Required-result protection and uploads that continue after cancellation.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): Task retention across Restart and clearing on Reset.
- [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md): retirement blocks new assignments without inventing Task outcomes.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): per-Asset synchronization is deferred; assigned work arrives through HTTP reads or full synchronization.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): unfinished Tasks protect required Track and Geofeature references.
- [ADR-0024](../adr/0024-use-live-geofeature-geometry-in-tasks.md): Tasks follow live Geofeature geometry until their cutoff.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): Command validity, deadlines and Resume expiry are judged in Core time.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Task lifecycle: transitions, cancellation requested versus confirmed or declined, completion and failure races, dropped Command support and terminal immutability.
- Immediate Commands and Pause: overlapping immediate work, Pause, Resume, control ordering and expiry in Core time.
- Task queues: concurrent revisions, delayed confirmations, reconnect reconciliation and exclusion of started, cancellation-requested and terminal Tasks.
- Asset-process recovery: reconciliation before execution and obsolete-process rejection.
- Scan geometry and result completion: both report and edit commit orders and both result arrival orders.
- Required Entity references and Live Geofeature geometry: deletion guards, geometry cutoff and the recorded applied revision.
- Track freshness during execution: Command-specific age limits without manufactured Task outcomes.
- SDK modes: terminal Tasks remain available after a picture rebuild until Reset.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds state-model sequences through the pure Task transition module, Task reporting through shared acceptance against real SQLite, the Asset client's reconnect reconciliation and recovery, both required-result hold paths, and measurement of Task delivery, cancellation and reordering. Task status helpers and queue operations must pass real SDK and Core parity, retry and race scenarios. The [MVP Move To check](../testing-strategy.md#mvp-integration-checks) exercises cancellation and offline issuance followed by reconnect reconciliation.
