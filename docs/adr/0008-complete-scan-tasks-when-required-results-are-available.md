---
status: accepted
---

# Complete scan Tasks when required results are available

A scan Task reaches Completed when the scan has finished and its required result is available in Atlas. The user chose this over marking completion after physical acquisition alone, so operators can rely on a completed scan having its required result ready for use. Until then the Task remains In progress with any cancellation request retained separately; separate Asset-provided progress details can explain that scanning has finished and data is uploading.

The [Task transition table](0007-reconcile-asset-tasks-after-disconnection.md#task-transitions) defines the six execution statuses. A later Plugin Operation on the result has its own lifecycle and does not delay completion of the scan Task. Failed records unsuccessful outcomes; The separate cancellation request distinguishes operator intent from confirmed cancellation. [Objects appear only when ready](0009-expose-objects-only-when-ready.md); the progress-detail and failure-reason contracts remain to be designed.

Cancellation during acquisition or upload follows [the Task transition rules](0007-reconcile-asset-tasks-after-disconnection.md#task-transitions), with [uploads independent of cancellation](0009-expose-objects-only-when-ready.md#task-cancellation-and-result-uploads).

## Both completion conditions

Core requires both an authenticated completion report from the assigned Asset and the availability of every required result Object declared by that Asset. They may arrive in either order. Core retains the report or ready result until both conditions hold; the final transition still obeys the confirmed-cancellation and terminal-state rules.

Only the assigned Asset may declare its Task's execution result references, under the existing execution-report authority rule. Uploading or modifying an Object is not an Asset completion report. Object readiness alone cannot complete a Task, and an Asset report alone cannot complete a scan whose required data is still unavailable. This does not add caller ownership restrictions to Object uploads.
