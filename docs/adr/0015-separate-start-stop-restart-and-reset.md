---
status: accepted
---

# Separate Start, Stop, Restart and Reset

The user revised the lifecycle on 21 September 2026. Start, Stop and Restart preserve operational data and logs. Reset clears them. Restart and Reset are primarily development actions. Reset is the usual way to begin fresh; Restart preserves data and diagnostic logs for further development and inspection.

Under the [field operating model](../architecture/operating-model.md#field-workflow), Core remains available throughout the mission. Restart, Reset and release updates happen outside it, with Assets no longer participating; temporary radio disconnection does not end the mission.

Active mission continuity across a whole-Core restart is excluded. Do not require reattachment of executing Assets, resumption of Plugin attempts or continuation of uploads after Core restarts. An unexpected Core failure is outside that continuity guarantee; this assumption does not require fault tolerance or automatic recovery. Independent Plugin lifecycle actions while Core stays running remain supported.

| Action | Runtime effect | Operational data and logs | Installation setup |
| --- | --- | --- | --- |
| Start | Start Core using existing state; initialize an empty store on first use | Preserve existing state | Preserve and reapply |
| Stop | Stop Core | Preserve | Preserve |
| Restart | Stop and start Core | Preserve | Preserve and reapply |
| Reset | Stop Core, clear Atlas-owned operational state and Atlas-managed diagnostic logs, then start Core | Wipe | Preserve and reapply |

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records, Task creation identities, Entity identity reservations/deletion markers, Asset report acceptance state, required-result declarations and successful upload identity records with any deletion markers. Private Dataset metadata retains the Dataset ID and writing Core release across same-release Restart and is re-established by Reset. Temporary upload files are disposable staging, cleaned after interruption or on startup under ADR-0009. Reset clears Atlas-managed diagnostic logs as well as operational activity history. It does not erase unrelated host logs or files. Installed Plugin selections, credentials, configuration, installed software and Plugin artifacts survive all four actions.

This supersedes [ADR-0013](0013-start-each-core-run-with-empty-data.md). Retention is bounded by Reset rather than the Core process lifetime. If Core is already stopped, Reset clears state and starts Core. A new-release update includes Reset; distribution and update packaging remain to be designed.

Retained records do not authorize automatic resumption or rerun. A Plugin crash while Core remains running follows [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md); Asset execution remains the Asset OS's responsibility.

Persistent storage uses the [selected stack](0016-use-go-sqlite-and-openapi-tooling.md) and [Docker mount layout](0017-deploy-core-and-plugins-as-docker-containers.md). Backup and restore functionality and version-to-version operational-data migrations are excluded. New-release updates perform Reset; same-release restarts preserve state.

## Dataset boundary

Each dataset has an identifier, created on first initialization, retained across Restart, and changed by Reset before new state is exposed, including release-update Reset. The SDK detects an identifier change, discards its old synchronized picture and pending submissions, then reads fresh state. Core rejects old-dataset mutations and work submissions, including resource writes, Task instructions/reports, Plugin Operation submissions and upload submissions/publication. It also rejects replay requests with obsolete dataset cursors and upload retries with obsolete Dataset identities. Health, authentication and current-dataset discovery remain available without an old-dataset match, so a client can reconnect and read a fresh snapshot. Ordinary reads do not authorize replaying old writes. The SDK checks dataset identity before accepting responses into its current picture or retrying a submission; the SDK must not silently relabel them as new submissions. This reset boundary was accepted on 21 September 2026. It does not identify an Asset process, introduce a Session resource, or promise Reset during an active mission. Exact wire placement remains implementation design.

## Unfinished work after Stop or Restart

Retention preserves evidence; it does not claim that execution continued. Stop records interrupted Core-owned work when possible. Before serving retained state on Start, Core classifies any remaining unfinished attempts from the previous Core run. Preserve confirmed terminal outcomes first.

| Retained work | Behavior after Start |
| --- | --- |
| Asset Tasks | Keep recorded statuses, reports and result references. Do not infer Asset success, failure or cancellation from the Core interruption, and do not automatically reissue Tasks |
| Plugin Operations | Mark unfinished attempts Interrupted under the [Operation lifecycle](0002-core-manages-installed-plugins.md#operation-transitions). A submission retry retrieves that attempt; a rerun must be explicit |
| Partial Object uploads | Clean up abandoned private staging. Retried uploads start from the beginning; no partial-transfer resume or inspection store is required. Preserve already-published Objects and successful upload identity records |

The 22 September upload simplification replaces the earlier retention of partial transfer bytes/progress until Reset; completed operational data remains retained.

This classification supports retained development records, not active mission recovery or a promise to drain all work before Stop. Whole-Core interruption does not add a Task status. Reset clears these records under the existing cleanup rule.

## Release mismatch detection

Store the writing Core release with the dataset. Ordinary Start checks it before serving operational data. A mismatch refuses startup with a clear instruction to use the explicit update/Reset flow; it never silently wipes, migrates or reinterprets retained data. First initialization and Reset establish a dataset for the running release. Same-release development restarts retain state. This is separate from [compatible client versions](0005-allow-compatible-client-versions.md).
