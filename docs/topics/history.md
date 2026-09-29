# Activity and movement history

This page owns Activity history (what is recorded, record contents and attribution, recording and retries, local CLI/TUI actions and the local activity journal, read access and retention) and movement history (capture from accepted reports, Movement sample contents and timing, retention and deletion, the paginated read, request bounds and deferred features).

SDK history calls are explicit reads outside the Local operational picture under [SDK historical reads](sdk.md#historical-reads). Track silence and corrections to current observations follow [Tracks](tracks-and-geofeatures.md#tracks). Reset and Hard Reset execution follow [Dataset lifecycle](dataset-lifecycle.md). Which module supplies each part of an activity record, and how the write commit appends it, is in the system design under [Activity recording](../architecture/system-design.md#activity-recording) and [Write commits](../architecture/system-design.md#write-commits).

## Activity history

### What is recorded

Activity history is a small structured log of which authenticated caller performed a limited set of operational actions:

- Task issuance and cancellation requests.
- Plugin changes.
- Credential changes.
- Configuration changes, including switching [Open enrollment](identity-and-access.md#open-enrollment).
- [Asset retirement](identity-and-access.md#asset-retirement), as an attributed administrative action.

Local CLI/TUI actions are included, including those taken while Core is stopped, under [Local actions](#local-actions).

Ordinary telemetry, resource reads, file contents and full before/after snapshots are not recorded. The records explain a limited set of operational actions, not every rejected request or all external effects. Tamper-evident auditing, export tooling and general replay are outside this scope. The external Command Interface may render the history.

### Record contents and attribution

Each record contains a stable action identity, the authenticated actor's identity and type, the action, its target, the time and the known outcome. Records store safe change summaries and credential identifiers, never secret values.

Attribution names the authenticated caller. A selected Operator profile may provide display context, but a shared credential does not prove which human used it; Atlas does not invent that attribution.

Attribution survives deletion of a profile or credential. Each record retains the stable authenticated actor ID and type and the safe display context captured at the time of the action. Profile deletion removes the editable profile and settings, not these historical facts. Records are not cascade-deleted or reassigned to a replacement identity.

### Recording and retries

For database actions, Core records the activity in the same transaction as the accepted change. An idempotent retry does not create another logical action.

For process operations, Core records the accepted request and later the known outcome, linked by action identity. An accepted request is not proof of completion, and a crash may leave the outcome unknown. No transaction is claimed to span the process effect.

Plugins and public clients cannot directly write arbitrary entries or alter recorded ones.

### Local actions

Local administrative actions through the CLI or TUI are recorded with an identified actor, including actions taken while Core is stopped. The local identity and recording mechanism remain implementation choices. They follow the same Reset retention boundary and do not require operator roles or another public administration API.

While Core runs, local management records its actions through Core's private coordination. While Core is stopped, it appends each action to a local activity journal on the installation mount, keyed by action identity and recording the accepted request or its later known outcome. This keeps SQLite accessed only by Core under [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md).

Opening the retained Dataset, or the first Dataset of a new installation, imports the journal inside a write commit before serving and removes entries only after import, so a repeated import creates no duplicate records. First-time setup actions are therefore recorded in the installation's first Dataset.

Reset deletes pending journal entries, together with the managed logs, before Core starts under [Reset execution](dataset-lifecycle.md#reset-execution). The journal is therefore gone before the Reset can be established, and a crash during Reset cannot import pre-Reset activity. Hard Reset deletes the journal.

### Access and retention

Read access follows the operator administrative boundary under [Operator clients](identity-and-access.md#operator-clients). Activity history is retained across Stop, Start and Restart and cleared by Reset under [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Reset does not clear the Operator profiles that belong to [installation setup](dataset-lifecycle.md#operational-state-and-installation-setup).

## Movement history

### Capture

Core keeps a small store of reported Asset and Track movement, separate from current telemetry. When it accepts an ordinary create, update or check-in report, it captures the explicitly supplied position, speed and altitude as an append-only Movement sample, in the same transaction as the current-state write.

- Only explicitly supplied quantities are captured. A position requires a complete latitude and longitude pair; speed-only and altitude-only samples are valid.
- Core does not store whole Entity snapshots or infer measurements from the merged Entity.
- Unrelated changes add no sample.
- A fresh report repeating a stationary position is still an observation and adds a sample. Replaying the same report adds no sample.

Existing Asset report authority and freshness rules still apply under [Asset report acceptance](asset-reporting.md#asset-report-acceptance). Accepted Track corrections append samples through this ordinary capture and never edit recorded ones, under [Corrections to current observations](tracks-and-geofeatures.md#corrections-to-current-observations).

### Sample contents and timing

Each sample records its Entity association, report or sample identity, optional observation time, Core receipt time and the supplied measurements. Receipt time is recorded in [Core time](../adr/0025-use-core-time-as-the-installation-reference-clock.md). Unknown observation time stays explicitly unknown; receipt time provides the labeled fallback for ordering.

### Retention and deletion

Samples are retained across Stop, Start and Restart until Reset, with no separate age-based expiry such as a 30-day job. They are separate from current telemetry and from the synchronization replay window.

Entity deletion does not silently cascade-delete retained samples or attach them to a replacement Entity. Deleted IDs stay reserved under [Entity ID reservation](tracks-and-geofeatures.md#entity-id-reservation). Reset clears the historical Entity identities and samples together; retained authentication bindings alone do not create historical coverage.

### Reading movement history

One paginated read returns raw samples for one Entity and a bounded time range, with their timing and stable ordering, not reconstructed Entity state.

- Core resolves the Entity through its live record or its retained Dataset identity and deletion record, including its original kind. A live-Entity lookup does not gate the read.
- A deleted Asset or Track ID stays queryable, with an explicit deleted-Entity indicator.
- An empty interval returns an empty page. An ID never present in the current Dataset returns not found.
- Dataset and Entity association checks and a stable pagination boundary prevent Reset, identity replacement or concurrent inserts from mixing results. An obsolete-Dataset request cannot read a replacement Dataset.

Request bounds and ingestion capacity must be measured against Asset and Track report rates. Core does not silently sample away observations or truncate a requested interval.

A Command Interface can display returned samples; this page does not select its UI.

### Deferred features

These are deferred:

- History-only backfill, including a separate backfill route. The older pre-identification backfill workflow is therefore not supported initially.
- Manual sample editing.
- Server-generated reduced trails and automatic downsampling.
- Historical-value reconstruction and historical inspection.
- Whole-map replay.

## Routes and local actions

- `GET /admin/activity` in [Activity history](../api-endpoints.md#activity-history): operator administrative clients read a paginated activity page filtered by actor, action, target and time. It is read-only and outside the synchronized picture. The SDK's Read activity history [operation](sdk.md#operations-catalog) calls it in every mode.
- `GET /entities/{entity_id}/movement-history` in [Entities](../api-endpoints.md#entities): consumers read one Asset's or Track's samples with a from/to range and limit/cursor. The SDK's Read movement history [operation](sdk.md#operations-catalog) calls it in every mode.
- `DELETE /admin/operators/{operator_id}` in [Operator records](../api-endpoints.md#operator-records) removes a profile while activity records keep their attribution.
- No public route writes or deletes history, and history editing is [deferred](#deferred-features). Local CLI/TUI actions are recorded through private coordination or the local activity journal.

## Open questions

- Exact local coordination, local actor identity, activity field formats, query limits and failure presentation.
- Placement of the shared recording and query facility: System operations is the proposed home under [Activity recording](../architecture/system-design.md#activity-recording).
- Exact sample columns, report identity encoding and cursor fields.
- Numeric request bounds and ingestion capacity, pending measurement of Asset and Track report rates.

## Decisions

- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): activity and movement history are retained across Restart and cleared by Reset.
- [ADR-0003](../adr/0003-retain-durable-activity-history.md): the original durable activity history requirement, superseded by ADR-0015.
- [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md): SQLite is accessed only by Core, so local actions while Core is stopped use the journal.
- [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope): the local activity journal lives on the installation mount.
- [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md): retirement records the attributed action in its commit.
- [ADR-0007](../adr/0007-reconcile-asset-tasks-after-disconnection.md): cancellation attempts are preserved in activity history.
- [ADR-0022](../adr/0022-one-publisher-per-track.md): corrections do not rewrite recorded history.
- [ADR-0025](../adr/0025-use-core-time-as-the-installation-reference-clock.md): receipt times are recorded in Core time.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Objects and histories: movement deduplication and stable pagination, deleted Asset and Track reads with deletion indicators, empty intervals versus never-present IDs, obsolete-Dataset history rejection, and activity attribution surviving profile and credential deletion without secrets.
- Track observation corrections: the original sample retained and a correction sample appended, with no duplicate on retry.
- Asset retirement: one retirement action, with no activity added by already-retired or deletion-first rejections.
- Hard Reset and retained setup: ordinary Reset clears activity while keeping Operator profiles.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds Dataset opening: importing the local activity journal twice without duplicates, importing first-time setup actions into the first Dataset, and no import of pre-Reset entries after a crash once a Reset is established. The [MVP integration checks](../architecture/system-design.md#mvp-integration-checks) verify that Reset clears activity history.
