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

Plugin installation, catalog selection, removal, updates, configuration, enable/disable, start/stop/restart and force stop are local CLI/TUI actions through private management interfaces. They have no public API endpoints or SDK methods and are outside public Protocol generation. Public API and SDK consumers can discover Plugin capabilities and status, invoke Operations, query outcomes and request Operation cancellation, but cannot manage Plugin processes. This supersedes the earlier Command Interface Plugin restart action.

While Core is stopped, local management may perform setup and lifecycle actions and record them as activity, but cannot accept Plugin Operations. This does not require running Plugins.

## Configuration

Plugin settings declare a schema with required fields and defaults. Core validates settings before saving them. Saving records desired configuration without restarting the Plugin.

Applying is an explicit local CLI/TUI action. For a running Plugin, it follows the [stopping procedure](#protecting-active-work), then starts the Plugin with the selected settings. Applying to a disabled Plugin validates and retains settings for its next start without enabling it; report that startup has not tested that revision.

Track saved settings, the configuration actually running, and the last startup-validated revision separately. Schema validation alone does not make a revision active or last-working.

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

- Private Docker-control coordination, installation metadata and manifest, distribution and invocation fields.
- Operation envelopes, private local management outcomes, and live notification behavior for Operations and Plugin discovery and status.
- Configuration schema format, startup success criteria and detailed reporting of saved, active, failed and last working settings.
- Implementation choices: shutdown deadlines and outcome fields for stopping and force stop, detection and shutdown mechanisms after unexpected Core loss, and exact working-directory mount paths and how the Plugin receives them.
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

The [independent-extension milestone](../testing-strategy.md#core-contract-and-field-validation-milestones) requires a Plugin built in its own repository. The [MVP integration checks](../architecture/system-design.md#mvp-integration-checks) exercise Elevation Lookup, Plugin lifecycle, Stop/Start and Restart, and Reset.
