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
| Reset | Clear Atlas-owned operational state and logs | Wipe | Preserve |

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records and temporary upload state. Reset clears Atlas-managed diagnostic logs as well as operational activity history. It does not erase unrelated host logs or files. Installed Plugin selections, credentials, configuration, installed software and Plugin artifacts survive all four actions.

This supersedes [ADR-0013](0013-start-each-core-run-with-empty-data.md). Retention is now bounded by Reset, not by the lifetime of the Core process. Data and logs must remain available after an ordinary Stop/Start or Restart. Reset must clear the relevant stores consistently before the cleared state is used.

Preserving records does not promise that interrupted execution automatically resumes or is retried. A Plugin crash while Core stays running follows [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md): report the outcome/fault, permit manual restart, and require explicit rerun of known failed work. Active-work recovery across a whole-Core restart is outside scope, rather than a deferred implementation requirement. Asset execution and scheduling remain the Asset OS's responsibility.

This decision does not select a storage backend. Atlas does not provide backup or restore functionality. Retaining data across ordinary restarts requires persistent storage, but no backup tooling, backup formats or restore workflows. Updating Core to a new release performs Reset: operational data and Atlas-managed logs are cleared while installation setup and Plugin artifacts survive. Ordinary restarts of the same release preserve state. Version-to-version operational-data migrations are excluded. A development client reconnecting after Reset must not show stale cached data or silently replay pre-Reset writes into the cleared state. Define that reset/startup boundary without promising Reset during an active mission or adopting a particular generation-token mechanism.
