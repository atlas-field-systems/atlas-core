# Plugins

This page owns Plugins: what a Plugin is, Plugin capabilities and discovery, Operations and their lifecycle, independent Plugin lifecycle while Core runs, local-only Plugin administration, configuration, Plugin runtime lifetime with Core, private Plugin operational storage and uninstall, Plugin releases and compatibility, and Plugin UI contributions.

The Plugin identity and its operational access follow [Identity and access](identity-and-access.md#plugins). Tasks that Plugins create follow [Tasks](tasks.md#task-creation), and Tracks they publish follow [Entities, Tracks and Geofeatures](tracks-and-geofeatures.md#tracks). The Operation record and SDK submission helpers are in the [system design](../architecture/system-design.md#plugin-operations), and the shared host-side management module is in [local lifecycle coordination](../architecture/system-design.md#local-lifecycle-coordination). Docker deployment follows [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md), and Start, Stop, Restart, Reset and Hard Reset follow [Dataset lifecycle](dataset-lifecycle.md).

## What a Plugin is

A Plugin is an Atlas-managed extension that offers Plugin capabilities, processes Atlas data or gathers External source data. A Plugin may process Objects produced by Asset Tasks, expose Operations, or gather external data and publish Entities or Objects. It is not an Asset and is not taskable: its own processing and ingestion are Plugin work, not Tasks, under [Commands and the Command Catalog](tasks.md#commands-and-the-command-catalog).

Plugins are trusted code with broad operational access, not isolated tenants; the access rules and their limits are in [Identity and access](identity-and-access.md#plugins).

Use Plugin packaging for an internal capability only when it needs the independently managed extension lifecycle. No marketplace, automatic updates or separately operated remote Plugins are selected.

## Plugin capabilities and discovery

A Plugin capability is something a Plugin offers for invocation through Atlas. Public consumers can discover installed Plugins and their capabilities, and inspect a Plugin's release, capabilities, availability and fault status. The public Plugin resource carries no configuration secrets or management controls. Local management results, saved and active configuration and startup validation belong to the private management contract, not the public Plugin resource.

Plugin discovery and status are outside the operational picture and use their API methods in every SDK mode.

Individual Plugin failures are reported on the affected Plugin and do not make an otherwise functioning Core globally unready.

## Installation manifest and capability schemas

This specification addresses [#64](https://github.com/atlas-field-systems/atlas-core/issues/64) and the Plugin identity/lookup parts of [#76](https://github.com/atlas-field-systems/atlas-core/issues/76). It selects contracts for implementation; no container or fault scenario has passed yet.

A Plugin release is a local install bundle containing `manifest.json`, local schema files and an OCI image archive, or a manifest referencing an image already acquired by digest. Installation acquires every artifact before an offline Mission. Atlas does not select a marketplace or require registry access at runtime. The manifest has `format_version=1`, permanent `package_id`, independent SemVer `release`, immutable `image_digest`, supported public `protocol_versions`, private `dispatch_contract_versions`, configuration schema and `capabilities`. Each capability has permanent `capability_id`, explicit `input_version`, input and output schema, and optional declared cancellation support. Schemas use [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-core) with local bundle references only; no remote reference retrieval occurs during validation. A changed input contract uses a new input version. Reusing a published package/release with different bytes fails installation.

Core resolves the installed release and capability, checks supported contract versions, availability and bounded input validation before accepting a first Operation. The public submission carries `request_id`, `capability_id`, `input_version` and `input`; Core records the selected release/digest with the original input. Matching retries compare recorded original facts before checking current availability, so removing or updating a Plugin cannot turn the retry into new processing. Invalid input or an unsupported capability/version produces an explicit rejection without an Operation or dispatch. Core never executes arbitrary capability endpoint URLs supplied by the caller.

Installed capabilities and Operation input/output schemas are public discovery facts. Provider credentials and configuration values remain private. Capability discovery returns installed `plugin_id`, package/release, supported versions and availability, plus those schema identities. Plugin discovery and Operation changes use explicit API reads/polling in both SDK modes; they produce no Entity/Task/Object feed events. The SDK outcome helper polls with bounded backoff and cancellation of the local wait never cancels the Operation.

### Installation and historical identity

`plugin_id` identifies one Plugin installation, not a package or display name. Host management allocates it once as a UUID. Updates retain it; uninstall retires it; reinstall always receives a new one. Core supplies a unique `principal_id` and usable credential to the installed Plugin. Reinstall provisions fresh authority rather than reviving the old principal's revoked credentials. A release is identified by package ID, version and digest. `publisher_id` follows [publisher continuity](identity-and-access.md#publisher-continuity), independent of all those IDs.

Core preserves a nonsecret Plugin identity record with original installation ID, package/release identity and removal condition as long as Dataset Operations or attribution require it. Installation selections and working credentials retain their installation lifetimes; historical Operation ownership and snapshots belong to the Dataset and disappear at Reset. Publisher reservations/provenance retain their installation lifetime under the linked identity contract. Names can be reused without reusing IDs. Reinstall by the same publisher can continue existing Tracks only after local authority binds the new principal under the [publisher proof contract](identity-and-access.md#publisher-continuity). A matching display name supplies no proof and does not retarget existing Tasks.

`GET /plugins/{plugin_id}/operations` queries Core-owned records by that immutable installation ID even after uninstall. An unknown ID is not-found; a known historical ID with no matching Operations returns an empty page. `GET /plugins/{plugin_id}/operations/{operation_id}` first resolves the retained Operation and checks its recorded installation owner; an ID nested under another Plugin is not-found. Neither read requires a live installed container. Results include recorded package/release and `plugin_installed=false` after removal. `GET /plugins/{plugin_id}` for the retired installation returns historical identity with `availability=removed` and no callable capabilities; current discovery lists installed Plugins only. New submission against the removed ID fails `plugin_unavailable`. A reused name/new installation cannot claim or run the old Operations.

## Operations

An Operation is one submitted invocation of a Plugin capability, with its own identity, lifecycle and outcome. Each invocation is a separate Operation.

### Submission and retries

Accepted Operations have a Core-owned Operation identifier and queryable state and outcome. The SDK gives a submission a stable identity. Retrying after a lost acceptance response returns the original Operation and its current state, including Interrupted. A conflicting reuse of a submission identity fails. An explicit rerun uses a new identity and creates a new Operation.

Submission identity is scoped to the current Dataset; Reset must not turn an old retry into a new invocation. Core rejects Operation submissions from an old Dataset under the [Dataset boundary](dataset-lifecycle.md#dataset-identity-and-the-dataset-boundary). Submission retry uniqueness prevents duplicate acceptance, not arbitrary duplicate external effects.

### Durable acceptance and caller disconnection

Core commits acceptance before dispatch. Operations can run beyond an individual HTTP request: the caller can request cancellation, but disconnection does not cancel accepted work. A returning operator can obtain the result. The old request-bound invocation and universal 25-second timeout do not define this lifecycle; specific limits remain implementation choices.

### Progress and cancellation

A caller can request cancellation of an individual Operation. Cancellation remains a request until its outcome is confirmed, and progress cannot clear Cancellation requested. Cancelling an Operation is distinct from stopping its Plugin.

### Operation transitions

Operations use their own lifecycle, separate from the Task statuses even though both include cancellation-requested intent. Core owns the recorded state; Plugin reports supply execution outcomes.

| New state | Allowed previous state | Trigger |
| --- | --- | --- |
| Pending | No Operation | Core accepts the submission |
| In progress | Pending | Plugin reports processing has started |
| Cancellation requested | Pending, In progress | Core accepts an Operation cancellation request |
| Completed | Pending, In progress, Cancellation requested | A successful outcome is confirmed |
| Cancelled | Pending, In progress, Cancellation requested | Cancellation is confirmed, including Core confirming that undispatched work will not be started |
| Failed | Pending, In progress, Cancellation requested | A definitive unsuccessful outcome is confirmed |
| Interrupted | Pending, In progress, Cancellation requested | Core can no longer establish the Operation's completion or cancellation, including interrupted work at Stop/Restart or an unconfirmed outcome after Plugin loss |

Completed, Cancelled, Failed and Interrupted are terminal for that Operation; matching repeated reports have no new effect and conflicting reports cannot rewrite the terminal state. An Interrupted Operation records uncertainty, not proof that all external effects stopped or that nothing happened. Preserve confirmed outcomes and known effects before classifying remaining work as Interrupted.

At Start after Stop or Restart, Core marks unfinished Operations from the previous Core run Interrupted under [unfinished work](dataset-lifecycle.md#unfinished-work-after-stop-or-restart).

### Retained effects and outputs

A failed Operation keeps its successful Atlas resources and effects, with known outputs attributable to that Operation. Failure does not imply that nothing happened. Known outputs and effects remain available even when an Operation fails or is interrupted. Core does not automatically undo effects.

A deliberate rerun may produce additional results. Handling existing results belongs to the Plugin. Core does not promise a complete inventory of arbitrary external effects or a transaction spanning Plugin behavior and external systems.

Core retains Operations across Restart and Plugin removal until Reset. Retained Operations remain queryable even if their Plugin is later removed.

### No automatic rerun

Neither Plugin restart nor Core restart reruns an Operation automatically. Once an Operation is known to have failed, retain its failure and require an explicit operator rerun; restarting the Plugin must not automatically retry it. Starting compatible enabled Plugins with Core does not resume or rerun interrupted Operations. Recovery must not blindly reissue Asset Commands.

## Private operation dispatch and reconciliation

The private Plugin contract is versioned independently as `dispatch_contract_version=1`. It is shared with the standalone Plugin package, outside the public HTTP route generator. Core's Plugins module owns its recorded state; the Plugin owns a durable deduplication ledger in its [working directory](#private-operational-storage). The host supplies a per-installation Unix socket mount and a secret token file, following [host coordination](dataset-lifecycle.md#host-supervision-and-private-coordination). This channel exposes no Docker or Core database access.

Plugins initiate authenticated long-poll `next` requests to Core's private per-Plugin socket. Core validates an ephemeral token bound to `plugin_id`, `principal_id`, `dataset_id`, `core_run_id` and a Core-issued Plugin `runtime_generation`. The token is invalid after that runtime ends. The Plugin reports `ready` with its immutable image digest, supported versions, configuration revision and available capabilities before admission opens. A mismatch faults startup. Dispatch, cancellation, acknowledgements, progress and outcomes use the same authenticated channel and identity binding. No user-provided Plugin ID or input token establishes authority.

| Message | Required correlation and effect |
| --- | --- |
| `dispatch` | `operation_id`, original Dataset/Core run/runtime generation, package/release/digest, capability/input version, original input and `input_digest`. Core commits `dispatch_exposed` before handing the message to transport |
| `dispatch_ack` | Same Operation and input digest; confirms the Plugin durably recorded acceptance, never claims completion. Duplicate acknowledgement has no new effect |
| `progress` | Operation ID and increasing decimal-string `report_sequence`, known output resource references and bounded progress. Core records it without clearing cancellation intent |
| `outcome` | Stable sequence and terminal `completed`, `failed` or `cancelled`, typed result/error and known outputs/effects. Core replies with the recorded outcome revision after committing it |
| `cancel` | Operation ID and stable cancellation identity. Plugin returns a confirmed cancellation or eventual definitive outcome; merely receiving this message does not establish cancellation |
| `inspect` / `inspection` | Same Operation/input digest and Core run. Plugin reports durable ledger state `never_seen`, `accepted`, `running` or `terminal`, plus known outcomes. Missing/unreadable evidence is `unknown`, not `never_seen` |
| `drain` / `drained` | Stop new dispatch, stop continuous ingestion and report finite active work. Only confirmed draining allows an ordinary planned container stop |

Core durably records acceptance before exposure. Its dispatch state is `not_exposed`, `exposed`, `acknowledged` or `resolved`, separate from public Operation status. It sets exposed in a short transaction before sending any bytes. A lost acknowledgement therefore leaves possible execution, never definite nonexecution. Within the same live runtime, Core may resend the exact dispatch identity or inspect it. The Plugin writes and syncs its accepted ledger record before starting effects, writes a running marker before the first effect, and returns the existing record on repeated dispatch. The unique key is Dataset + Operation ID; a changed digest conflicts. Deduplication prevents a second execution, not duplicate arbitrary effects within one execution.

If the ledger is corrupt, missing unexpectedly, or belongs to another Dataset/run, the Plugin rejects dispatch and faults rather than treating the Operation as new. A fresh runtime reports retained evidence during readiness/reconciliation, but does not execute any old accepted/running ledger entries. Host and Core distinguish independently restarting a Plugin from reconnecting an unchanged live runtime. Only never-exposed pending work from the current Core run remains eligible for its original first dispatch after a manual Plugin restart. Previously exposed unfinished work resolves from known evidence or becomes Interrupted; it is never redispatched to the replacement runtime. Whole-Core Start makes every retained unfinished Operation Interrupted before Plugins start, even if their files remain. An explicit new submission is the rerun path.

Cancellation races on the same Core-owned Operation lock/transaction. Core may directly confirm Cancelled only if no dispatch has been exposed and it atomically disables future dispatch. If exposure committed first, cancellation stays requested until confirmed; lost acknowledgement does not permit the undispatched shortcut. A valid completion/failure racing cancellation wins according to the existing transition table. Uncertain processing becomes Interrupted, retaining known effects. A Plugin crash is a reported fault and requires manual restart; restarting neither rewrites terminal states nor reruns work.

Core validates every report against its authenticated binding, original capability version, output schema and allowed transition before committing it. Invalid output does not become a successful recorded outcome; unestablishable completion follows Interrupted rules. Known public output references must resolve to valid published resources; private filenames cannot be returned as Objects. Terminal reports remain in the Plugin ledger until Core acknowledges their committed outcome. Losing that acknowledgement retries the same report identity and payload. Core accepts an identical terminal repeat without another effect; a conflicting terminal report returns `terminal_conflict`. Lower or duplicate progress cannot regress a later recorded outcome. Once Core has classified an Operation Interrupted after runtime loss, later reports can attach known evidence but cannot rewrite its terminal status or trigger execution. The Plugin can never infer that an absent acknowledgement permits replaying external effects.

### Elevation Lookup and failure fixtures

The independent example package declares `elevation_lookup`, input version 1, using the named position and output contract in [Elevation Lookup](spatial-data.md#elevation-lookup). That page owns interpolation, fixture values, `reference_data_id`, vertical reference, invalid-coordinate, `out_of_coverage` and `no_data` outcomes. The example reads installed reference data, writes its Operation ledger in managed work and returns the expected result through this private contract; it does not create a Task or require an Object. Test barriers control dispatch/effect/report timing and do not slow the production algorithm.

| Independently scheduled sequence | Required result |
| --- | --- |
| Acceptance commits; caller disconnects; valid dispatch completes | One Operation returns the independently expected centre elevation 130 m when caller returns; no connection-owned cancellation |
| Plugin accepts dispatch; acknowledgement is lost; exact dispatch repeats | Same ledger entry and one lookup execution; inspection/ack recovers that Operation |
| Dispatch exposure commits; cancel arrives; dispatch acknowledgement is lost | Cancellation requested remains; no definite-undispatched cancellation |
| Cancel commits before exposure | Cancelled, zero dispatches and zero Plugin effects |
| Terminal report commits; acknowledgement is lost; report repeats | Same immutable outcome and one attribution, no repeated lookup |
| Completed report followed by a conflicting Failed report | Terminal conflict; Completed result retained |
| Plugin produces an output/effect then crashes before confirmed outcome | Known output retained; unresolved Operation Interrupted; manual restart does not rerun |
| Invalid coordinates, unsupported units/reference, outside coverage or declared no-data fixture | Validate inputs before acceptance where required; definitive supported coverage/no-data failures come from the capability; never return invented zero |
| Independent stop/update meets active finite work | Stop admission/ingestion and drain or explicit cancel; Core/unrelated Plugins remain serving |
| Core Restart retains unfinished record and Plugin work | Interrupted before admission; no automatic dispatch/resume; original submission retry returns that record |
| Uninstall then read old terminal/Interrupted Operation; reinstall same visible name | Old nested URL remains readable; new Plugin ID has separate Operations and no old usable credential |

## Plugin Tasks and published resources

Plugins may create Tasks for Assets through the ordinary Task API under [Task creation](tasks.md#task-creation). Plugin work is separate from the Asset Tasks that produced its input Objects. Stopping a Plugin does not alter those Tasks or their execution outcomes; Core and the assigned Asset retain their tasking responsibilities. A Plugin Operation on a scan result has its own lifecycle under [scan completion](tasks.md#scan-completion).

Plugins publish resources through Core using their Plugin identity. Operation processing may publish Objects and other operational data through the normal SDK operational APIs; Operations are not read-only. Tracks a Plugin publishes follow [one publisher per Track](tracks-and-geofeatures.md#one-publisher-per-track).

## Independent lifecycle while Core runs

Atlas owns starting and stopping installed Plugins rather than requiring the operator to run their processes separately. Core's Plugins module owns lifecycle policy and reported state, including admission, protected stopping and reported outcomes. The shared host-side management module carries out lifecycle and Docker actions under that policy.

Installing, updating, removing, enabling or disabling a Plugin must leave Core and unrelated Plugins running, without restarting Core or interrupting its APIs and Asset connections. This is independent lifecycle management, not a requirement for in-process code replacement.

Serialize management actions for each Plugin and retain their recorded outcome, including after uninstall. Plugin changes are recorded in [activity history](history.md#activity-history).

### Protecting active work

A planned Plugin stop or update stops admitting new Operations, asks continuous ingestion to stop, and waits for finite active Operations to finish or be explicitly cancelled. The continuous ingestion loop stops as part of Plugin shutdown; it is not finite work that must finish naturally. Unrelated Asset Tasks do not block Plugin management. This stopping procedure applies to independent Plugin lifecycle actions while Core stays running.

If the Plugin cannot stop cooperatively, Core reports the problem and permits an explicit operator force stop. A force stop must not be reported as successful Operation completion. Report confirmed outcomes and any uncertainty about interrupted work honestly; a stop request alone is not proof that all effects have stopped.

### Faults

After a Plugin crash while Core remains in the same run, reconcile recorded work and outcomes. For both processing Plugins and continuous-source Plugins, Core reports a fault and offers a manual restart. Core does not restart a Plugin automatically. Restarting a Plugin and rerunning a failed Operation remain separate actions. The external Command Interface can display faults.

## Local administration

Plugin installation, catalog selection, removal, updates, configuration, enable/disable, start/stop/restart and force stop are local CLI/TUI actions through private management interfaces. They have no public API endpoints or SDK methods and are outside public Protocol generation. Public API and SDK consumers can discover Plugin capabilities and status, invoke Operations, query outcomes and request Operation cancellation, but cannot manage Plugin processes.

While Core is stopped, local management may perform setup and lifecycle actions and record them as activity, but cannot accept Plugin Operations. This does not require running Plugins.

## Configuration

Plugin settings declare a schema with required fields and defaults. Core validates settings before saving them. Saving records desired configuration without restarting the Plugin.

Applying is an explicit local CLI/TUI action. For a running Plugin, it follows the [stopping procedure](#protecting-active-work), then starts the Plugin with the selected settings. Applying to a disabled Plugin validates and retains settings for its next start without enabling it; report that startup has not tested that revision.

Track saved settings, the configuration actually running, and the last startup-validated revision separately. Each settings revision is a monotonically increasing decimal string with an immutable canonical payload and private secret references. The private result carries `saved_revision`, optional `active_revision`, optional `last_working_revision`, `apply_state` and a safe error. Schema validation uses the manifest's local schema and resolves secrets privately; ordinary status never returns their values.

Saving a candidate requires its reviewed saved revision and validates the whole merged result atomically. Stale save is `version_conflict`; missing base is `precondition_required`. An explicit apply selects an existing immutable revision and obtains the per-Plugin lifecycle lock. Startup is validated only after the matching container authenticates and returns `ready` for its digest, configuration revision and capability set within 30 seconds. A timeout is a failed apply, not last-working success. Applying a disabled Plugin leaves active unchanged and returns `saved_not_started`. Restarting a container alone does not make saved configuration active. Schema validation alone does not make a revision active or last-working.

If applying settings prevents startup, Core records the failed apply and leaves the Plugin faulted. Recovery requires the local operator to explicitly restore the last working settings and restart, or correct the candidate and apply again. Core does not automatically restore settings or restart. Preserve the failed candidate and last startup-validated settings for diagnosis while the Plugin remains installed; restoration must not erase the failed attempt. If no working revision exists, the operator must supply corrected settings. A failed recovery remains faulted and requires another explicit action. Never rerun failed Operations as part of configuration recovery.

## Runtime lifetime with Core

Managed Plugins operate only while Core is running. A completed Core Stop also leaves its managed Plugins stopped; Restart and Reset stop them before bringing the installation back up. Independent Plugin start, stop and update while Core remains running stays supported.

Local management coordinates this lifetime and reports incomplete shutdown rather than claiming everything stopped. Unexpected Core loss must not leave Plugins intentionally operating as standalone services, and enforcement must not depend on an operator keeping a CLI command or TUI open. There is no instantaneous stop or automatic mission-recovery guarantee. Preserve known outcomes and classify uncertain work under [unfinished work](dataset-lifecycle.md#unfinished-work-after-stop-or-restart). Physical Assets have their own execution lifetime and are not stopped by this rule.

## Private operational storage

Each installed Plugin has an Atlas-managed working directory for its private operational state. The Plugin may keep files or a private SQLite database within it. All file-backed operational state belongs there, including pending ingestion, caches, intermediate results and private invocation records. A Plugin must not keep this state in its container's writable layer, arbitrary host paths or an unmanaged external database. In-memory work ends when its process stops.

Retained configuration, credentials and installed reference data stay outside the working directory as installation setup. For example, an installed elevation dataset survives Reset, while a queue of pending lookups or generated results does not. A Plugin cannot preserve old operational work by putting it in retained setup.

The Plugin owns the meaning and format of its private state. Host management removes whole owned work directories after stopping writers and does not query private Plugin databases or interpret their contents. Published Objects still go through the SDK and Core's Objects module; private working files do not become Objects or give a Plugin access to Core's database or Object store.

### Restart and Reset

Stop, Start and Restart preserve the working directory. Retaining private files across Restart does not authorize resuming or rerunning an Operation.

Ordinary Reset clears the working directories before Core establishes the fresh Dataset, including those of disabled or faulted Plugins and any retained work from earlier Datasets. Stopping a container alone does not clear its mounted storage. Cleanup failure and recovery follow [Interrupted Reset](dataset-lifecycle.md#interrupted-reset).

Buffered outputs and pending work belong to their original Dataset. Starting a Plugin against a new Dataset cannot resubmit old private work under fresh request identities, relabel it or republish it into the replacement Dataset. A Plugin may obtain fresh observations after Reset through its normal integration.

[Hard Reset](dataset-lifecycle.md#hard-reset) clears the working directories and Atlas-managed retained Plugin setup, credentials and installed reference data. Neither Reset nor Hard Reset undoes effects on External sources, removes unrelated host data or recalls copies held by external clients.

### Uninstall and reinstall

Uninstalling a Plugin clears its private operational working directory, saved configuration, usable credentials, downloaded reference data and owned installation artifacts after the Plugin has been stopped under the [active-work protection rules](#protecting-active-work). Published Atlas resources and Core-owned Operation records retain their own lifetimes; uninstall does not delete them or rewrite their outcomes. Removing a Plugin withdraws its capability and any UI contribution.

Host management removes or revokes usable Plugin credentials without reviving old credentials. It does not delete unrelated or shared host resources or perform side effects in an External source or provider service. Safe nonsecret failed-apply diagnostics and management outcomes keep their own history, while active or saved configuration values and secrets are removed. Core retains publisher attribution on published Tracks; continuity after reinstall follows [publisher continuity](tracks-and-geofeatures.md#publisher-continuity-after-reinstall).

The host must report incomplete cleanup and must not report uninstall success or allow a reinstall to start with partly removed state. A reinstall receives an empty working directory and may need fresh configuration, credentials and reference-data downloads. This is Plugin-scoped cleanup, not Hard Reset.

A disabled Plugin is not uninstalled: its installation state and private working state remain subject to the Restart, Reset and no-automatic-rerun rules.

## Releases and compatibility

A Plugin release is an immutable version of one Plugin that can be published and installed independently of a Core release. Coordinated Core, SDK and Protocol numbering does not include Plugins.

Before starting operational service after an update, Core validates installed Plugin compatibility and retained configuration under [ADR-0005](../adr/0005-allow-compatible-client-versions.md). It keeps incompatible Plugins installed but disabled and explains the incompatibility, and starts compatible enabled Plugins normally. Invalid configuration is reported without silent conversion.

## UI contributions

Open: any UI contribution contract. If supported, Core may expose contribution metadata or serve static assets; the external Command Interface owns rendering, navigation, map interaction and resource views. UI delivery is not a selected implementation.

## Routes and SDK operations

- Discover Plugins: `GET /plugins` and `GET /plugins/{plugin_id}` in the [Plugins routes](../api-endpoints.md#plugins), through direct API calls in every SDK mode.
- Invoke: `POST /plugins/{plugin_id}/operations`, through the SDK's Invoke Plugin Operation [operation](sdk.md#operations-catalog). It takes the capability identifier, input and Dataset-scoped submission identity and returns `202 Accepted` with the Operation identity and query URL.
- Inspect: `GET /plugins/{plugin_id}/operations` and `GET /plugins/{plugin_id}/operations/{operation_id}`, through Inspect/cancel Plugin Operation. Here `operation_id` identifies one accepted Operation, not a Plugin capability. Operation polling uses these endpoints in every SDK mode; Operations are outside the Entity, Task and Object picture.
- Cancel: `POST /plugins/{plugin_id}/operations/{operation_id}/cancel` records a cancellation request; the final outcome requires confirmation.
- Local administration has no public route or SDK method.

## Open questions

- The UI contribution contract.
- Permanent Plugin placement and combined backend and UI packaging remain [proposals](../architecture/system-outline.md).

## Decisions

- [ADR-0002](../adr/0002-core-manages-installed-plugins.md): Core manages installed Plugins with independent lifecycles, and Operations have their own identity, lifecycle and retained effects.
- [ADR-0006](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md): planned stops protect active work, faults get manual restart, and configuration recovery is manual.
- [ADR-0021](../adr/0021-manage-plugin-operational-storage-through-reset.md): private operational storage cleared by Reset and Plugin-scoped uninstall cleanup.
- [ADR-0015](../adr/0015-separate-start-stop-restart-and-reset.md): Plugins stop with Core, and unfinished Operations become Interrupted after Stop or Restart.
- [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md): one sibling Docker container per installed Plugin, with Docker control on the host.
- [ADR-0005](../adr/0005-allow-compatible-client-versions.md): installed Plugin compatibility checks after an update.
- [ADR-0001](../adr/0001-release-core-sdk-and-protocol-together.md): Plugins keep independent release versions.
- [ADR-0004](../adr/0004-core-owns-commands-and-assets-execute-tasks.md): Plugins are not Task targets, and Plugin processing is not a Task.
- [ADR-0010](../adr/0010-operate-without-internet-access.md): Plugins that use internet services keep their own external dependencies.

## Test evidence

These rows of the [required scenario coverage](../testing-strategy.md#required-scenario-coverage) apply:

- Plugin Operations: durable acceptance, disconnected callers, duplicate submission, cancellation and terminal races, Plugin loss and Core interruption.
- Plugin operational storage: Restart, Reset, cleanup failure and uninstall and reinstall.
- Reset and Restart: interrupted Operations without automatic rerun and rejection of old-Dataset submissions.
- Hard Reset and retained setup: Plugin setup kept by ordinary Reset and cleared by Hard Reset.
- Track observation ownership: same-publisher continuity after uninstall.

The [independent-extension milestone](../testing-strategy.md#core-contract-and-field-validation-milestones) requires a Plugin built in its own repository. The [MVP integration checks](../testing-strategy.md#mvp-integration-checks) exercise Elevation Lookup, Plugin lifecycle, Stop/Start and Restart, and Reset.
