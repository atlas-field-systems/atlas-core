---
status: accepted
---

# Complete scan Tasks when required results are available

A scan Task reaches Completed when the scan has finished and its required result is available in Atlas. The user chose this over marking completion after physical acquisition alone, so operators can rely on a completed scan having its required result ready for use. Until then the Task remains In progress; separate Asset-provided progress details can explain that scanning has finished and data is uploading.

Keep the seven main Task statuses: Pending, Acknowledged, In progress, Cancellation requested, Completed, Canceled and Failed. A later Plugin Operation on the result has its own lifecycle and does not delay completion of the scan Task. Failed records unsuccessful outcomes; Cancellation requested distinguishes an operator request from confirmed cancellation. [Objects appear only when ready](0009-expose-objects-only-when-ready.md); the progress-detail and failure-reason contracts remain to be designed.
