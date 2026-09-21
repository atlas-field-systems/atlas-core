---
status: accepted
---

# Separate Start, Stop, Restart and Reset

The user revised the lifecycle on 21 September 2026. Start, Stop and Restart preserve operational data and logs. Reset clears them. Restart and Reset are primarily development actions. Reset is the usual way to begin fresh; Restart preserves data and diagnostic logs for further development and inspection.

The field workflow is arrive at a site, set up Core, connect Assets, and run the mission. Core stays running throughout that mission. Restart, Reset and Core release updates happen outside the mission, with Assets no longer participating. Temporary Asset disconnection is part of the running mission, not an opportunity to restart Core.

Active mission continuity across a whole-Core restart is excluded. Do not require reattachment of executing Assets, resumption of Plugin attempts or continuation of uploads after Core restarts. An unexpected Core failure is outside that continuity guarantee; this assumption does not require fault tolerance or automatic recovery. Independent Plugin lifecycle actions while Core stays running remain supported.

| Action | Runtime effect | Operational data and logs | Installation setup |
| --- | --- | --- | --- |
| Start | Start Core using existing state; initialize an empty store on first use | Preserve existing state | Preserve and reapply |
| Stop | Stop Core | Preserve | Preserve |
| Restart | Stop and start Core | Preserve | Preserve and reapply |
| Reset | Stop Core, clear Atlas-owned operational state and Atlas-managed diagnostic logs, then start Core | Wipe | Preserve and reapply |

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records and temporary upload state. Reset clears Atlas-managed diagnostic logs as well as operational activity history. It does not erase unrelated host logs or files. Installed Plugin selections, credentials, configuration, installed software and Plugin artifacts survive all four actions.

This supersedes [ADR-0013](0013-start-each-core-run-with-empty-data.md). Retention is now bounded by Reset, not by the lifetime of the Core process. Data and logs must remain available after an ordinary Stop/Start or Restart. Reset stops Core before clearing the relevant stores and starts Core after cleanup. If Core is already stopped, it clears state and starts Core. Reset changes the dataset identifier before the new state is exposed. A new-release update includes this Reset behavior; the distribution and update packaging workflow remains to be designed.

Preserving records does not promise that interrupted execution automatically resumes or is retried. A Plugin crash while Core stays running follows [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md): report the outcome/fault, permit manual restart, and require explicit rerun of known failed work. Active-work recovery across a whole-Core restart is outside scope, rather than a deferred implementation requirement. Asset execution and scheduling remain the Asset OS's responsibility.

This decision does not select a storage backend. Atlas does not provide backup or restore functionality. Retaining data across ordinary restarts requires persistent storage, but no backup tooling, backup formats or restore workflows. Updating Core to a new release performs Reset: operational data and Atlas-managed logs are cleared while installation setup and Plugin artifacts survive. Ordinary restarts of the same release preserve state. Version-to-version operational-data migrations are excluded.

Each dataset has an identifier, created on first initialization, retained across Restart, and changed by Reset, including release-update Reset. The SDK detects an identifier change, discards its old synchronized picture and pending submissions, then reads fresh state. Core rejects old-dataset mutations and work submissions, including resource writes, Task instructions/reports, Plugin Operation submissions and upload writes/finalization. It also rejects replay or transfer-resume requests that use obsolete dataset cursors or handles. Health, authentication and current-dataset discovery remain available without an old-dataset match, so a client can reconnect and read a fresh snapshot. Ordinary reads do not authorize replaying old writes. The SDK checks dataset identity before accepting responses into its current picture or retrying a submission; the SDK must not silently relabel them as new submissions. This reset boundary was accepted on 21 September 2026. It does not identify an Asset process, introduce a Session resource, or promise Reset during an active mission. Exact wire placement remains implementation design.
