---
status: accepted
---

# Expose Objects only when ready

An Object becomes visible through Atlas only when it is ready for use; an upload does not create an unavailable Object listing for operators or consumers. The user considered early visibility interesting but chose the simpler contract, avoiding partial-availability states. For a scan result, upload progress can be reported separately from the main Task status until the required Object is ready.

Current rules: [Objects](../topics/objects.md).

## Decision

Publish an Object only when its content and metadata are ready, with no metadata-only public creation. Stage uploads privately under a stable, Dataset-scoped request identity. After publication, content is immutable and changed content requires a new Object ID; descriptive metadata and historical Entity/Task associations remain editable. Physical storage paths remain private.

The SDK allocates the Object ID before upload, so Task completion reports and uploads can arrive in either order. Failed uploads restart from the beginning. A retry of a successful upload returns its Object, or an explicit deleted-result error after an allowed deletion, without another publication. Objects makes content durable before committing ready metadata in SQLite and reconciles interrupted publication itself.

A declared Required result is protected from declaration acceptance until Reset. Cancelling a Task does not cancel its uploads. An Object storage quota refuses uploads before the disk fills, and missing content is a fault in that one Object.

Decision history:

- 22 September 2026: the API reconciliation retained ready-only visibility and removed metadata-only public Object creation. The user chose uploads that restart from the beginning after failure, superseding the earlier same-run resume requirement.
- 23 September 2026: the user extended Required-result protection to begin when Core accepts the assigned Asset's declaration, rather than waiting for Task completion.
- 26 September 2026: the user selected file-first publication. Clarified the same day: Tasks places a hold through Objects when it accepts each declaration, and Objects enforces deletion protection from its own holds.
- 28 September 2026: the storage quota and per-Object integrity faults were accepted.

## Rationale and alternatives

- Ready-only visibility avoids partial-availability states; early visibility was considered and not chosen.
- Restarting failed uploads from the beginning defers resumability to reduce complexity. Reconsider it only when a concrete large-file workflow over unreliable links justifies transfer-progress APIs and retained partial transfers.
- Allocating the Object ID in the SDK supports either arrival order of completion reports and uploads without a reservation endpoint or a publicly visible placeholder.
- File-first publication avoids committing readiness before the content is durable. It permits unreferenced files after interruption, which Objects must reconcile.
- Continuing uploads after cancellation separates collected data from the instruction to stop Asset work.
- The quota keeps the disk from filling far enough for telemetry, Task reports or other SQLite writes to fail.

## Consequences

- Producers retain source files until successful publication and resend the whole file after a failure; this is not an SDK offline mutation queue.
- Deferring resume does not remove the obligations of safe file and metadata publication and cleanup.
- Objects keeps successful upload identities and private deletion tombstones until Reset, and reconciles interrupted publication before serving Object state.
- Declared Required results cannot be deleted before Reset, with no force-delete override.
- A missing Object file flags that Object and any Task requiring it without stopping Core.
- Exact ID encoding, request fields, content-equivalence verification and filesystem primitives remain schema and implementation work.

## Upload failures and retries

Whole-file uploads, lost-response retries and upload identity are specified in [Uploads](../topics/objects.md#uploads).
