---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress can be reported separately from the main Task status until the required Object is ready.

On 22 September 2026 the API reconciliation retained ready-only visibility and removed metadata-only public Object creation. Use stable upload request identity and stage content and metadata internally; publication waits for content and metadata to be ready. After publication, content is immutable and changed content requires a new Object ID; descriptive metadata and historical Entity/Task associations remain editable. Physical storage paths remain private.

Internal upload staging is an implementation concern. This decision governs initial visibility, not later retention, deletion or recovery behavior.

## Upload failures and retries

On 22 September 2026 the user chose uploads that restart from the beginning after failure, deferring resumability to reduce complexity. This supersedes the earlier same-run resume requirement. Reconsider it only when a concrete large-file workflow over unreliable links justifies transfer-progress APIs and retained partial transfers.

Stream the request into private temporary storage without buffering the entire file in memory. Validate complete content and metadata before publishing the Object. A failed or interrupted upload never exposes an incomplete Object; clean up its temporary content, including abandoned staging found after restart. No upload-session API, offset query, chunk continuation or persistent progress store is required. A producer retains its source file until successful publication and may retry the full upload when connectivity allows. This is producer file retention, not an SDK offline mutation queue.

An interrupted transfer and a lost completion response are different cases. Keep a stable, Dataset-scoped request identity across retries. If the upload already succeeded, return the original Object for an identical retry without creating another Object, overwriting content or publishing a duplicate change. Conflicting reuse fails. If no successful publication exists, a retry sends the complete file again. Serialize attempts for the same identity so concurrent retries cannot publish twice. Exact request fields and content-equivalence verification remain schema work.

Completed Objects and successful upload identity records survive ordinary Restart until Reset. Incomplete staging is disposable and not retained for inspection until Reset. Reset invalidates old upload identities and prevents an old in-flight request from publishing into the new Dataset. These rules still require safe file/metadata publication and cleanup; deferring resume does not remove those correctness obligations.

## Task cancellation and result uploads

Canceling a Task does not cancel its uploads. An in-flight result upload may continue and publish a ready Object after the Task is confirmed Canceled. Keep already-created Objects. The Task remains Canceled regardless of later upload completion; data availability does not reverse a terminal outcome.

This separates collected data from the instruction to stop Asset work. Uploads still follow ordinary validity and resource-limit checks. Their treatment across Core Stop/Restart follows [ADR-0015](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart); cancellation itself does not add an uploader-ownership rule or make a partial Object visible.
