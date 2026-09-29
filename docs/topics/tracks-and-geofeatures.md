# Entities, Tracks and Geofeatures

This page owns the rules shared by all Entities that no other page owns, and Tracks and Geofeatures: Entity types and immutable identity, Aliases, Components, Entity ID reservation, Entity deletion and the required Entity-reference guard, field authorship, one publisher per Track, observation age and corrections, Track data used by Commands, and Geofeature geometry, its live use by existing Tasks and its edit guard.

Asset registration, retained Asset identity and the access effects of Asset deletion follow [Identity and access](identity-and-access.md). Asset Reported data, Contact and partial component updates follow [Asset reporting](asset-reporting.md). Which references a Task requires, its geometry cutoff, collection finished and the applied geometry revision follow [Tasks](tasks.md). Stale descriptive edits follow [concurrent descriptive edits](../architecture/system-design.md#concurrent-descriptive-edits), and retained movement samples follow [movement history](../architecture/system-design.md#movement-history). The [component catalog](../data-components.md) inventories Entity components and their proposed storage.

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

## Entity deletion

`DELETE /entities/{entity_id}` removes an Entity when permitted and otherwise returns a conflict that identifies the blocking Tasks. An allowed deletion retains completed Task records and historical Object references; see [Objects](objects.md#what-an-object-is). Core rejects deletion of an Asset while it has nonterminal Tasks. An allowed Asset deletion also revokes the Asset's access under [Asset deletion and access](identity-and-access.md#asset-deletion-and-access); [retirement](identity-and-access.md#asset-retirement) remains possible when that guard blocks removal.

### Required Entity references

When an unfinished Task requires a Track or Geofeature, Entities rejects deletion of that Entity and the conflict identifies the unfinished Task or Tasks that block it. [Tasks](tasks.md#required-entity-references) determines which references a Task requires.

The guard applies while the Task is nonterminal, including while it is pending, paused or waiting on cancellation or Required results. A disconnected or retired assigned Asset does not release it and does not cause Core to infer cancellation, completion or failure, so the guard can remain until the Task reaches a terminal outcome or the Dataset is Reset. A terminal Task releases its guard and an otherwise permitted deletion may proceed, but another unfinished Task requiring the same Entity keeps it protected. The guard survives same-release Restart and is cleared with the Dataset on Reset.

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

### Silence and observation age

When a Track stops receiving observations, Core retains its last-known data and exposes the observation time or age. Silence alone does not delete the Track or refresh its coordinates. Descriptive edits, Plugin restart or reinstall, and client resynchronization do not make old observations appear current. An authorized explicit deletion still obeys the [required Entity-reference guard](#required-entity-references).

An unknown observation time stays explicitly unknown. Core receipt time can be exposed separately but cannot be presented as the time of observation. Age is judged in [Core time](../adr/0025-use-core-time-as-the-installation-reference-clock.md). There is no automatic Track expiry or universal stale-after interval.

### Corrections to current observations

The Track's authenticated publisher may correct its current observed value through ordinary updates. The correction preserves the actual observation time, including an explicitly unknown time. Its later submission or receipt does not make the observation fresh, and a correction to an older observation cannot overwrite a newer one.

Previously recorded movement samples are retained. An accepted correction containing movement quantities adds a sample through ordinary [movement history](../architecture/system-design.md#movement-history) ingestion; it does not replace the original sample. Descriptive editors and other publishers cannot use a correction to bypass observed-field ownership. There is no separate correction endpoint or historical-edit workflow; history-only backfill and manual sample editing remain deferred.

### Publisher transfers

Publisher transfer is outside the initial scope, including an operator-directed transfer. A different publisher creates a separate Track. Silence, uninstall, matching names or aging observations do not transfer authority over the existing Track. Same-publisher [continuity after reinstall](#publisher-continuity-after-reinstall) remains supported.

Existing Tasks keep their original Track references and are not automatically retargeted to the replacement publisher's Track. Changing the target requires a new Task under the immutable-input rule of [Task creation](tasks.md#task-creation); it does not cancel or establish an outcome for the original Task. The [required Entity-reference guard](#required-entity-references) still applies to the old Track. Any future transfer workflow requires a successor decision.

### Track data used by Commands

Core imposes no universal age cutoff for executing Tasks against Track observations. A Command that requires current observations defines the acceptable age and the behavior when data becomes too old. A Command intended to use last-known positions may continue. Each Command's contract must address unknown observation time without treating receipt time as proof of freshness.

Core preserves the observation and exposes its age or unknown-time condition. The Asset applies the Command's rule; Core does not infer a Task failure, pause or physical stop from Track silence. Exact thresholds and stale-data responses belong to each Protocol-defined Command, with execution owned by the Asset OS. There is no user-configurable global expiry or Plugin-defined Command extension mechanism.

## Geofeatures

A Geofeature represents a defined spatial designation, such as a zone or rally point.

### Geometry

Every Geofeature must have valid point, line or polygon geometry at creation. A point uses one position; lines and polygons use lists of points. Unfinished drawings remain in the interface until valid.

### Live geometry for existing Tasks

A Task referencing a Geofeature follows edits to its geometry until its Command's [geometry cutoff](tasks.md#live-geofeature-geometry). Entities validates and commits a geometry edit under the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits). Committed updates reach the full operational picture through ordinary synchronization. The Asset client or gateway must deliver updated geometry to affected execution, and the Asset OS owns how the running Command adapts its physical work.

### Edit guard

Entities rejects a geometry edit that would make the Command input invalid for an unfinished Task that has not reached its geometry cutoff, such as redrawing a scan polygon as a point or exceeding the Command's declared limits, and names the blocking Tasks. This mirrors the [required Entity-reference guard](#required-entity-references). Valid edits remain live. Ready result Objects and accepted execution evidence keep their existing retention rules; an edit does not erase work already performed.

### Disconnection and adoption

A disconnected Asset may continue with its last received geometry within the Command's existing execution limits. Loss of contact alone does not stop otherwise valid work. On reconnect, affected execution adopts the latest geometry; it does not execute each intervening edit as another instruction. Existing pause, cancellation, terminal-outcome and [reconnect reconciliation](tasks.md#disconnection-and-reconnect-reconciliation) rules still apply.

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

- Exact Entity filters and the detailed mutable-field schema for Entity patches.
- Entity relationships and lifecycle behavior beyond the rules on this page.
- Publisher identity encoding, authentication and binding, the local provisioning mechanism for continuity, and report ordering.
- Exact observation-time and age fields, report identity and correction correlation.
- Command-specific age thresholds and stale-data responses.
- Geometry correlation, adoption report ordering and transport fields.
- Error fields, reference encoding and private coordination for the deletion and edit guards.
- Publisher transfers are deferred and require a successor decision.

## Decisions

- [ADR-0022](../adr/0022-one-publisher-per-track.md): one publisher per Track, continuity, observation age, corrections, deferred transfers and Command-specific freshness.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): unfinished Tasks protect required Track and Geofeature references from deletion.
- [ADR-0024](../adr/0024-use-live-geofeature-geometry-in-tasks.md): Tasks follow live Geofeature geometry, with the edit guard, offline adoption and saved versus applied geometry.
- [ADR-0008](../adr/0008-complete-scan-tasks-when-required-results-are-available.md): accepted collection-finished evidence closes a scan's geometry changes.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): Entity identity reservations are retained across Restart and cleared by Reset.
- [ADR-0020](../adr/0020-limit-general-sdk-to-http-and-full-sync.md): the full picture carries geometry changes and the Asset client or gateway delivers them.
- [ADR-0021](../adr/0021-manage-plugin-operational-storage-through-reset.md): uninstall keeps published Tracks and their publisher attribution.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): observation age is judged in Core time.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Track observation ownership, Track observation corrections and Track freshness during execution.
- Required Entity references, Live Geofeature geometry, and Scan geometry and result completion.
- Asset identity and contact: concurrent descriptive edits and alias edits that do not disturb reporting.
- Asset retirement: required Track and Geofeature references stay protected.
- Reset and Restart: retained Entity identity reservations.
- Objects and histories: rejected Entity ID reuse after deletion, and deleted Asset and Track history reads.
