# Objects

This page owns Objects: what an Object is, ready-only visibility, SDK-allocated Object IDs, uploads and their retries, publication and recovery, deletion and deleted-result retries, Required-result protection, uploads after Task cancellation, the Object storage quota and integrity faults, metadata edits and download.

Scan completion and the Task side of Required results follow [Tasks](tasks.md#scan-completion), and caller authority and retirement races follow [Identity and access](identity-and-access.md). Module ownership of publication and recovery, Required-result holds and the collaboration with Tasks is in [Object publication and recovery ownership](../architecture/system-design.md#object-publication-and-recovery-ownership). Object retention across Restart and Reset cleanup follow [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md). Plugin private storage follows [Plugins](plugins.md#private-operational-storage).

## What an Object is

An Object holds file content of any type together with descriptive metadata. Its flexible JSON metadata carries additional file-specific information and does not override storage-owned facts. An Object can reference zero or more related Entities and Tasks; a photograph's content, for example, lives in an Object whose metadata can reference related Entities. References are historical associations, not ownership links that cascade-delete files: deleting a related Entity retains the Object and its references, which remain as context even when the related record is unavailable.

After the first successful upload, file content is immutable. An upload never overwrites it, and changed content requires a new Object ID. Descriptive metadata and associations remain editable under [metadata edits](#metadata-edits). Public content type and byte size are measured by the upload process, and physical storage paths remain private; [Objects hide storage](../architecture/system-design.md#objects-hide-storage) keeps storage-provider details inside the Objects module.

Objects survive ordinary Restart unless explicitly deleted where allowed.

## Ready-only visibility

An Object becomes visible through Atlas only when its content and metadata are ready for use. An upload does not create an unavailable Object listing for operators or consumers, and there is no metadata-only Object creation: the earlier `POST /objects` route is removed. Upload identity, staged metadata and progress are separate transfer state, not publicly listed Objects.

Reads, queries, the feed and the SDK's local picture carry only ready Object metadata and associations. File content is never sent through the feed; clients fetch it through the [download](#download) routes. For a scan result, upload progress can be reported separately from the Task status until the Required result is ready.

## Object IDs before upload

To support either arrival order of Task completion reports and file uploads, the SDK allocates a stable Object ID locally before either request. The producer supplies that ID with `POST /objects/upload`, along with the Dataset-scoped upload request identity, and uses the same ID in required-result references. IDs must follow Protocol validation and be collision-resistant. Allocating an ID requires no reservation endpoint and creates no publicly visible Object.

Core may retain a validated completion report containing references to Objects not yet published. Those references cannot satisfy readiness until matching complete Objects are published. Conversely, an upload may publish before the report arrives. Tasks retains unresolved required-result references without a placeholder Object row or an exposed incomplete Object, and [scan completion](tasks.md#scan-completion) combines the two.

Core validates the supplied Object ID and serializes publication so two different upload requests cannot claim the same ID. Binding an upload identity to an Object ID is immutable: reusing an upload request with another Object ID, or claiming an already used Object ID with a different request, conflicts. A previously published or deleted ID cannot be repurposed within the Dataset. No per-caller ownership policy applies to uploads. Reset invalidates the old Dataset's uploads and reports.

## Uploads

An upload carries the complete file. Core streams the request into private temporary storage without buffering the entire file in memory, and validates complete content and metadata before publishing the Object. A failed or interrupted upload never exposes an incomplete Object. Core cleans up its temporary content, including abandoned staging found after restart. Incomplete staging is disposable and is not retained as an operational record or for inspection.

A failed transfer restarts from the beginning. No upload-session API, offset query, chunk continuation or persistent progress store exists; resumable transfers are deferred under [ADR-0009](../adr/0009-expose-objects-only-when-ready.md). A producer retains its source file until successful publication and may retry the full upload when connectivity allows. This is producer file retention, not an SDK offline write queue: the SDK retains the Object ID and request identity but no partial-transfer progress.

### Retries after a lost response

An interrupted transfer and a lost success response are different cases. The producer keeps a stable, Dataset-scoped request identity across retries of the same upload.

- If the upload already succeeded and its Object still exists, an identical retry returns that Object without creating another Object, overwriting content or publishing a duplicate change.
- If the Object was deleted through an allowed deletion, the retry returns the recorded [deleted-result outcome](#retries-after-deletion).
- If no successful publication exists, the retry sends the complete file again.
- Conflicting reuse of the identity fails.

Core serializes attempts for the same identity so concurrent retries cannot publish twice. Uploads use the shared [retry identity](../architecture/system-design.md#retry-identity) mechanism. Successful upload identity records, including their deletion markers, survive Restart until Reset. Reset invalidates old upload identities and prevents an old in-flight request from publishing into the new Dataset.

The SDK never allocates a replacement identity and silently uploads again. Deliberately uploading the content again requires a new Object ID and a new upload request identity.

## Publication and recovery

Publication is file-first. Objects makes complete content durable in its private immutable location before committing ready metadata in SQLite. A file in that location is not, by itself, a published Object.

1. Stream and validate complete content and metadata in private staging, then install the immutable content without overwriting another Object. Make both the content and its file location durable before the ready-state commit. Keep file transfer and durability work outside the SQLite write transaction. Exact filesystem primitives must be verified for the supported host storage.
2. In a short SQLite transaction, recheck the current Dataset, publication authority and the Object and upload identities, including successful retries and deletion markers. Serialize publication authorization with credential revocation under [revocation and retirement](#revocation-and-retirement-during-publication), and serialize required-result checks under [Required-result protection](#declaration-publication-and-deletion-order). Commit ready metadata, the successful upload identity and the public change record together. Return publication success only after that commit. A concurrent retry or Dataset change must not turn the same file into a second publication.
3. On retained-state startup, Objects reconciles interrupted publication before serving Object state. Preserve files referenced by committed ready Objects and their successful identities. Remove abandoned staging and unreferenced publication files only after establishing that they belong to abandoned work; cleanup must not race an active upload or remove another identity's content. Never reconstruct ready metadata or complete a Task merely because a file exists.

When publication satisfies a waiting Task's last Required result, Tasks commits any resulting completion in the same transaction under its completion and terminal-state rules; publication never reopens a terminal Task. See [Object publication and recovery ownership](../architecture/system-design.md#object-publication-and-recovery-ownership).

### Attempt locations and cleanup

Each physical upload attempt has a distinct private content location, separate from the stable public Object ID, and private ownership facts bind that location to its Dataset, upload request and attempt. A failed pre-commit attempt must not occupy the only location available to an identical retry. Without requiring Restart, that retry sends the full file into a fresh attempt location and follows the same serialized identity checks; only the successful SQLite commit selects the Object's content location.

An occupied file alone proves neither successful publication nor permission to reuse or remove it. Under the same identity coordination, cleanup must establish ownership and that no committed Object or active attempt uses the file. Files with unknown ownership are left untouched and the cleanup problem is reported; cleanup never overwrites another attempt's content. Conflicting upload or Object identity reuse still fails.

### Failures around the commit

A failure before the SQLite commit leaves no ready Object, and an identical retry follows the whole-file [retry rules](#retries-after-a-lost-response). A failure after the commit, including a lost response, preserves the successful identity for retry lookup.

Missing content behind committed metadata is an integrity failure to report, not permission to return a ready success, silently erase the record or manufacture another publication. It is a fault in that one Object under [integrity faults](#storage-quota-and-integrity-faults), not a reason to stop Core. Reset still stops writers before clearing state and rejects obsolete-Dataset publication. Objects owns this recovery behind its [ordinary interface](../architecture/system-design.md#object-publication-and-recovery-ownership); generic lifecycle code does not infer file validity from private rows.

### Revocation and retirement during publication

Publication authorization is serialized with credential revocation. [Retirement races](identity-and-access.md#retirement-races) define both commit orders for Asset retirement and the cleanup of a rejected attempt.

Retry lookup still requires current authorization: if retirement or other revocation intervenes, Core rejects the revoked caller even when its earlier publication committed. Rejection cleanup may remove only abandoned, uncommitted attempt data and preserves the committed Object, its content and its successful upload identity. An unaffected authorized principal can recover the recorded result under the ordinary matching-retry rules.

## Deletion

`DELETE /objects/{object_id}` removes an Object that [Required-result protection](#required-result-protection) does not cover, such as an optional attachment or an unrelated Object. Core validates protection atomically with the deletion and arranges stored-content removal only when deletion is allowed. Deletion publishes the ordinary deletion change for synchronization. A storage cleanup retry must not remove content belonging to a different identity. A rejected deletion must not remove the Object from an SDK synchronized picture.

### Retries after deletion

An allowed deletion retains a private tombstone with its Object ID and successful upload identity until Reset. The tombstone stays out of ready-Object lists. An identical upload retry returns an explicit deleted-result error with the original identity; it does not return a ready Object, recreate the file or emit another publication. Conflicting reuse still fails. Deliberately uploading the content again requires a new Object ID and a new upload request identity.

Successful retry lookup, publication and deletion serialize against the same identity facts. If deletion commits first, the retry reports deletion. If the retry observes the live Object first, its success describes that observation; a subsequent deletion can still remove an unprotected Object.

Tombstones follow only deletions that Required-result protection permits. They do not permit deletion of a Task's declared Required result or retain file contents after deletion.

## Required-result protection

A Required result is protected from the moment Core accepts the assigned Asset's declaration until Dataset Reset. Operators cannot delete it before Reset. The declaration may precede upload; it protects the Object as soon as publication occurs, without exposing a placeholder Object. An ID that has never been published or deleted can still be declared before upload.

Protection derives from the authoritative, assigned-Asset-declared required-result references that Tasks retains, not from editable Object associations. An Object required by any Task is protected. Optional attachments and unrelated Objects do not become protected merely by having a descriptive association. Once accepted, a required reference cannot be removed or replaced to release protection. Later Task completion, failure or cancellation does not release it. Deleting an Entity or editing Object metadata or associations cannot bypass it. Ordinary descriptive edits remain allowed; immutable content and Core-owned storage facts remain unchanged. Upload retries cannot replace immutable content or remove protection.

`DELETE /objects/{object_id}` rejects deletion with an explicit conflict when protection applies. There is no force-delete override or Task-deletion workaround. Reset clears the references and Objects together.

Required-result references survive Restart until Reset, including declarations whose uploads have not arrived. Objects enforces protection from its own holds, which Tasks places when it accepts each declaration; see [Object publication and recovery ownership](../architecture/system-design.md#object-publication-and-recovery-ownership). This protection is separate from [required Entity references](tracks-and-geofeatures.md#required-entity-references), which a terminal Task releases.

### Declaration, publication and deletion order

Declaration acceptance, Object publication and deletion serialize against the same Object identity. If the required declaration commits first, deletion fails. If an allowed deletion commits first, Core rejects a later declaration referencing that deleted ID with an explicit deleted-result error; it does not accept an unsatisfiable required reference or completion report. A rejected report changes neither the Task's result references nor its status. The Asset can upload under a new Object ID and submit a corrected report, or report failure when it cannot supply the result.

Physical cleanup must never remove a protected file because it was scheduled against stale metadata. Exact transaction mechanics follow storage implementation.

## Task cancellation and result uploads

Cancelling a Task does not cancel its uploads. An in-flight result upload may continue and publish a ready Object after the Task is confirmed Cancelled. Already-created Objects are kept. The Task remains Cancelled regardless of later upload completion; data availability does not reverse a terminal outcome.

Uploads still follow ordinary validity and resource-limit checks. Cancellation adds no uploader-ownership rule and does not make a partial Object visible. Treatment of uploads across Core Stop and Restart follows [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart).

## Storage quota and integrity faults

Object storage has a quota that leaves headroom for operational writes. Core explicitly refuses uploads that would exceed it, so the disk never fills far enough for telemetry, Task reports or other SQLite writes to fail. Required results remain protected; the quota does not permit deleting them early. The Asset may retry a refused upload once space is available, under the ordinary whole-file retry rules. Quota size and headroom follow the measured workload.

A missing or unreadable file behind committed Object metadata is a per-Object integrity fault. Core still opens the Dataset and serves other state. The affected Object and any Task that requires it show an integrity flag, the Object's content read fails explicitly, and a Completed Task stays Completed. Core does not delete the record, reconstruct content or reopen the Task.

## Metadata edits

Descriptive fields and associations may be staged with the upload and edited after publication through `PATCH /objects/{object_id}`. Edits use the [concurrent-edit protection](../architecture/system-design.md#concurrent-descriptive-edits): a stale edit conflicts for caller review. Edits cannot change immutable content or Core-owned storage facts, and they cannot release [Required-result protection](#required-result-protection).

## Download

`GET /objects/{object_id}/download` streams the content as an attachment. `GET /objects/{object_id}/view` streams supported content inline for preview, or returns an attachment or an unsupported-type error. Arbitrary upload types do not imply arbitrary inline rendering. Reading the content of an Object with an [integrity fault](#storage-quota-and-integrity-faults) fails explicitly.

## Routes and SDK operations

- Read Objects: `GET /objects` and `GET /objects/{object_id}` in the [Objects routes](../api-endpoints.md#objects), `GET /entities/{entity_id}/objects` in the [Entities routes](../api-endpoints.md#entities) and `GET /tasks/{task_id}/objects` in the [Tasks routes](../api-endpoints.md#tasks), through the ordinary read operations in both SDK modes.
- Upload: `POST /objects/upload`, through the SDK's Upload Object content [operation](../sdk-operations.md#initial-operations). It takes the complete file stream, the SDK-allocated Object ID, the Dataset-scoped request identity, metadata and associations, and returns the ready Object, the original success or the explicit deleted-result error. There is no resume or offset API.
- Required-result uploads: the SDK's [Asset client](../sdk-operations.md#asset-client) preallocates the result Object ID, uses it in the completion report and delegates the whole-file upload to the upload operation. No route is added.
- Edit metadata: `PATCH /objects/{object_id}` with a version precondition.
- Delete: `DELETE /objects/{object_id}`. SDK deletion helpers return Core's conflict for a protected Required result.
- Download and preview: `GET /objects/{object_id}/download` and `GET /objects/{object_id}/view`. File content is outside the synchronized picture in every SDK mode.

## Open questions

- Exact Object ID encoding, upload request fields and wire fields.
- Content-equivalence verification for upload retries.
- Exact filesystem primitives for the supported host storage, and exact transaction mechanics for declaration, publication and deletion.
- Transfer limits, quota size and headroom, set from the measured workload.
- Deletion completion.
- Supported preview formats.
- Exact Object metadata schema and reference representation, and revision and error encodings for metadata edits.
- Resumable uploads are deferred; [ADR-0009](../adr/0009-expose-objects-only-when-ready.md#rationale-and-alternatives) records when to reconsider them.
- Upload-first scan completion is under [evaluation](../adr/0008-complete-scan-tasks-when-required-results-are-available.md#upload-first-evaluation); until a successor decision, both arrival orders and declaration-time protection remain required.

## Decisions

- [ADR-0009](../adr/0009-expose-objects-only-when-ready.md): ready-only visibility, whole-file upload retries, file-first publication, deleted-result retries, Required-result protection, uploads that continue after cancellation, the storage quota and per-Object integrity faults.
- [ADR-0008](../adr/0008-complete-scan-tasks-when-required-results-are-available.md): scans complete when Required results are available, with result Object IDs allocated before upload.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): Object retention across Restart and cleanup on Reset.
- [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md): private local Object files with metadata in SQLite.
- [ADR-0019](../adr/0019-retire-assets-without-inventing-task-outcomes.md): retirement serializes with upload publication and keeps Required-result protection.
- [ADR-0023](../adr/0023-protect-required-entity-references-during-tasks.md): required Entity-reference protection stays separate from Required-result protection.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Objects and histories: interrupted uploads and cleanup, crashes around the ready-state commit, whole-file and lost-response retries, ready-only visibility, SDK-allocated IDs in both arrival orders, deleted-upload retries and Required-result protection races.
- Resource limits: the Object storage quota and a missing Object file.
- Asset retirement: the upload publication race.
- Task lifecycle and Scan geometry and result completion: late Object readiness and preserved Required-result holds.
- Required Entity references: Object holds remain after the Entity guard is released.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds interrupted Object publication through Objects and Restart, ended retry claims for uploads after allowed deletion, the Asset client's required-result uploads in both arrival orders and both required-result hold paths. The [MVP Object transfer check](../architecture/system-design.md#mvp-integration-checks) exercises an interrupted upload, a whole-file retry, download equality and a lost success response.
