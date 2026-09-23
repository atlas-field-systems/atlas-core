---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress can be reported separately from the main Task status until the required Object is ready.

On 22 September 2026 the API reconciliation retained ready-only visibility and removed metadata-only public Object creation. Use stable upload request identity and stage content and metadata internally; publication waits for content and metadata to be ready. After publication, content is immutable and changed content requires a new Object ID; descriptive metadata and historical Entity/Task associations remain editable. Physical storage paths remain private.

Internal upload staging is an implementation concern. The sections below additionally define retry identity, deletion and completed-result retention.

## Result identity before upload

To support either arrival order of Task completion reports and file uploads, the SDK allocates a stable Object ID locally before either request. The producer supplies that ID with `POST /objects/upload`, along with the Dataset-scoped upload request identity, and uses the same ID in required-result references. IDs must follow Protocol validation and be collision-resistant; identity generation does not require a reservation endpoint or create a publicly visible Object.

Core may retain a validated completion report containing not-yet-published Object references. Those references cannot satisfy readiness until matching complete Objects are published. Conversely, an upload may publish before the report arrives. Core validates the supplied Object ID and serializes publication so two different upload requests cannot claim the same ID. Binding an upload identity to an Object ID is immutable; conflicting reuse fails. A previously published or deleted ID cannot be repurposed within the Dataset. As with other uploads, no per-caller ownership policy is added.

The Task module retains unresolved required-result references without requiring a placeholder Object row or exposing an incomplete Object. Reset invalidates the old Dataset's uploads and reports. Exact ID encoding and wire fields remain schema work.

## Upload failures and retries

On 22 September 2026 the user chose uploads that restart from the beginning after failure, deferring resumability to reduce complexity. This supersedes the earlier same-run resume requirement. Reconsider it only when a concrete large-file workflow over unreliable links justifies transfer-progress APIs and retained partial transfers.

Stream the request into private temporary storage without buffering the entire file in memory. Validate complete content and metadata before publishing the Object. A failed or interrupted upload never exposes an incomplete Object; clean up its temporary content, including abandoned staging found after restart. No upload-session API, offset query, chunk continuation or persistent progress store is required. A producer retains its source file until successful publication and may retry the full upload when connectivity allows. This is producer file retention, not an SDK offline mutation queue.

An interrupted transfer and a lost completion response are different cases. Keep a stable, Dataset-scoped request identity across retries. If the upload already succeeded and its Object still exists, return that Object for an identical retry without creating another Object, overwriting content or publishing a duplicate change. If it was deleted through an allowed deletion, return the recorded deleted-result outcome defined below. Conflicting reuse fails. If no successful publication exists, a retry sends the complete file again. Serialize attempts for the same identity so concurrent retries cannot publish twice. Exact request fields and content-equivalence verification remain schema work.

Objects survive ordinary Restart unless explicitly deleted where allowed. Successful upload identity records, including their deletion markers, survive Restart until Reset. Incomplete staging is disposable and not retained for inspection until Reset. Reset invalidates old upload identities and prevents an old in-flight request from publishing into the new Dataset. These rules still require safe file/metadata publication and cleanup; deferring resume does not remove those correctness obligations.

## Retrying an upload after allowed deletion

An allowed Object deletion retains a private tombstone with its Object ID and successful upload identity until Reset. An identical upload retry returns an explicit deleted-result error with the original identity; it does not return a ready Object, recreate the file or emit another publication. Conflicting reuse still fails. Deliberately uploading the content again requires a new Object ID and a new upload request identity.

Serialize successful retry lookup, publication and deletion against the same identity facts. If deletion commits first, the retry reports deletion. If the retry observes the live Object first, its success describes that observation; a subsequent deletion can still remove an unprotected Object. Keep the private tombstone out of ready-Object lists while publishing the ordinary deletion change for synchronization. A storage cleanup retry must not remove content belonging to a different identity.

This rule only applies to deletions already permitted by the required-result protection below. It does not permit deletion of a completed Task's required result or introduce retained file contents after deletion.

## Required results of completed Tasks

Accepted after clarification on 22 September 2026: operators cannot delete a required result Object of a completed Task before Dataset Reset. Completed Tasks are retained execution records, and their required ready results must remain available. Reset clears both under the existing lifecycle contract.

Derive protection from the completed Task's authoritative, assigned-Asset-declared required result references. An Object required by any completed Task is protected, even if other Tasks also reference it. Optional attachments and unrelated Objects do not become protected merely by having a descriptive association. Deleting an Entity or editing Object metadata/associations cannot remove the completed Task's required-result reference or release protection. Ordinary descriptive edits remain allowed; immutable content and Core-owned storage facts remain unchanged.

`DELETE /objects/{object_id}` rejects deletion with an explicit conflict when this protection applies. There is no force-delete override or Task-deletion workaround. Task completion and Object deletion must serialize their readiness/protection decision: if completion wins, deletion fails; if an allowed deletion wins first, the missing result cannot satisfy completion. Physical cleanup must never remove a protected file because it was scheduled against stale metadata. Exact transaction/reservation mechanics follow storage implementation.

This protection applies when the Task has completed. Nonterminal, failed or cancelled Tasks do not independently pin their Objects under this rule, although another completed Task may. Upload/retry handling must preserve the protection and cannot replace the immutable required result. Allowed deletion follows the retained identity and explicit deleted-result retry outcome above.

## Task cancellation and result uploads

Canceling a Task does not cancel its uploads. An in-flight result upload may continue and publish a ready Object after the Task is confirmed Canceled. Keep already-created Objects. The Task remains Canceled regardless of later upload completion; data availability does not reverse a terminal outcome.

This separates collected data from the instruction to stop Asset work. Uploads still follow ordinary validity and resource-limit checks. Their treatment across Core Stop/Restart follows [ADR-0015](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart); cancellation itself does not add an uploader-ownership rule or make a partial Object visible.
