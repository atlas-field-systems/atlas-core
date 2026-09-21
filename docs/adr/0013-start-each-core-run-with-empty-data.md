---
status: accepted
---

# Start each Core run with empty data

Atlas data is disposable and confined to one Core run. Every Core start, including after an update or a process restart, starts with empty operational state; restart and reset are one behavior, with no preserve-data restart mode. The user explicitly selected this assumption to remove cross-run data preservation, migration and recovery complexity.

This supersedes cross-run retention in [ADR-0003](0003-retain-durable-activity-history.md) and the earlier architecture notes. Entities and Tracks, Tasks, Object metadata and content, Plugin Operation records, movement/activity history, synchronization records and temporary uploads belong to the current run and are wiped on restart. Current-run state still supports disconnected clients and Assets while Core stays running.

Modules define how to initialize their current schema and state from empty storage; they do not provide version-to-version data migrations. Core startup must clear old operational state across its stores before exposing the new run. The operating assumption is that Core does not restart while Assets are running. A restart ends the operating session and participating clients begin fresh for the next session. Same-run reconnection remains supported; seamless cross-restart continuation and automatic reconciliation of prior-run reports are outside scope. This clarification replaces the earlier requirement for Protocol/SDK run-identity detection and stale-state reconciliation across restarts. No run-identity mechanism is required by this design. Asset operating-system execution policy remains outside this contract.

Correctness within a run still matters: valid state transitions, coherent changes and usable Object content remain requirements. They do not imply cross-restart durability, backup/restore, data recovery or export/archive machinery.

Restarting an individual Plugin, disconnecting an Asset or closing the Command Interface does not restart Core or wipe its current run. Installed Plugin selections, credentials and configuration survive as startup setup. Reset only Atlas-owned operational stores and working data; preserve startup setup, installed software and Plugin artifacts. Starting a new run reapplies that setup without restoring the previous run's Tasks, Objects or history.
