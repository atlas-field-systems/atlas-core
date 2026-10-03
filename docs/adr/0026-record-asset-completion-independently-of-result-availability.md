---
status: accepted
---

# Record Asset completion independently of result availability

The Asset OS, including its `operate` code, decides when Command execution is finished and advances its queue. Core validates and records the assigned Asset's outcome; neither a Core acknowledgement nor Object publication releases the next Task. On 3 October 2026 the user explicitly corrected the earlier upload-gated model, accepted completed scans with files still uploading, and confirmed the complete discussion summary.

Current rules: [Task completion and results](../topics/tasks.md#scan-completion), [scan geometry evidence](../topics/tasks.md#collection-finished-and-geometry) and [Required-result protection](../topics/objects.md#required-result-protection).

## Decision

Record Completed when Core accepts the assigned Asset's valid completion report. The Asset chooses whether uploading files is part of its execution or separate work. File publication, failure or absence cannot create or change a terminal Task outcome. A later Plugin Operation remains independent.

The assigned Asset may append result declarations before or after completion. Declaration validation is a separate operation: an invalid or deleted Object reference cannot block a valid execution-completion report. Accepted Required results remain protected from declaration until Reset, including results uploaded after their Task ends.

Record the geometry revision the Asset actually used. A delayed scan completion against an earlier revision is accepted as execution evidence, with the saved/applied difference visible. A later zone revision requires another Task to scan it; Core does not require the already-finished Asset to collect more data before recording its outcome. During execution, Assets continue to follow received geometry updates within the Command's limits.

## Rationale and consequences

- This replaces [ADR-0008](0008-complete-scan-tasks-when-required-results-are-available.md), which promised usable files whenever a scan was Completed. Completion now describes the Asset's reported outcome, and result availability must be read separately.
- Object publication no longer calls Task transition logic. Object protection and Task result associations remain, without a publication-triggered completion transaction.
- A scan can finish collection while the Asset keeps its Task in progress to upload, or the Asset can report Completed and begin another Task while uploading. Core does not select between those policies.
- A terminal Task releases its required Entity-reference guard under [ADR-0023](0023-protect-required-entity-references-during-tasks.md), while its Required-result Object holds remain until Reset.
- Terminal immutability, confirmed cancellation, ready-only Object visibility and retained evidence remain in force. A missing result does not justify inventing execution failure or reopening a completed Task.
