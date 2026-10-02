# Dataset lifecycle

This page owns the Start, Stop, Restart, Reset and Hard Reset actions and their effects: what operational state and Installation setup each keeps, diagnostic log retention, Dataset identity and the Dataset boundary, Reset execution and recovery, unfinished work after Stop or Restart, release mismatch and release updates, Core runtime lifetime, Hard Reset, the Mission boundary and the lifecycle exclusions.

Topic-specific retention follows each topic page: [Tasks](tasks.md#terminal-outcomes-and-retention), [Objects](objects.md), [Operations](plugins.md#retained-effects-and-outputs), [Plugin private storage](plugins.md#restart-and-reset), [Asset report acceptance](asset-reporting.md), [Entity ID reservation](tracks-and-geofeatures.md#entity-id-reservation) and [retained Asset identity](identity-and-access.md#retained-asset-identity-after-reset). The module opening interface, the lifetime grouping of Core's tables and the shared host-side management module are in the system design under [Opening a Dataset](../architecture/system-design.md#opening-a-dataset), [Write commits](../architecture/system-design.md#write-commits) and [Local lifecycle coordination](../architecture/system-design.md#local-lifecycle-coordination).

## Lifecycle actions

| Action | Runtime effect | Operational data and logs | Installation setup |
| --- | --- | --- | --- |
| Start | Start Core using existing state, then start compatible enabled Plugins; initialize an empty store on first use | Preserve existing state | Preserve and reapply |
| Stop | Stop Core and all managed Plugins | Preserve | Preserve |
| Restart | Stop Core and all managed Plugins, then start Core and compatible enabled Plugins | Preserve | Preserve and reapply |
| Reset | Stop Core and all managed Plugins, clear Atlas-owned operational state and Atlas-managed diagnostic logs, then start Core and compatible enabled Plugins | Wipe | Preserve and reapply |
| Hard Reset | Stop Core and managed Plugins, clear all Atlas-managed state, then enter first-time setup | Wipe | Wipe profiles, credentials, settings and Plugin installations; retain Core software |

Restart and Reset are primarily development actions. Reset is the usual way to begin fresh; Restart preserves data and diagnostic logs for further development and inspection.

Retention is bounded by Reset rather than the Core process lifetime. If Core is already stopped, Reset still ensures managed Plugins are stopped before clearing state, then starts Core and compatible enabled Plugins.

## Operational state and installation setup

Operational state includes Entities and Tracks, Tasks, Object metadata and content, movement and activity history, Plugin Operation records, synchronization records, Task creation identities, Asset registration retry records, Entity identity reservations and deletion markers, Asset report acceptance state, required-result declarations and successful upload identity records with any deletion markers. It also includes each Plugin's Atlas-managed working directory under [private operational storage](plugins.md#private-operational-storage).

Private Dataset metadata retains the Dataset ID and writing Core release across same-release Restart and is re-established by Reset. Temporary upload files are disposable staging, cleaned after interruption or on startup under [Uploads](objects.md#uploads).

Installation setup survives Start, Stop, Restart and ordinary Reset. It includes Operator profiles and personal settings, installed Plugin selections, credentials and their creation retry records, configuration, installed software and Plugin artifacts. Profiles belong to retained installation setup; Reset clears activity history but not those profiles. Asset ID bindings, Open enrollment provenance, credentials and revocations are also installation setup under [retained Asset identity](identity-and-access.md#retained-asset-identity-after-reset), and installed Plugin reference data stays outside the working directory as [installation setup](plugins.md#private-operational-storage). [Hard Reset](#hard-reset) additionally clears installation setup.

## Diagnostic logs

Start, Stop and Restart preserve Atlas-managed diagnostic logs. Reset clears them as well as operational activity history, including any logs managed through Docker; merely restarting a container is not Reset. Reset does not erase unrelated host logs or files. Hard Reset clears all Atlas-managed logs. Local actions taken while Core is stopped follow the [local activity journal](history.md#local-actions).

## Dataset identity and the Dataset boundary

Each Dataset has an identifier, created on first initialization, retained across Restart, and changed by Reset before new state is exposed, including release-update Reset.

Core rejects old-Dataset mutations and work submissions, including resource writes, Task instructions and reports, Plugin Operation submissions and upload submissions and publication. It also rejects replay requests with obsolete Dataset cursors and upload retries with obsolete Dataset identities. The shared [write commit](../architecture/system-design.md#write-commits) enforces this rejection once for every public Dataset-bound write.

Health, authentication and current-Dataset discovery remain available without an old-Dataset match, so a client can reconnect and read a fresh snapshot. Ordinary reads do not authorize replaying old writes.

Dataset identity does not identify an Asset process, introduce a Session resource, or promise Reset during an active Mission. The SDK's detection of a changed Dataset and its discarding of old pictures and pending submissions follow [SDK Dataset Reset handling](sdk.md#dataset-reset-handling).

## Reset execution

Reset is Start with a fresh Dataset. An interruption at any point completes the Reset without serving a partially cleared Dataset or clearing it twice.

1. The host coordinator records a fresh-Dataset directive with a Reset identity on the installation mount before stopping anything.
2. It stops managed Plugins and Core.
3. With Core and all managed Plugin writers stopped, host management clears Atlas-managed diagnostic logs, the pending local activity journal and this installation's Plugin work directories. Plugin cleanup is made durable before the fresh-opening transaction can record the Reset identity; filesystem removal and the SQLite commit are separate operations.
4. Core opens every module fresh: one SQLite transaction clears all Dataset tables, establishes the new Dataset ID and records the Reset identity in Dataset metadata. Objects then removes, by ownership, content belonging to any Dataset other than the new one, so an interrupted and retried Reset cannot leave earlier content behind.
5. Core serves operational requests after every module is ready.
6. The host removes the directive only after compatible enabled Plugins have started.

The coordinator does not clear module tables itself. Each module's fresh opening follows [Opening a Dataset](../architecture/system-design.md#opening-a-dataset).

### Interrupted Reset

If Plugin work-directory cleanup fails or is interrupted, the directive is retained and Reset is reported incomplete. The fresh Dataset is not established and no Plugin work starts until cleanup succeeds. The next Start resumes that cleanup while writers remain stopped.

If the next Start finds a directive whose Reset identity is not recorded, the host completes pending cleanup before Core opens fresh. Before establishment, repeated cleanup is safe because no Plugin has started new-Dataset work.

Once Core records the Reset identity, the directive is established. If the next Start finds a directive whose Reset identity is recorded, Core opens retained so post-Reset data survives, and the host completes Plugin startup without clearing the Plugin work directories again. This preserves work created by Plugins that already started in the new Dataset, even if management was interrupted before starting the remaining Plugins or removing the directive. The host uses Core's private coordination for the establishment decision, preserving Core's exclusive access to its SQLite database.

## Unfinished work after Stop or Restart

Retention preserves evidence; it does not claim that execution continued. Stop records interrupted Core-owned work when possible. Before serving retained state on Start, Core classifies any remaining unfinished Tasks, Operations and uploads from the previous Core run through each module's [retained opening](../architecture/system-design.md#opening-a-dataset). Preserve confirmed terminal outcomes first.

| Retained work | Behavior after Start |
| --- | --- |
| Asset Tasks | Keep recorded statuses, reports and result references. Do not infer Asset success, failure or cancellation from the Core interruption, and do not automatically reissue Tasks. See [Tasks](tasks.md#terminal-outcomes-and-retention) |
| Plugin Operations | Mark unfinished Operations Interrupted under the [Operation lifecycle](plugins.md#operation-transitions). A submission retry retrieves that Operation; a rerun must be explicit |
| Partial Object uploads | Clean up abandoned private staging. Retried uploads start from the beginning; no partial-transfer resume or inspection store is required. Preserve already-published Objects and successful upload identity records. See [Uploads](objects.md#uploads) |

Retained records do not authorize automatic resumption or rerun. A Plugin crash while Core remains running follows [Plugin faults](plugins.md#faults); Asset execution remains the Asset OS's responsibility.

This classification supports retained development records, not active Mission recovery or a promise to drain all work before Stop. Whole-Core interruption does not add a Task status. Reset clears these records with the rest of operational state.

## Release mismatch and release updates

Core stores the writing Core release with the Dataset. Ordinary Start checks it before serving operational data. A mismatch refuses startup with a clear instruction to use the explicit update and Reset flow; it never silently wipes, migrates or reinterprets retained data. First initialization and Reset establish a Dataset for the running release. Same-release restarts retain state.

A new-release update includes Reset. After an update, installed Plugin compatibility and retained configuration are checked under [Releases and compatibility](plugins.md#releases-and-compatibility). This release check is separate from [compatible client versions](../adr/0005-allow-compatible-client-versions.md).

## Runtime lifetime

Managed Plugins operate only while Core is running. Their stopping with Core, independent lifecycle while Core stays running, incomplete shutdown and unexpected Core loss follow [Runtime lifetime with Core](plugins.md#runtime-lifetime-with-core).

## Hard Reset

Hard Reset is a distinct action in the local CLI/TUI that can be invoked while Atlas is running or while it is stopped. It removes all Atlas-managed state and returns the installation to first-time setup. It has no public HTTP endpoint or SDK operation. Ordinary Reset continues to preserve installation setup and Operator profiles.

### Scope

Hard Reset clears the Dataset and its protected Task results, Object content and staging, all histories and logs, all retry and identity records, Operator profiles and personal settings, administrative, Asset, Plugin and gateway credentials, enrollment authorization material, Core and Plugin configuration, installed Plugin selections, managed Plugin containers, private Plugin data and downloaded Plugin artifacts. It clears Atlas-managed Docker logs and storage too.

Cleanup is scoped to this Atlas installation's owned resources; it does not prune unrelated containers, shared images, host files or external services. The Core executable or container image and the local management tool remain so Atlas can run first-time setup again. Copies already downloaded to external clients are outside this local action.

### Confirmation and stopping

The CLI/TUI identifies the target installation and requires an explicit destructive-action confirmation. Once confirmed, a local coordinator stops accepting requests, closes live connections, disables automatic container restart and stops Core and managed Plugin writers before cleanup. Hard Reset deliberately discards their unfinished work rather than waiting for successful Task or Operation completion. It does not send a stop command to physical Assets or guarantee their behavior; field use still requires the operator to manage those Assets separately.

### Coordinator and failures

The coordinator must remain able to finish cleanup after Core stops, and runs on the host under [Local lifecycle coordination](../architecture/system-design.md#local-lifecycle-coordination). It is serialized against other lifecycle and configuration actions. It records that cleanup is in progress outside the data being removed, and blocks ordinary startup until it finishes.

On failure or coordinator interruption, serving stays disabled and the incomplete cleanup is reported; rerunning or resuming the local action completes the remaining cleanup. Hard Reset does not claim success while any required target remains uncleared. The progress marker is removed after successful cleanup; Atlas retains no pre-reset activity or log archive.

### After cleanup

Hard Reset returns to local first-time setup without automatically restoring old settings, Plugins or credentials. Fresh setup authorization and a new Dataset are provisioned before operational service is enabled. Old credentials, connections, Dataset submissions and retry records cannot authorize or repopulate the fresh installation. Operator profiles start empty.

## Missions

Core remains available throughout a Mission. Restart, Reset and release updates happen outside Missions, with Assets no longer participating. The [field workflow](../architecture/operating-model.md#field-workflow) describes the surrounding operating assumptions.

Active Mission continuity across a whole-Core restart is excluded. Atlas does not require reattachment of executing Assets, resumption of Plugin Operations or continuation of uploads after Core restarts. An unexpected Core failure is outside that continuity guarantee; this assumption does not require fault tolerance or automatic recovery.

## Exclusions

Backup and restore functionality and version-to-version operational-data migrations are excluded. Persistent storage uses the [selected stack](../adr/0016-use-go-sqlite-and-openapi-tooling.md) and [Docker mount layout](../adr/0017-deploy-core-and-plugins-as-docker-containers.md#storage-and-scope).

## Routes and local actions

- Start, Stop, Restart, Reset and Hard Reset are local CLI/TUI actions through the shared management implementation under [Local administration](../architecture/system-design.md#local-administration). They have no public endpoint or SDK lifecycle method.
- `GET /health` in [Health and documentation](../api-endpoints.md#health-and-documentation), authentication and current-Dataset discovery remain available across a Dataset change.
- The SDK handles a Dataset change under [SDK Dataset Reset handling](sdk.md#dataset-reset-handling).

## Open questions

- Exact wire placement of the Dataset identity and the current-Dataset discovery binding.
- Distribution and update packaging for the new-release update flow.
- Exact CLI spelling, TUI layout, private coordination and Hard Reset cleanup ordering.
- Volume names, mount layout and log-cleanup mechanics.

## Decisions

- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): separate Start, Stop, Restart, Reset and Hard Reset, with retention bounded by Reset, Dataset identity, release-update Reset and no whole-Core Mission continuity.
- [ADR-0021](../adr/0021-manage-plugin-operational-storage-through-reset.md): Reset clears Plugin working directories before the fresh Dataset is established.
- [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md): mounted storage separated by lifetime and a host-side coordinator for Reset and Hard Reset.
- [ADR-0005](../adr/0005-allow-compatible-client-versions.md): compatibility checks after an update, separate from the writing-release check.
- [ADR-0013](../adr/0013-start-each-core-run-with-empty-data.md) and [ADR-0003](../adr/0003-retain-durable-activity-history.md): superseded by ADR-0015.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Reset and Restart: old-Dataset rejection in every mode, retained records after Restart, writing-release mismatch refusal and interrupted Operations without automatic rerun.
- Hard Reset and retained setup: setup kept by ordinary Reset, Hard Reset while Core and Plugins run, and interrupted cleanup that blocks startup until resumed.
- Plugin operational storage: Reset cleanup, cleanup failure and recovery.

[Fault and bandwidth testing](../testing-strategy.md#fault-and-bandwidth-testing) adds Dataset opening: crash-then-open recovery per module and Reset interrupted at each step, completed by the next Start without leaving earlier content or clearing post-Reset data. The [MVP integration checks](../testing-strategy.md#mvp-integration-checks) exercise Stop/Start and Restart, and Reset.
