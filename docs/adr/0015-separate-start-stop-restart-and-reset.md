---
status: accepted
---

# Separate Start, Stop, Restart, Reset and Hard Reset

The user revised the lifecycle on 21 September 2026. Start, Stop and Restart preserve operational data and logs. Reset clears them. Restart and Reset are primarily development actions. Reset is the usual way to begin fresh; Restart preserves data and diagnostic logs for further development and inspection.

Under the [field operating model](../architecture/operating-model.md#field-workflow), Core remains available throughout the mission. Restart, Reset and release updates happen outside it, with Assets no longer participating; temporary radio disconnection does not end the mission.

Active mission continuity across a whole-Core restart is excluded. Do not require reattachment of executing Assets, resumption of Plugin attempts or continuation of uploads after Core restarts. An unexpected Core failure is outside that continuity guarantee; this assumption does not require fault tolerance or automatic recovery. Independent Plugin lifecycle actions while Core stays running remain supported.

| Action | Runtime effect | Operational data and logs | Installation setup |
| --- | --- | --- | --- |
| Start | Start Core using existing state; initialize an empty store on first use | Preserve existing state | Preserve and reapply |
| Stop | Stop Core | Preserve | Preserve |
| Restart | Stop and start Core | Preserve | Preserve and reapply |
| Reset | Stop Core, clear Atlas-owned operational state and Atlas-managed diagnostic logs, then start Core | Wipe | Preserve and reapply |
| Hard Reset | Stop Core and managed Plugins, clear all Atlas-managed state, then enter first-time setup | Wipe | Wipe profiles, credentials, settings and Plugin installations; retain Core software |

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records, Task creation identities, Asset registration retry records, Entity identity reservations/deletion markers, Asset report acceptance state, required-result declarations and successful upload identity records with any deletion markers. Private Dataset metadata retains the Dataset ID and writing Core release across same-release Restart and is re-established by Reset. Temporary upload files are disposable staging, cleaned after interruption or on startup under ADR-0009. Reset clears Atlas-managed diagnostic logs as well as operational activity history. It does not erase unrelated host logs or files. Operator profiles and personal settings, installed Plugin selections, credentials and their creation retry records, configuration, installed software and Plugin artifacts survive Start, Stop, Restart and ordinary Reset. Profiles belong to retained installation setup; Reset clears activity history but not those profiles. Hard Reset additionally clears installation state as defined below.

This supersedes [ADR-0013](0013-start-each-core-run-with-empty-data.md). Retention is bounded by Reset rather than the Core process lifetime. If Core is already stopped, Reset clears state and starts Core. A new-release update includes Reset; distribution and update packaging remain to be designed.

Retained records do not authorize automatic resumption or rerun. A Plugin crash while Core remains running follows [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md); Asset execution remains the Asset OS's responsibility.

Persistent storage uses the [selected stack](0016-use-go-sqlite-and-openapi-tooling.md) and [Docker mount layout](0017-deploy-core-and-plugins-as-docker-containers.md). Backup and restore functionality and version-to-version operational-data migrations are excluded. New-release updates perform Reset; same-release restarts preserve state.

## Core and Plugin runtime lifetime

Clarified on 23 September 2026: managed Plugins operate only while Core is running. A completed Core Stop also leaves its managed Plugins stopped; Restart and Reset stop them before bringing the installation back up. Independent Plugin start/stop/update while Core remains running stays supported. Starting compatible enabled Plugins with Core does not resume or rerun interrupted Operations.

Local management coordinates this lifetime and reports incomplete shutdown rather than claiming everything stopped. Unexpected Core loss must not leave Plugins intentionally operating as standalone services; detection and shutdown mechanisms remain engineering work, with no instantaneous stop or automatic mission-recovery guarantee. Preserve known outcomes and classify uncertain work under [unfinished work](#unfinished-work-after-stop-or-restart). Physical Assets have their own execution lifetime and are not stopped by this Plugin rule.

Local administration may still run while Core is stopped to perform setup, lifecycle actions and their activity recording. That capability does not require running Plugins or permitting offline Plugin Operations.

## Hard Reset

Accepted on 23 September 2026: provide a distinct Hard Reset action in the local CLI/TUI that can be invoked while Atlas is running, or while it is stopped. It removes all Atlas-managed state and returns the installation to first-time setup. It has no public HTTP endpoint or SDK operation. Ordinary Reset continues to preserve installation setup and Operator profiles.

Hard Reset clears the Dataset and its protected Task results, Object content and staging, all histories and logs, all retry/identity records, Operator profiles and personal settings, administrative and Asset/Plugin credentials, enrollment authorization material, Core and Plugin configuration, installed Plugin selections, managed Plugin containers, private Plugin data and downloaded Plugin artifacts. Clear Atlas-managed Docker logs and storage too. Scope cleanup to this Atlas installation's owned resources; do not prune unrelated containers, shared images, host files or external services. Keep the Core executable/container image and local management tool so Atlas can run first-time setup again. Copies already downloaded to external clients are outside this local action.

The CLI/TUI identifies the target installation and requires an explicit destructive-action confirmation. Once confirmed, a local coordinator stops accepting requests, closes live connections, disables automatic container restart and stops Core and managed Plugin writers before cleanup. Hard Reset deliberately discards their unfinished work rather than waiting for successful Task or Operation completion. It does not send a stop command to physical Assets or guarantee their behavior; field use still requires the operator to manage those Assets separately.

The coordinator must remain able to finish cleanup after Core stops. Serialize it against other lifecycle/configuration actions. Record that cleanup is in progress outside the data being removed, and block ordinary startup until it finishes. On failure or coordinator interruption, leave serving disabled and report the incomplete cleanup; rerunning or resuming the local action completes the remaining cleanup. Do not claim success while any required target remains uncleared. The progress marker is removed after successful cleanup; no pre-reset activity/log archive is retained by Atlas.

After cleanup, return to local first-time setup without automatically restoring old settings, Plugins or credentials. Provision fresh setup authorization and a new Dataset before enabling operational service. Old credentials, connections, Dataset submissions and retry records cannot authorize or repopulate the fresh installation. Operator profiles start empty. Exact CLI spelling, TUI layout, coordinator placement and cleanup ordering remain implementation details.

## Dataset boundary

Each dataset has an identifier, created on first initialization, retained across Restart, and changed by Reset before new state is exposed, including release-update Reset. The SDK detects an identifier change, discards its old synchronized picture and pending submissions, then reads fresh state. Core rejects old-dataset mutations and work submissions, including resource writes, Task instructions/reports, Plugin Operation submissions and upload submissions/publication. It also rejects replay requests with obsolete dataset cursors and upload retries with obsolete Dataset identities. Health, authentication and current-dataset discovery remain available without an old-dataset match, so a client can reconnect and read a fresh snapshot. Ordinary reads do not authorize replaying old writes. The SDK checks dataset identity before accepting responses into its current picture or retrying a submission; the SDK must not silently relabel them as new submissions. This reset boundary was accepted on 21 September 2026. It does not identify an Asset process, introduce a Session resource, or promise Reset during an active mission. Exact wire placement remains implementation design.

### Retained Asset identity after Reset

An Asset ID bound to a retained authenticated principal remains reserved to that principal at installation scope, independently of Dataset-scoped Entity reservations. Ordinary Reset clears its operational Entity and registration records but retains this binding with the credentials. Creating any Entity under that ID must check the retained binding; a replacement principal, Track or Geofeature cannot claim it. Re-registering the same Asset requires proof of the surviving bound identity as well as current enrollment authorization, a fresh Dataset and a new registration request. It reuses that principal without reviving revoked credentials or restoring old operational state. If the Asset cannot prove that identity, use a new Asset ID through authorized enrollment rather than reassigning the retained ID.

Commit the binding check with registration and serialize it against credential provisioning/revocation. Retain bindings even for revoked principals until Hard Reset; credential revocation or ordinary Reset cannot free an ID for another principal. Hard Reset clears bindings and all credentials together. Reading the new Dataset ID is not proof of Asset identity and does not authorize re-registration or relabeling an old report.

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
