---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress can be reported separately from the main Task status until the required Object is ready.

On 22 September 2026 the API reconciliation retained ready-only visibility and removed metadata-only public Object creation. Allocate transfer identity and stage metadata internally; publication waits for content and metadata to be ready. After publication, content is immutable and changed content requires a new Object ID; descriptive metadata and historical Entity/Task associations remain editable. Physical storage paths remain private.

Internal upload staging is an implementation concern. This decision governs initial visibility, not later retention, deletion or recovery behavior.

Large uploads resume from confirmed progress after connection loss within the same Core run. Partial transfer state is internal and does not make an unavailable Object publicly visible. Stop/Start and Restart preserve stored transfer state; Reset wipes it. The same-run resume guarantee is settled. Retained transfer state does not require reattaching active transfers after a whole-Core restart; that continuity is outside the supported operating model. The resumable upload mechanism remains an implementation choice.

## Task cancellation and result uploads

Canceling a Task does not cancel its uploads. An in-flight result upload may continue and publish a ready Object after the Task is confirmed Canceled. Keep already-created Objects. The Task remains Canceled regardless of later upload completion; data availability does not reverse a terminal outcome.

This separates collected data from the instruction to stop Asset work. Uploads still follow ordinary validity and resource-limit checks. Their treatment across Core Stop/Restart follows [ADR-0015](0015-separate-start-stop-restart-and-reset.md#unfinished-work-after-stop-or-restart); cancellation itself does not add an uploader-ownership rule or make a partial Object visible.
