---
status: accepted
---

# Separate Start, Stop, Restart and Reset

The user revised the lifecycle on 21 September 2026. Start, Stop and Restart preserve operational data and logs. Reset clears them. Reset is the usual way to begin fresh; Restart is mainly useful during development when retaining data and diagnostic logs matters.

| Action | Runtime effect | Operational data and logs | Installation setup |
| --- | --- | --- | --- |
| Start | Start Core using existing state; initialize an empty store on first use | Preserve existing state | Preserve and reapply |
| Stop | Stop Core | Preserve | Preserve |
| Restart | Stop and start Core | Preserve | Preserve and reapply |
| Reset | Clear Atlas-owned operational state and logs | Wipe | Preserve |

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records and temporary upload state. Reset clears Atlas-managed diagnostic logs as well as operational activity history. It does not erase unrelated host logs or files. Installed Plugin selections, credentials, configuration, installed software and Plugin artifacts survive all four actions.

This supersedes [ADR-0013](0013-start-each-core-run-with-empty-data.md). Retention is now bounded by Reset, not by the lifetime of the Core process. Data and logs must remain available after an ordinary Stop/Start or Restart. Reset must clear the relevant stores consistently before the cleared state is used.

Preserving records does not promise that interrupted execution automatically resumes or is retried. A Plugin crash while Core stays running follows [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md): report the outcome/fault, permit manual restart, and require explicit rerun of known failed work. Detailed handling of active work during a whole-Core restart remains an implementation-planning question. Asset execution and scheduling remain the Asset OS's responsibility.

This decision does not select a storage backend. Atlas does not provide backup or restore functionality. Retaining data across ordinary restarts requires persistent storage, but no backup tooling, backup formats or restore workflows. Updating Core to a new release performs Reset: operational data and Atlas-managed logs are cleared while installation setup and Plugin artifacts survive. Ordinary restarts of the same release preserve state. Version-to-version operational-data migrations are excluded. Existing-client handling of Reset must not silently repopulate cleared state; the mechanism remains to be designed.
