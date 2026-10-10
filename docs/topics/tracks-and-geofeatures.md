# Entities, Tracks and Geofeatures

This page owns the rules shared by all Entities that no other page owns, and Tracks and Geofeatures: Entity types and immutable identity, Aliases, Components, Entity ID reservation, Entity deletion and the required Entity-reference guard, field authorship, one publisher per Track, observation age and corrections, Track data used by Commands, and Geofeature geometry, its live use by existing Tasks and its edit guard.

Asset registration, retained Asset identity and the access effects of Asset deletion follow [Identity and access](identity-and-access.md). Asset Reported data, Contact and partial component updates follow [Asset reporting](asset-reporting.md). Which references a Task requires, its geometry cutoff, collection finished and the applied geometry revision follow [Tasks](tasks.md). Stale descriptive edits follow [concurrent descriptive edits](../architecture/system-design.md#concurrent-descriptive-edits), and retained movement samples follow [movement history](history.md#movement-history). The [component catalog](../data-components.md) inventories Entity components and their proposed storage.

## Entity types and identity

Only `asset`, `track` and `geofeature` are valid Entity types. Plugins do not introduce additional Entity types. An Entity's ID and type are immutable; its type never changes. Tracks cover stationary and moving observed subjects, so a house is a Track. Geofeatures represent defined zones, rally points and similar spatial designations. Relationships use immutable Entity IDs.

### Aliases

Aliases are optional and editable, and unique across all Entity types ignoring case. An absent alias is null. An Alias is Descriptive data, and `GET /entities/alias/{alias}` resolves a known alias case-insensitively to one Entity.

### Entity ID reservation

Core reserves each Entity ID and its original type atomically on creation within the Dataset. The reservation is retained as a deletion marker after deletion and across Restart, and Core rejects reuse until Reset, including registration retries after deletion. Deleted IDs therefore cannot attach retained history to another Entity, and historical Task assignments and Object associations keep their original identity. An Asset ID also stays bound to its authenticated principal across Reset under [retained Asset identity](identity-and-access.md#retained-asset-identity-after-reset).

## Components

Every supported Entity component requires a Protocol-defined schema and declared applicability. Core validates components against those schemas and their applicability. Plugins will never define or register components, and new components require a Protocol change. The older unrestricted `custom_*` extension pattern is not carried forward.

Entities have no unrestricted `extra` metadata map. Additional Entity data requires named Protocol fields; flexible file-specific metadata belongs on [Objects](objects.md#what-an-object-is). Entity patches follow the [partial component update rules](asset-reporting.md#partial-component-updates).

## Field authorship

Atlas distinguishes Entity data by its author:

- Observed data describes an observed subject and is authored only by its [Track publisher](#one-publisher-per-track).
- Reported, Descriptive and Derived data follow [report authority](asset-reporting.md#report-authority-and-relay) and the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits).

Protocol must distinguish observed fields from operator-managed fields.

### Mutation authority matrix

Protocol marks each mutable field with one authorship class and rejects fields outside its Entity applicability. This table fixes the classes for the inventory in the [component catalog](../data-components.md); it does not add a component or widen a caller's operational permissions. Optional applicability that the catalog still marks as proposed remains proposed; these classes govern a supported field wherever its schema permits it.

| Field or component data | Asset | Track | Geofeature | Author and required evidence |
| --- | --- | --- | --- | --- |
| Alias, subtype and descriptive media associations | Descriptive | Descriptive | Descriptive | Operator client or managed Plugin under [Descriptive edit permissions](identity-and-access.md#assets); `expected_edit_revision`; initial registration has its documented exception |
| Operational status, Command support, health and sensor reports | Reported | Not applicable | Not applicable | Bound Asset/current process or its authenticated gateway relay; `report_context`; registration has its documented Command-support exception |
| Telemetry position, speed, altitude and heading | Reported | Observed | Not applicable | Bound Asset report or the Track's current publisher binding |
| Observed extent geometry | Not applicable | Observed | Not applicable | Track publisher, with its geometry ordering/time evidence |
| Subject classification and sensor observations | Reported where applicable | Observed where applicable | Descriptive where applicable | Bound Asset, Track publisher or authorized descriptive editor according to the Entity's Protocol schema |
| Defined point/line/polygon geometry | Not applicable | Not applicable | Descriptive | Operator client or managed Plugin, edit revision and the live-geometry validation guard |
| Communication state, Contact, retirement, queue aggregate, resource/edit revisions, receipt times and reporting/observation metadata | Derived | Derived where applicable | Derived where applicable | Core only; supplying these fields rejects the whole request |
| Entity ID/type and Track publisher assignment | Immutable | Immutable | Immutable where applicable | Creation/local binding only; no generic patch or publisher-transfer permission |

Operator authority does not grant authorship of Asset reports or Track observations. Plugin operational authority permits descriptive edits and Task issuance, but only its resolved publisher binding permits an observation. An Asset principal cannot report for another Asset; a gateway cannot relay for an unbound Asset. An ordinary credential, observed-field metadata or a claimed publisher ID does not confer authorship. Same-source requests containing Descriptive and Reported/Observed fields are rejected under [mutation-class validation](asset-reporting.md#mutation-classes-and-atomic-validation), not partially applied. Derived time/ordering metadata is returned with current values; clients supply only the report's own input evidence.

## Entity deletion

`DELETE /entities/{entity_id}` removes an Entity when permitted and otherwise returns a conflict that identifies the blocking Tasks. An allowed deletion retains completed Task records and historical Object references; see [Objects](objects.md#what-an-object-is). Core rejects deletion of an Asset while it has nonterminal Tasks. An allowed Asset deletion also revokes the Asset's access under [Asset deletion and access](identity-and-access.md#asset-deletion-and-access); [retirement](identity-and-access.md#asset-retirement) remains possible when that guard blocks removal.

### Required Entity references

When an unfinished Task requires a Track or Geofeature, Entities rejects deletion of that Entity and the conflict identifies the unfinished Task or Tasks that block it. [Tasks](tasks.md#required-entity-references) determines which references a Task requires.

The guard applies while the Task is nonterminal, including while it is pending, paused or waiting on cancellation. A disconnected or retired assigned Asset does not release it and does not cause Core to infer cancellation, completion or failure, so the guard can remain until the Task reaches a terminal outcome or the Dataset is Reset. A valid terminal Asset report releases its guard independently of result-file readiness, and an otherwise permitted deletion may proceed; another unfinished Task requiring the same Entity keeps it protected. The guard survives same-release Restart and is cleared with the Dataset on Reset.

Deletion and Task admission are serialized through the existing write-commit boundaries. If a Task requiring the Entity commits first, deletion is rejected; if deletion commits first, a new Task requiring that Entity is rejected.

This guard is separate from [Required-result protection](objects.md#required-result-protection). A terminal Task may release its Track or Geofeature for deletion while its required Object holds remain until Reset, and Entity deletion cannot release those holds. The guard does not freeze [Geofeature geometry](#live-geometry-for-existing-tasks). It is a deletion and admission guard, not a general dependency-publication or Asset-hybrid synchronization scope, and it adds no route, Task status or operator-forced outcome.

## Tracks

A Track represents an observed subject. Its geometry is optional; Assets use telemetry for position.

### One publisher per Track

Each Track has one publisher responsible for its Observed data. Different publishers describing the same subject create separate Tracks. Core does not automatically combine their observations or choose which publisher is correct.

Entities records the Track's publisher and enforces that boundary on every path that can write its observed fields. Descriptive edits, such as an operator changing an Alias, remain separate and cannot replace publisher-owned observations. Broad operational reads and Plugin Task issuance remain supported, but permission to read another publisher's Track does not grant authorship of its observations; a Plugin cannot overwrite another Track's observed fields merely because it has operational access. This is an ownership rule, not a component extension system or a separate observation service.

Removing a Plugin does not itself delete its published Tracks under the [uninstall contract](plugins.md#uninstall-and-reinstall).

### Plugin fusion

A Plugin may deliberately combine observations from several Tracks and publish a separate Track for the combined result. It is the publisher of that Track.

### Publisher continuity after reinstall

Within the same Dataset, the same authenticated publisher may supply fresh observations to its existing Tracks after Plugin uninstall and reinstall. Core retains enough publisher association with those Tracks to distinguish continuity from another source taking over. Reinstalling under the same display name alone is not proof of publisher identity.

Uninstall still clears Plugin-owned setup and private work, including usable credentials, without removing that retained association. Continuity does not restore revoked credentials, recover an old private queue or rerun an Operation. Access for the verified publisher is reprovisioned through authorized local management. A different publisher creates its own Tracks. Reset's new Dataset does not inherit old observations or permit old submissions to be relabeled.

Stable identity and the authenticated local proof/binding procedure follow [publisher continuity](identity-and-access.md#publisher-continuity). The Entity exposes its immutable `publisher_id`; a display name, Plugin installation ID and Plugin release are separate facts. A fresh principal receives the retained publisher assignment only through that procedure. It reads existing observation boundaries before publishing; uninstall does not reset a Track's counters.

### Silence and observation age

When a Track stops receiving observations, Core retains its last-known data and exposes the observation time or age. Silence alone does not delete the Track or refresh its coordinates. Descriptive edits, Plugin restart or reinstall, and client resynchronization do not make old observations appear current. An authorized explicit deletion still obeys the [required Entity-reference guard](#required-entity-references).

An unknown observation time stays explicitly unknown. Core receipt time can be exposed separately but cannot be presented as the time of observation. Age uses the original source timestamp and the deployment-provided clocks under [ADR-0029](../adr/0029-use-deployment-clocks-and-preserve-event-times.md), without SDK offset estimation. There is no automatic Track expiry or universal stale-after interval.

### Corrections to current observations

The Track's authenticated publisher may correct its current observed value through ordinary updates. The correction preserves the actual observation time, including an explicitly unknown time. Its later submission or receipt does not make the observation fresh, and a correction to an older observation cannot overwrite a newer one.

Previously recorded movement samples are retained. An accepted correction containing movement quantities adds a sample through ordinary [movement history](history.md#movement-history) ingestion; it does not replace the original sample. Descriptive editors and other publishers cannot use a correction to bypass observed-field ownership. There is no separate correction endpoint or historical-edit workflow; history-only backfill and manual sample editing remain deferred.

### Observation identities, ordering and time

Every Track create/update carrying Observed data has `observation_context` with a stable UUID `report_id` and optional `publisher_id`. Dataset and Protocol version use the ordinary headers. Core resolves the publisher from current authenticated authority under [publisher continuity](identity-and-access.md#publisher-continuity); a supplied publisher ID must match that binding. A permitted first Track creation can omit it, and Core allocates the principal's publisher binding atomically with creation. The returned Track/result identifies the resolved publisher. The report identity is `(dataset_id, publisher_id, track_id, report_id)`. Matching retries are duplicates with no second effect; changed original facts under that identity return `observation_identity_conflict`. Revocation is checked before replay. Descriptive requests do not contain this context.

The report also supplies `observation_context.observations` metadata for exactly the Observed quantities it changes. A quantity is position (complete latitude/longitude pair), altitude, speed, heading, observed geometry, subject classification, or another Protocol-declared scalar/array unit. Each supplied unit carries `observation_id`, positive decimal-string `observation_sequence`, original source `observed_at` or null, and `correction_revision` (`"0"` for an original observation). Optional nullable `clock_uncertainty_ms` may be retained as compatibility metadata, but is not required or estimated and does not define an age budget. The sequence is allocated once per Track by its publisher and increases for new observations, independently of client clocks. Units measured together may share one observation identity/sequence/time; updates to another unit do not change their metadata. The publisher can obtain the Core-owned `max_observation_sequence` and current unit identities from a Track read before resuming after reinstall. Reusing a known observation identity with another sequence/time, or changing an original unit value without a correction revision, returns `observation_identity_conflict`.

Each sequence belongs to one original observation group identified by `observation_id` within the Dataset and Track. Core binds that sequence and identity on first acceptance and retains the binding until Reset. Different quantities may share that group, including when delivered in separate reports. For each quantity in the group, Core retains its original value or removal and time/compatibility facts; a matching repeat has no new effect. Reusing the sequence for another observation identity, or reusing a group's quantity with changed original facts, returns `observation_identity_conflict`. Core rejects the whole request without recording report acceptance, current-state, movement or public-change effects, even when other quantities in it are valid. A permitted correction retains the original group and uses its distinct correction revision.

Core orders each quantity by its observation sequence and then its correction revision, not by the Track's aggregate resource version, receipt time or another field's time. A newly received position can be newer for position while older than the last heading. An ordinary delayed observation is accepted once and its explicitly supplied movement is captured, but only newer affected quantities become current. An optional observed-field removal carries its own unit metadata and retains an ordering tombstone. Metadata for omitted quantities is unchanged; metadata not matching supplied values rejects the whole request. Report identities, quantity identities and ordering are recorded with the state/sample/change commit and retained until Reset.

Current Entity reads and queries include the Core-assembled `observations` metadata by quantity: the original identity, sequence/time, any retained compatibility metadata, correction revision, first-observation receipt time, current applied correction receipt time and `time_quality`. Initial unknown time has `observed_at: null`, `time_quality: unknown`, and null age. A timestamp inconsistent with the correct-clock assumption remains marked `uncertain` with null usable age; Core does not repair it, substitute receipt time or clamp a future timestamp to zero age. Known ages use the original source time directly under [deployment clocks](../adr/0029-use-deployment-clocks-and-preserve-event-times.md). This is data-quality reporting, not clock synchronization or an offset-uncertainty budget.

A Command uses the metadata for the quantity it consumes. A fresh classification at time 100 cannot make a position observed at time 10 satisfy a five-second position-age requirement. The Asset applies the Command's declared rule for aged, unknown or uncertain data; Core retains the observation and records no Task outcome from this age alone.

### Correction acceptance

A correction uses the ordinary Entity patch with a new report identity and the current quantity's original `observation_id` and sequence, plus a positive `correction_revision` allocated monotonically by the publisher for that observation. Observation time and any supplied compatibility metadata are immutable, including an originally unknown time. Core verifies the quantity identity against its current observation before applying a correction. A correction to a superseded quantity returns `observation_superseded` without current-state, sample or public-change effects; it is not a history-only backfill request. A delayed lower revision of the current observation has no current effect, but its previously unrecorded explicitly supplied movement is captured once. Reuse of `(Track, quantity, observation_id, correction_revision)` with changed correction facts conflicts, even if the report ID differs.

An accepted correction to current movement appends a new Movement sample while retaining the original. Matching correction retries, including identical facts under another report ID, add no second correction sample. Core retains enough identity facts for that comparison, without storing every complete telemetry packet. Corrections containing unauthorized fields, mixed mutation classes or changed observation time reject atomically. Cross-publisher corrections fail authorization before disclosing observation details.

### Movement ingestion and independent observation fixtures

Movement capture is independent of replacing current quantities. An accepted ordinary report captures only explicitly supplied complete position, speed and altitude, with its report/observation identities and original per-quantity times; it does not copy omitted values from current state. Capture deduplicates each quantity by `(Dataset, Track, quantity, observation_id, correction_revision)`, with revision zero for the original observation. Identical original/correction facts under another outer report ID add no second movement effect; changed facts under that key conflict atomically. A report mixing repeated and new quantities captures only previously unrecorded movement facts. A report containing only heading, classification, descriptive fields or geometry adds no movement sample. Corrections append with their revision/identity correlation. Each sample exposes `received_at` in Core time and per-quantity `observed_at`, any retained compatibility metadata and time quality; a report with differently aged quantities does not receive a fabricated single observation time. History/query time filters must name observation or receipt basis and keep unknown observation time explicit under [movement history](history.md#movement-history).

These are independently stated expectations for future real Core/SDK fixtures, not completed tests. Start Track X owned by publisher P with position observation O1/sequence 10/time 10 at P1. Quantities not listed are absent. Each row is independent unless it explicitly follows another row.

| Input | Current Track expectation | Movement expectation | Time/authority expectation |
| --- | --- | --- | --- |
| Heading O2/sequence 20/time 100 | New heading; position stays P1/O1 | No sample | Position age still derives from 10 |
| After heading 20, delayed position O3/sequence 15/time 90 | Position becomes P3 independently of newer heading | One P3 sample at observed 90/receipt 101 | No age copied from heading |
| After heading 20, delayed position O0/sequence 9/time 5 | P1 retained | One supplied historical position sample | Original old observation time retained |
| Position with unknown time and newer sequence | New position; `observed_at: null` | One sample, labeled unknown observation time | Receipt time is not observation time |
| Position at future 500, Core receipt 100, uncertainty 1 ms | Value recorded by sequence | One sample retaining supplied time | `time_quality: uncertain`; no usable fresh age |
| Current O1 correction revision 1, corrected P1c, original time 10 | P1c/O1/revision 1 | Original retained; one correction sample | Age remains based on 10 |
| Identical correction retry after lost response | No second change | No second sample | Same original/correction identities |
| Original O1 or correction O1/revision 1 repeated under a new outer report ID with identical facts | Accepted no-op for that quantity | No second original/correction sample | Outer identity cannot manufacture a new observation |
| Position O4/sequence 10 with a new outer report ID, after O1/sequence 10 | `observation_identity_conflict`; P1/O1 retained | No sample | Sequence 10 remains bound to O1 |
| New altitude O4/sequence 10, after position O1/sequence 10 | `observation_identity_conflict`; altitude remains absent | No sample | Another quantity cannot assign sequence 10 to a different group |
| Original position O1/sequence 10 repeated with changed P1, alongside valid altitude O2/sequence 20 | Whole request conflicts; P1 retained and altitude absent | No sample for either quantity | No accepted report or public change |
| Matching position O1 plus first altitude O1/sequence 10/time 10, under a new outer report ID | Position unchanged; altitude added with its original group metadata | One altitude sample; no second position sample | Multi-quantity sharing of O1/sequence 10 is preserved |
| Delayed revision 1 of current O1 after revision 2 was accepted | Revision 2 retained | Previously unrecorded revision-1 movement captured once | Neither correction changes observation age |
| Same correction identity with P1d | Identity conflict | No sample | No partial effect |
| Correction O1 after newer position O3 | `observation_superseded`; O3 retained | No history-only correction | No replacement of newer evidence |
| Correction O1/time 11 instead of 10 | Rejected immutable observation facts | No sample | Original age preserved |
| Different publisher Q corrects O1 | Authorization rejection | No sample | P remains publisher |
| Valid descriptive Alias edit alone | Alias changes; observations unchanged | No sample | Neither observed time nor publisher changes |
| Alias plus valid P position observation | Mixed-class rejection | No sample | Neither edit class is applied |
| Position time 10 and fresh classification time 100; current-position Command at 102 with five-second limit | Both retained as reported | No extra sample from classification | Asset treats position as too old; Core does not infer failure |
| Same Track and last-known-position Command at 102 | Same values and ages | No extra sample | Asset may use P1 under that Command's last-known rule |

For multi-quantity reports, validate all input units first, then commit acceptance, each applicable current value, samples and public changes together. Sequence zero is invalid. A failure before commit leaves all unchanged, and an identical retry after Restart applies once.

### Publisher transfers

Publisher transfer is outside the initial scope, including an operator-directed transfer. A different publisher creates a separate Track. Silence, uninstall, matching names or aging observations do not transfer authority over the existing Track. Same-publisher [continuity after reinstall](#publisher-continuity-after-reinstall) remains supported.

Existing Tasks keep their original Track references and are not automatically retargeted to the replacement publisher's Track. Changing the target requires a new Task under the immutable-input rule of [Task creation](tasks.md#task-creation); it does not cancel or establish an outcome for the original Task. The [required Entity-reference guard](#required-entity-references) still applies to the old Track. Any future transfer workflow requires a successor decision.

### Track data used by Commands

Core imposes no universal age cutoff for executing Tasks against Track observations. A Command that requires current observations defines the acceptable age and the behavior when data becomes too old. A Command intended to use last-known positions may continue. Each Command's contract must address unknown observation time without treating receipt time as proof of freshness.

Core preserves the observation and exposes its age or unknown-time condition. The Asset applies the Command's rule; Core does not infer a Task failure, pause or physical stop from Track silence. Exact thresholds and stale-data responses belong to each Protocol-defined Command, with execution owned by the Asset OS. There is no user-configurable global expiry or Plugin-defined Command extension mechanism.

## Geofeatures

A Geofeature represents a defined spatial designation, such as a zone or rally point.

### Geometry

Every Geofeature must have valid point, line or polygon geometry at creation, using the [shared spatial representation](spatial-data.md#coordinates-and-quantities). Unfinished drawings remain in the interface until valid.

Entities allocates a Core-owned positive decimal-string `geometry_revision`, starting at `"1"` and increasing by one for each accepted geometry change, independently of descriptive edits to other fields. It retains the highest issued revision with the Dataset Entity reservation even after deletion; every revision through that boundary was issued to that identity. Its revision-check interface supports [Task collection and result correlation](tasks.md#collection-finished-and-geometry) without requiring a complete geometry history or exposing private tables. Reset clears this Dataset evidence.

### Live geometry for existing Tasks

A Task referencing a Geofeature follows edits to its geometry until its Command's [geometry cutoff](tasks.md#live-geofeature-geometry). Entities validates and commits a geometry edit under the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits). Committed updates reach the full operational picture through ordinary synchronization. The Asset client or gateway must deliver updated geometry to affected execution, and the Asset OS owns how the running Command adapts its physical work.

### Edit guard

Entities rejects a geometry edit that would make the Command input invalid for an unfinished Task that has not reached its geometry cutoff, such as redrawing a scan polygon as a point or exceeding the Command's declared limits, and names the blocking Tasks. This mirrors the [required Entity-reference guard](#required-entity-references). Valid edits remain live. Ready result Objects and accepted execution evidence keep their existing retention rules; an edit does not erase work already performed.

### Disconnection and adoption

A disconnected Asset may continue with its last received geometry within the Command's existing execution limits. Loss of contact alone does not stop otherwise valid work. On reconnect, still-running affected execution adopts the latest geometry; it does not execute each intervening edit as another instruction. A completed execution report records the revision actually used under [Tasks](tasks.md#live-geofeature-geometry), even if an edit reached Core first; it does not require repeating completed physical work. Existing pause, cancellation, terminal-outcome and [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) rules still apply.

### Saved and applied geometry

Atlas distinguishes Core's saved geometry from the geometry the assigned Asset reports it has applied to the Task. An edit accepted by Core is not proof that the Asset received or applied it, and Core or gateway receipt is not adoption. An older adoption report cannot establish that a newer edit has been applied. The Asset may adjust execution before Core receives its report; confirmation is evidence, not an additional Core permission step. The revision a terminal report used is recorded under [Tasks](tasks.md#live-geofeature-geometry).

## Routes and SDK operations

- Read Entities: `GET /entities`, `GET /entities/{entity_id}` and `GET /entities/alias/{alias}` in the [Entities routes](../api-endpoints.md#entities), through the ordinary read operations in both SDK modes.
- Create Tracks and Geofeatures: `POST /entities`. Asset registration uses the same route under [Identity and access](identity-and-access.md#asset-registration).
- Update: `PATCH /entities/{entity_id}` carries publisher observations and corrections, and descriptive and geometry edits with their version precondition. The SDK submits them through the same [write methods](sdk.md#writes) in both modes.
- Delete: `DELETE /entities/{entity_id}`, returning the blocking-Task conflict when a guard applies.
- Movement history: `GET /entities/{entity_id}/movement-history`, through the SDK's Read movement history [operation](sdk.md#operations-catalog).
- There is no route for publisher transfer or observation correction.

## Open questions

- Component payload schemas beyond the mutation classes and observation units specified above; shared Entity filters follow the [query contract](sdk.md#query-and-status-contract).
- Entity relationships and lifecycle behavior beyond the rules on this page.
- Command-specific age thresholds and stale-data responses.
- Complete Command-specific geometry payload schemas beyond the [collection/result correlation](tasks.md#collection-finished-and-geometry) and [report ordering](asset-reporting.md#shared-report-context) specified above.
- Private coordination and storage layout for the deletion and edit guards.
- Publisher transfers are deferred and require a successor decision.

## Decisions

- [ADR-0022](../adr/0022-one-publisher-per-track.md): one publisher per Track, continuity, observation age, corrections, deferred transfers and Command-specific freshness.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): unfinished Tasks protect required Track and Geofeature references from deletion.
- [ADR-0024](../adr/0024-use-live-geofeature-geometry-in-tasks.md): Tasks follow live Geofeature geometry, with the edit guard, offline adoption and saved versus applied geometry.
- [ADR-0026](../adr/0026-record-asset-completion-independently-of-result-availability.md): the Asset decides and reports completion, independently of file readiness, and records the geometry revision actually used.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): Entity identity reservations are retained across Restart and cleared by Reset.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): the full picture carries geometry changes and the Asset client or gateway delivers them.
- [ADR-0021](../adr/0021-manage-plugin-operational-storage-through-reset.md): uninstall keeps published Tracks and their publisher attribution.
- [ADR-0029](../adr/0029-use-deployment-clocks-and-preserve-event-times.md): observation age retains source timing and uses correct deployment clocks.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Track observation ownership, Track observation corrections and Track freshness during execution.
- Required Entity references, Live Geofeature geometry, and Scan geometry and result completion.
- Asset identity and contact: concurrent descriptive edits and alias edits that do not disturb reporting.
- Asset retirement: required Track and Geofeature references stay protected.
- Reset and Restart: retained Entity identity reservations.
- Objects and histories: rejected Entity ID reuse after deletion, and deleted Asset and Track history reads.
