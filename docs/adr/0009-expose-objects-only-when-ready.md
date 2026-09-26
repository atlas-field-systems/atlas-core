---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress can be reported separately from the main Task status until the required Object is ready.

On 22 September 2026 the API reconciliation retained ready-only visibility and removed metadata-only public Object creation. Use stable upload request identity and stage content and metadata internally; publication waits for content and metadata to be ready. After publication, content is immutable and changed content requires a new Object ID; descriptive metadata and historical Entity/Task associations remain editable. Physical storage paths remain private.

Internal upload staging is an implementation concern. The sections below additionally define retry identity, deletion and required-result retention.

## Result identity before upload

To support either arrival order of Task completion reports and file uploads, the SDK allocates a stable Object ID locally before either request. The producer supplies that ID with `POST /objects/upload`, along with the Dataset-scoped upload request identity, and uses the same ID in required-result references. IDs must follow Protocol validation and be collision-resistant; identity generation does not require a reservation endpoint or create a publicly visible Object.

Core may retain a validated completion report containing not-yet-published Object references. Those references cannot satisfy readiness until matching complete Objects are published. Conversely, an upload may publish before the report arrives. Core validates the supplied Object ID and serializes publication so two different upload requests cannot claim the same ID. Binding an upload identity to an Object ID is immutable; conflicting reuse fails. A previously published or deleted ID cannot be repurposed within the Dataset. As with other uploads, no per-caller ownership policy is added.

The Task module retains unresolved required-result references without requiring a placeholder Object row or exposing an incomplete Object. Reset invalidates the old Dataset's uploads and reports. Exact ID encoding and wire fields remain schema work.

## Upload failures and retries

On 22 September 2026 the user chose uploads that restart from the beginning after failure, deferring resumability to reduce complexity. This supersedes the earlier same-run resume requirement. Reconsider it only when a concrete large-file workflow over unreliable links justifies transfer-progress APIs and retained partial transfers.

Stream the request into private temporary storage without buffering the entire file in memory. Validate complete content and metadata before publishing the Object. A failed or interrupted upload never exposes an incomplete Object; clean up its temporary content, including abandoned staging found after restart. No upload-session API, offset query, chunk continuation or persistent progress store is required. A producer retains its source file until successful publication and may retry the full upload when connectivity allows. This is producer file retention, not an SDK offline mutation queue.

An interrupted transfer and a lost completion response are different cases. Keep a stable, Dataset-scoped request identity across retries. If the upload already succeeded and its Object still exists, return that Object for an identical retry without creating another Object, overwriting content or publishing a duplicate change. If it was deleted through an allowed deletion, return the recorded deleted-result outcome defined below. Conflicting reuse fails. If no successful publication exists, a retry sends the complete file again. Serialize attempts for the same identity so concurrent retries cannot publish twice. Exact request fields and content-equivalence verification remain schema work.

Objects survive ordinary Restart unless explicitly deleted where allowed. Successful upload identity records, including their deletion markers, survive Restart until Reset. Incomplete staging is disposable and not retained for inspection until Reset. Reset invalidates old upload identities and prevents an old in-flight request from publishing into the new Dataset. These rules still require safe file/metadata publication and cleanup; deferring resume does not remove those correctness obligations.

## Publication and recovery ordering

On 26 September 2026 the user selected file-first publication. Objects makes complete content durable in its private immutable location before committing ready metadata in SQLite. A file in that location is not, by itself, a published Object. This ordering avoids committing readiness before the content is durable; it permits unreferenced files after interruption, which Objects must reconcile.

1. Stream and validate complete content and metadata in private staging, then install the immutable content without overwriting another Object. Make both the content and its file location durable before the ready-state commit. Keep file transfer and durability work outside the SQLite write transaction. Exact filesystem primitives must be verified for the supported host storage.
2. In a short SQLite transaction, recheck the current Dataset and the Object/upload identities, including successful retries and deletion markers. Serialize required-result checks under the existing protection rule. Commit ready metadata, the successful upload identity and the public change record together. Return publication success only after that commit. A concurrent retry or Dataset change must not turn the same file into a second publication.
3. On retained-state startup, Objects reconciles interrupted publication before serving Object state. Preserve files referenced by committed ready Objects and their successful identities. Remove abandoned staging and unreferenced publication files only after establishing that they belong to abandoned work; cleanup must not race an active upload or remove another identity's content. Never reconstruct ready metadata or complete a Task merely because a file exists.

