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

When Core accepts a Task, it assigns a permanent increasing submission sequence within the assigned Asset's queue. The sequence defines the default relative order of Queued Tasks independently of client clocks, and assigned-work reads return that order. Retries leave it unchanged. Immediate Tasks keep their submission identity and sequence without occupying the queued path. Exact encoding remains open.

## Task status and transitions

Core records transitions from validated instructions and reports. Task statuses are `pending`, `acknowledged`, `in_progress`, `paused`, `cancellation_requested`, `completed`, `failed` and `cancelled`. Server interruption adds no Task status. "Assigned Asset" follows the [report-authority rule](identity-and-access.md#assets), and every Asset report passes [Asset report acceptance](asset-reporting.md#asset-report-acceptance).

| New status | Allowed previous status | Trigger |
| --- | --- | --- |
| Pending | No Task | Core accepts a valid Task creation request |
| Acknowledged | Pending | Assigned Asset accepts the Task into its local queue |
| In progress | Pending, Acknowledged, Paused | Assigned Asset reports execution has started, or confirms explicit [Resume](#resume) of the suspended Task |
| Paused | Pending, Acknowledged, In progress | Assigned Asset confirms suspension of already-started work after executing immediate [Pause](#pause); report includes execution facts if Core missed the start |
| Cancellation requested | Pending, Acknowledged, In progress, Paused | Tasking client requests withdrawal; Core records intent and notifies the Asset |
| Completed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports completion and the Command's required results are ready |
| Cancelled | Cancellation requested | Assigned Asset confirms the identified cancellation request |
| Execution status established by accepted reports | Cancellation requested | Assigned Asset [declines](#cancellation-declined) the identified cancellation request |
| Failed | Pending, Acknowledged, In progress, Paused, Cancellation requested | Assigned Asset reports a definitive unsuccessful outcome |

Reports may skip intermediate execution states when messages arrive late or are missed, but cannot move execution backward. A progress-only report preserves the current status. Reading or caching an assigned Task does not acknowledge or start it; the Asset reports those transitions explicitly.

Completion must meet the Command's result requirements. A completion report awaiting required data preserves the applicable nonterminal state, including `paused` or `cancellation_requested`, until the [scan completion](#scan-completion) conditions hold or another terminal outcome is confirmed.

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

The Task-list response carries the requested and confirmed revisions and an edit revision with the relevant ordered list. Pagination must detect an invalidated view before a full-list edit is accepted; clients fetch all outstanding pages and deduplicate by Task ID. Queue updates and confirmations reach synchronized clients through the Task and assigned-queue contract, atomically enough to avoid presenting mixed revisions as a confirmed order. Concrete event envelopes and paging fields remain open. No Core readiness gate or execution scheduler is introduced.

## Pause and Resume

Pause and Resume are Protocol-defined Commands issued as ordinary Immediate Tasks. Core records the requests and the reported outcomes; it does not set the Asset's state directly.

### Pause

The Asset handles Pause without waiting for its running Queued Task to finish, suspends that work, enters its Asset-defined idle behavior, reports Operational status `paused` and waits. Starting the next Queued Task would violate that paused condition. Queued Tasks and their order are retained. Pausing an already idle Asset establishes the same paused condition without inventing a suspended Task.

The Pause Task and the suspended Task are distinct. The Pause Task records execution of the control action and completes once the Asset confirms it has entered the paused condition, rather than remaining in progress for the entire wait. A suspended Task reports nonterminal `paused`, with execution and progress information preserved. It does not become Failed, Cancelled or Completed merely because Pause was requested. While paused, the Asset may keep reporting telemetry and handle supported independent immediate actions; those actions do not clear the pause or release the queued path.

Operational status, suspended-Task status and Pause-Task outcome use their own authenticated reporting paths, and Core cannot infer one from another. Reports can arrive separately, and reads must not falsely claim all confirmations arrived together. A failed Pause attempt must not manufacture a paused Asset or suspended Task. A duplicate delivery of the same accepted Pause Task must not reapply the control effect after it has completed; an intentional later Pause is a new Task.

A pending cancellation remains `cancellation_requested` even if the Asset physically suspends the work; suspension is recorded as an execution fact without clearing cancellation intent. Valid completion or failure may still win a race before suspension is confirmed. A late pre-pause start or progress report must not resume a paused Task, and a late pause report cannot reopen a terminal Task. If a completion report was already accepted and its required Objects later become ready, normal completion conditions may resolve the Task without unpausing the Asset or releasing its queue.

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

A scan Task reaches Completed only when the scan has finished and its Required results are available in Atlas; finishing physical acquisition alone is insufficient. Core requires both an authenticated completion report from the assigned Asset and the availability of every Required result that Asset declared. They may arrive in either order. Core retains the report or ready result until both conditions hold, and the final transition still obeys the confirmed-cancellation and terminal-state rules. Until then the Task keeps its applicable nonterminal state, including Paused on confirmed suspension or Cancellation requested while withdrawal is pending. Separate Asset-provided progress details can explain that scanning has finished and data is uploading.

Only the assigned Asset may declare its Task's result references, under the execution-report authority rule. Uploading or modifying an Object is not an Asset completion report. Object readiness alone cannot complete a Task, and an Asset report alone cannot complete a scan whose required data is still unavailable. This adds no caller ownership restriction to Object uploads. The completion report identifies each result by the Object ID the SDK allocated before upload, and an unresolved result reference does not publish an Object or satisfy readiness; see [Object IDs before upload](objects.md#object-ids-before-upload).

A completion submission may return a nonterminal Task; callers receive Core's actual recorded status. A later Plugin Operation on the result has its own lifecycle and does not delay completion of the scan Task. Required results are protected from declaration acceptance until Reset under [Required-result protection](objects.md#required-result-protection). [Object publication](../architecture/system-design.md#object-publication-and-recovery-ownership) describes how the last required publication completes a waiting Task in the same commit.

### Collection finished and geometry

For a scan referencing a Geofeature, Core's acceptance of the assigned Asset's valid collection-finished report closes further geometry changes for that scan. This is the collection evidence in the completion contract, not a new Task status or another Core permission step. The report must account for the geometry current at acceptance.

Acceptance is serialized against geometry edits. If an edit commits first, a report for the earlier geometry cannot close collection: Core preserves valid execution evidence, and the Asset must account for the changed zone before collection can be accepted as finished. Core does not infer failure or issue replacement work. Geometry correlation must distinguish a changed target from unrelated descriptive edits.

If the collection-finished report is accepted first, later edits do not reopen collection, even while required results are still uploading. The Asset finishes uploading the declared results for the accepted work, and scanning the changed zone requires another Task. Core keeps the accepted geometry association with the collection evidence, so later edits and delayed reports cannot reinterpret what was finished. Retrying an already accepted report preserves its recorded acceptance even if the geometry has since changed; it does not reopen collection or establish a new finish boundary.

Required Objects may be ready before or after report acceptance. Once collection is accepted, later Object publication evaluates that accepted evidence and the lifecycle conditions without requiring the scan to adopt subsequent geometry edits. Collection-finished evidence alone is insufficient for Completed; all Required results must also be ready. Confirmed cancellation and other terminal outcomes still prevent a later upload from changing the outcome.

## Required Entity references

Commands identify typed Entity references, and Tasks determines which references are required for an accepted Task. While the Task is unfinished, its required Tracks and Geofeatures cannot be deleted, and a new Task cannot require a deleted Entity, under the [required Entity-reference guard](tracks-and-geofeatures.md#required-entity-references). An Asset with nonterminal Tasks cannot be deleted under [Asset deletion and access](identity-and-access.md#asset-deletion-and-access). Neither guard forces a Task outcome.

## Live Geofeature geometry

A Task's immutable input preserves the identity of a referenced Geofeature, not a frozen copy of its geometry. An unfinished Task follows edits to that geometry until its Command's geometry cutoff. Every Command that references a Geofeature declares that cutoff; the default is the Task's terminal report, and a scan's cutoff is its accepted [collection-finished report](#collection-finished-and-geometry). Geometry edits do not create or reissue Tasks, implicitly Resume paused work, clear cancellation intent or reopen terminal outcomes. Before the cutoff, the Geofeature [edit guard](tracks-and-geofeatures.md#edit-guard) protects the Task's input.

Geometry delivery, offline execution and adoption follow [Geofeatures](tracks-and-geofeatures.md#live-geometry-for-existing-tasks).

Core accepts a valid terminal report as what happened, even if it was made against geometry an operator has since edited, and records the geometry revision the Asset reports having used. A Task completed against superseded geometry is therefore visible in its record rather than rejected or held. A Command whose cutoff is an earlier report, such as a scan's collection-finished report, follows that report's own acceptance rules. Exact revision fields remain open.

## Routes and SDK operations

- Create Task: `POST /tasks` in the [Tasks routes](../api-endpoints.md#tasks), through the SDK's Create Task [operation](sdk.md#operations-catalog). Pause and Resume use this route with their Commands and immediate scheduling; neither adds a dedicated endpoint.
- Read Tasks: `GET /tasks`, `GET /tasks/{task_id}` and `GET /tasks/{task_id}/objects` in the [Tasks routes](../api-endpoints.md#tasks), through the ordinary read operations in both SDK modes.
- Report lifecycle, progress, cancellation requests, confirmation and decline: `PATCH /tasks/{task_id}/status`, through Report Task lifecycle and Cancel Task. This route replaces the separate acknowledge, start, progress, complete, fail and cancel endpoints. Core validates the authenticated actor and transition-specific payload: tasking clients request cancellation, and the assigned Asset supplies execution reports, confirmation and decline. It is not a generic field-edit endpoint. It returns the actual recorded Task, including when required Objects or a cancellation outcome are still pending, and SDK helpers return that state rather than echoing the requested status or optimistically setting Pause or Resume state.
- Fetch assigned Tasks: `GET /entities/{entity_id}/tasks` in the [Entities routes](../api-endpoints.md#entities) in HTTP mode, or the local picture in Full synchronization mode, through Fetch assigned Tasks.
- Reorder assigned Tasks: `PUT /entities/{entity_id}/task-order`. Report queue adoption: `POST /entities/{entity_id}/task-order/confirm`. Both are in the [Entities routes](../api-endpoints.md#entities).
- Read Command Catalog: a local SDK function; no HTTP request.
- The SDK's [Asset client](sdk.md#asset-client) submits Task lifecycle and queue adoption reports and owns Pause and Resume report correlation, queue revision adoption, required-result uploads, reconnect reconciliation and recovery after a process restart.

## Open questions

- Task and queue wire fields, submission sequence encoding, concurrency and report-ordering tokens, event envelopes, paging fields, assigned-work filtering and error encodings.
- Default scheduling selection and exact Command capability fields.
- Command-specific deadline and expiry fields, clock-uncertainty handling, and validation for conflicting immediate actions beyond the Pause and Resume ordering.
- Pause and Resume report correlation fields and stale-report validation.
- Mechanics of reconciling unfinished Tasks after an exceptional interruption, and Asset behavior after cancellation or failure of a Queued Task.
- Authority-transfer proof, stream and sequence fields, freshness checks and recovery messages for Asset-process recovery.
- Progress-detail and failure-reason contracts, geometry correlation and applied-revision fields.
- Grouping Tasks across several Assets.
- The SDK Command Catalog function and Task helper names and signatures.
- Upload-first scan completion is under [evaluation](../adr/0008-complete-scan-tasks-when-required-results-are-available.md#upload-first-evaluation); until a successor decision, both arrival orders and declaration-time protection remain required.

## Decisions

- [ADR-0004](../adr/0004-core-owns-commands-and-assets-execute-tasks.md): Core owns Commands and Assets execute Tasks; Plugins may create Tasks but are not Task targets.
- [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md): Task reconciliation after disconnection, confirmed cancellation, queued and immediate scheduling, Pause and Resume, and Asset-process recovery.
- [ADR-0008](../adr/0008-complete-scan-tasks-when-required-results-are-available.md): scans complete when required results are available.
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