A failure before the SQLite commit leaves no ready Object; an identical retry still follows the whole-file retry contract. A failure after the commit, including a lost response, preserves the successful identity for retry lookup. Missing content behind committed metadata is an integrity failure to report, not permission to return a ready success, silently erase the record or manufacture another publication. Reset still stops writers before clearing state and rejects obsolete-Dataset publication. Objects owns this recovery logic behind its [ordinary interface](../architecture/system-design.md#object-publication-and-recovery-ownership); generic lifecycle code does not infer file validity from private rows.

## Retrying an upload after allowed deletion

An allowed Object deletion retains a private tombstone with its Object ID and successful upload identity until Reset. An identical upload retry returns an explicit deleted-result error with the original identity; it does not return a ready Object, recreate the file or emit another publication. Conflicting reuse still fails. Deliberately uploading the content again requires a new Object ID and a new upload request identity.

Serialize successful retry lookup, publication and deletion against the same identity facts. If deletion commits first, the retry reports deletion. If the retry observes the live Object first, its success describes that observation; a subsequent deletion can still remove an unprotected Object. Keep the private tombstone out of ready-Object lists while publishing the ordinary deletion change for synchronization. A storage cleanup retry must not remove content belonging to a different identity.

This rule only applies to deletions already permitted by the required-result protection below. It does not permit deletion of a Task's declared required result or introduce retained file contents after deletion.

## Required result protection

On 23 September 2026 the user extended required-result protection to begin when Core accepts the assigned Asset's declaration, rather than waiting for Task completion. Operators cannot delete a declared required result Object before Dataset Reset. The declaration may precede upload; it protects the Object as soon as publication occurs without exposing a placeholder Object.

Derive protection from authoritative, assigned-Asset-declared required result references retained by Tasks. An Object required by any Task is protected. Optional attachments and unrelated Objects do not become protected merely by having a descriptive association. Once accepted, a required reference cannot be removed or replaced to release protection. Later Task completion, failure or cancellation does not release it. Deleting an Entity or editing Object metadata/associations cannot bypass it. Ordinary descriptive edits remain allowed; immutable content and Core-owned storage facts remain unchanged.

`DELETE /objects/{object_id}` rejects deletion with an explicit conflict when this protection applies. There is no force-delete override or Task-deletion workaround. Reset clears the references and Objects together under the existing lifecycle contract.

Serialize declaration acceptance, Object publication and deletion against the same Object identity. If the required declaration commits first, deletion fails. If an allowed deletion commits first, reject a later declaration referencing that deleted ID with an explicit deleted-result error; do not accept an unsatisfiable required reference or completion report. A rejected report changes neither the Task's result references nor its status. The Asset can upload under a new Object ID and submit a corrected report, or report failure when it cannot supply the result. An ID that has never been published or deleted can still be declared before upload. Physical cleanup must never remove a protected file because it was scheduled against stale metadata. Exact transaction mechanics follow storage implementation.

Required-result references survive Restart until Reset, including declarations whose uploads have not arrived. Upload retries cannot replace immutable content or remove protection. Unprotected Objects retain the allowed deletion and explicit deleted-result retry behavior above.

## Task cancellation and result uploads

Canceling a Task does not cancel its uploads. An in-flight result upload may continue and publish a ready Object after the Task is confirmed Canceled. Keep already-created Objects. The Task remains Canceled regardless of later upload completion; data availability does not reverse a terminal outcome.

This separates collected data from the instruction to stop Asset work. Uploads still follow ordinary validity and resource-limit checks. Their treatment across Core Stop/Restart follows [ADR-0015](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart); cancellation itself does not add an uploader-ownership rule or make a partial Object visible.
