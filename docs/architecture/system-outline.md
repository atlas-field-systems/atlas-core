# Core system outline

Status: working architecture outline. The repository/system separation, Entities/Tasks/Objects API pillars, and shared release are established directions. The seven responsibility groups below are the current draft; their internal subsystems and code layout remain under discussion. The shared release is recorded in [ADR-0001](../adr/0001-release-core-sdk-and-protocol-together.md).

The [operating model](operating-model.md) describes who uses Atlas, where work runs, and what disconnection means. The [system design](system-design.md) defines dedicated Atlas responsibilities, shared utilities, SDK usage modes, minimal generation customization and independent testing. [ADR-0014](../adr/0014-build-dedicated-atlas-systems.md) supersedes the infrastructure-first direction.

## What is decided

The Atlas Core repository contains several related deliverables. The Atlas Core system will live in an `Atlas Core/` folder, with Protocol and SDK in sibling folders. The exact sibling folder names are not selected. The Command Interface is outside the Atlas Core system and that folder; its eventual repository placement is not decided here. A coordinated release publishes Core, SDK and Protocol at the same version, including an unchanged SDK or Protocol.

| Release | Core | SDK | Protocol |
| --- | --- | --- | --- |
| Example release | 0.1.6 | 0.1.6 | 0.1.6 |
| Next example, only Core behavior changes | 0.1.7 | 0.1.7 | 0.1.7 |

These are examples, not existing releases. The number identifies a matching published set; it does not imply that every version changes every contract or that clients must always run the server's exact version.

One server with field devices is the first deployment target, typically coordinating a local area for a few hours per run. Core starts before Assets connect and stays running throughout the mission. Restart and Reset are primarily development actions outside missions; ordinary restarts retain data but active execution continuity across them is outside scope. An installed system [operates without internet access](../adr/0010-operate-without-internet-access.md), and [Start, Stop and Restart preserve data/logs while Reset clears them](../adr/0015-separate-start-stop-restart-and-reset.md). Updates to a new Core release perform Reset; operational-data migrations are excluded and backup and restore functionality is excluded. Breaking changes during the extraction are allowed when they simplify the system. Temporary mission capabilities must be able to live in separate repositories and be removed. Using the same extension mechanism for permanent capabilities and bundling server behavior with Plugin UI are promising proposals from the discussion, not yet accepted implementation choices.

Further product decisions are accepted: [Core manages installed Plugin lifecycles](../adr/0002-core-manages-installed-plugins.md), and [Core retains activity history until Reset](../adr/0015-separate-start-stop-restart-and-reset.md) for Task issuance/cancellation and changes to Plugins, credentials and configuration. [Core owns Commands and only Assets execute Tasks](../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or gather external sources. [Compatible client versions are allowed](../adr/0005-allow-compatible-client-versions.md), and [planned Plugin stops and updates protect active work](../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md).

Operators can [issue and cancel Tasks while an Asset is disconnected](../adr/0007-reconcile-asset-tasks-after-disconnection.md). At check-in the Asset reports completed work and reconciles its onboard queue with current Core instructions. Preserve the seven main Task statuses: Pending, Acknowledged, In progress, Cancellation requested, Completed, Canceled and Failed. A [scan reaches Completed only when its required result is available](../adr/0008-complete-scan-tasks-when-required-results-are-available.md). Separate Asset-provided progress details can explain the work underway without adding main statuses; their contract remains to be designed. Completion can be recorded while cancellation remains unconfirmed and required results are ready. Once Canceled is confirmed, the Task stays Canceled. Preserve the cancellation attempt in activity history.

Plugin Operations continue when the operator closes or disconnects the Command Interface. Plugin detections appear directly in the shared picture; there is no required review-and-publish layer.

## Define responsibilities separately from release artifacts

For this planning exercise, a module owns a coherent responsibility behind an explicit interface. A subsystem is an internal part of that responsibility that deserves separate planning. Neither name automatically means another repository, process, package, container or release.

The SDK and Protocol are shared deliverables across those responsibilities. For example, the Tasks module owns Task lifecycle rules, has corresponding Protocol messages, exposes methods through the sibling SDK, and is consumed by external command-interface views. Those are different implementations or representations of the same responsibility, not four competing owners of Task behavior.

A Plugin is a packaging and extension choice for a capability. A permanent capability can use that mechanism too. Its lifetime alone does not determine whether it belongs inside the base server or in a Plugin. Small helpers inside a capability do not need their own Plugin lifecycle.

## Atlas Core responsibility map

Entities, Tasks and Objects remain the three primary API pillars. Supporting modules provide shared capabilities without taking ownership of those resources.

| Module | Responsibility | Candidate subsystems | Ownership limit |
| --- | --- | --- | --- |
| Entities | Assets, Tracks and Geofeatures: identity, current state, observations, relationships and movement history until Reset | Resource lifecycle, reporting/check-in, queries, movement history | Owns Entity identity and observed state, not authentication credentials or work execution |
| Tasks | Requests for Assets to execute Core-defined Commands: assignment, delivery, progress, cancellation and outcomes | Current Task instructions and delivery, Command/target validation, reporting-Asset checks, outcome reconciliation, lifecycle transitions | Core owns Command semantics and recorded Task lifecycle; the Asset operating system owns scheduling, queue order, execution and interruption. Plugins are never Task targets; Plugins may initiate Tasks through the SDK using existing Core-defined Commands |
| Objects | Operational information and results: metadata, content, references and provenance | Metadata lifecycle, private content storage, resumable uploads, downloads, integrity and Reset cleanup | Exposes Objects only when ready through SDK/Core APIs; hides physical storage locations and does not own each Plugin's specialized processing or result format |
| Plugins | How permanent or temporary extensions attach to Core and how Core manages installed Plugins | Registration/discovery, configuration, compatibility, Operations, managed processing/ingestion, starting/stopping and availability | Uses Identity and access for authorization and existing APIs to read Objects or publish data; owns Plugin work separately and does not render UI |
| Identity and access | Caller identity and authenticated access | Operator identity and sessions, device/Plugin credentials, enrollment, credential revocation | Every authenticated operator has full control; no operator roles or permission tiers. Asset credentials identify the reporting Asset; Plugin credentials allow operational access but not administration. Core enforces these fixed boundaries |
| Synchronization | How external clients obtain a current view and recover missed changes | Snapshots, committed-change publication, subscriptions, replay and retention | Supports Asset check-in reconciliation with Tasks. Server-side behavior only in this folder. Opt-in client caches, reconnect logic and shared-picture synchronization belong in the sibling SDK; basic SDK API access does not require them |
| System operations | How Core starts, stops, restarts, resets, is configured and observed | Startup/shutdown, configuration, health, diagnostics, activity history, maintenance coordination, explicit Reset and first-use initialization | Does not turn every maintenance job into an operator Task or make Core its own release publisher |

These are responsibility groups, not seven required services, containers, packages or final subfolder names. Subsystems should be introduced when they make a module's ownership and interface clearer.

The external Command Interface owns its application shell, navigation, map interaction, resource views and Plugin UI rendering. Its sidebar will include a Plugins menu for Plugin status, faults and a restart action; Core supplies the state and management API. If a Plugin ships UI, Core may expose its contribution metadata or serve its static assets. That delivery choice does not make the browser application's implementation a Core module. The interface between the two hosts remains to be designed.

Protocol owns shared public contracts, including operations and observable guarantees, and SDK owns client implementations. Suitable bindings and repeated representations are generated; Core and SDK behavior stays explicitly implemented. Those deliverables remain siblings even though they are developed and released with Core. Device-side runtimes and radio/communication implementations are also outside this Core responsibility map unless a later requirement explicitly puts part of them on the server.

## Gap check

The seven groups cover the current workflows. The review found responsibilities that need explicit owners, but no demonstrated need for another top-level domain module yet.

| Responsibility that could otherwise be missed | Proposed home and constraint |
| --- | --- |
| API serving, request limits, validation and error mapping | Core's shared API infrastructure, with routes and domain behavior owned by the corresponding module. Protocol defines the external contracts |
| Runtime storage, transactions and initialization | Storage preserves existing state on ordinary startup, initializes empty stores on first use, and clears operational state on Reset. Entities, Tasks, Objects and other owners define their own state rules; a generic storage module must not become a second business-rule owner |
| Atomic resource changes and published events | A write-owning module commits the mutation and its change record together. Synchronization distributes committed records; it must not independently invent resource state |
| Startup, background loops and orderly shutdown | System operations coordinates lifetimes. Each module owns the job's meaning, retry rules and limits. Cleanup and health polling are not automatically Atlas Tasks |
| Device presence and report authority | Entities records observations such as last report. Identity and access authenticates the Asset; Tasks accepts its execution reports only for Tasks assigned to that Asset. Presence is not execution readiness, and neither runtime registration nor a readiness gate is prescribed |
| Plugin configuration and secrets | Plugins owns extension-specific settings and validation; System operations supplies configuration/secret-loading facilities; Identity and access owns Atlas credentials and access checks. Provider-specific authentication belongs with the integration |
| External-source access policy | Keep source meaning in its integration. Trusted Plugins may receive their integration's provider credentials. Credential brokering and shared access controls are optional when an integration needs them; no separate Gateway or universal secret-isolation promise is required |
| Runtime data and restart | Start, Stop and Restart preserve operational state and logs. Reset stops Core, clears operational metadata, content, history and Atlas-managed diagnostic logs, then starts Core. System operations coordinates clearing across stores while preserving setup, installed software and Plugin artifacts. Removing a Plugin does not by itself reset data |
| Activity history | Required record retained until Reset of Task issuance/cancellation and changes to Plugins, credentials and configuration. Proposed placement: System operations owns the shared recording/query facility; Identity and access supplies actor identity; the owning modules supply action meaning and affected resources. The external Command Interface can render it. Diagnostic logs are separate |
| System installation, updates and shared release | Core needs health, shutdown, retained-state startup and Reset support. Host installation tools and the coordinated Core/SDK/Protocol publishing workflow may live elsewhere in the repository; they are not all code running inside Core |

Configuration, observability, API infrastructure and runtime storage do not need independent top-level modules simply because every module uses them. Start with small shared facilities and clear ownership, then split only when their behavior warrants it.

## Consequences of the lifecycle and history decisions

Plugins owns the policy for starting and stopping installed extensions and reports their state. Installing, updating, removing, enabling and disabling a Plugin must leave Core APIs, Asset connections and unrelated Plugins running without restarting Core. System operations provides any shared runtime lifecycle facilities. Planned stops and updates cease new admission and stop ingestion, then let finite work finish or be explicitly canceled. An uncooperative Plugin can be explicitly force-stopped without reporting successful completion. A Plugin crash while Core remains running requires outcome reconciliation; execution continuity across a whole-Core restart is outside scope. Core reports Plugin faults and supports manual restart for both processing and continuous-source Plugins. A known failed Plugin Operation requires an explicit operator rerun; restarting the Plugin does not automatically retry it. Asset Tasks and Plugin Operations have separate lifecycles. The process/container mechanism is undecided; keeping that mechanism behind an interface does not transfer Plugin policy out of the Plugins module.

Activity history is proposed as a subsystem of System operations, not an eighth top-level module. Its useful record includes the actor, action, target, time and outcome, with exact fields still to be designed. Tasks, Plugins, Identity and access, and configuration management must supply their own action meaning. The shared facility must not infer business actions from diagnostic log strings.

Record activity consistently with the action and preserve it across Stop/Start and Restart. Reset clears both operational activity history and Atlas-managed diagnostic logs. Store credential identifiers and safe change descriptions rather than passwords, tokens or secret configuration values. The precise recording mechanism remains to be designed.

## Define each module with the same short brief

For each candidate, settle:

1. The user or system capability it provides, with one concrete workflow.
2. The state, rules and decisions it alone owns.
3. Its public interface, including failure and cancellation behavior.
4. The other modules it calls and the information it exchanges with them.
5. Its internal subsystems, only where these make independent planning useful.
6. The behavior it explicitly does not own.
7. Whether it belongs in the base system, a standard Plugin or an optional Plugin. Decide this after understanding its responsibility.
8. One end-to-end acceptance scenario, including shutdown or removal if applicable.

Protocol fields and SDK methods should follow from these briefs. Package names and implementation technologies come after the ownership decisions.

## Walk the boundaries with a real example

Use a specialized signal processor with its own configuration view and visualization:

- Plugins starts and stops the installed capability and makes it and any supported UI contribution metadata discoverable to external clients.
- Identity and access authenticates the operator, who has full control, and identifies the Plugin. The Plugin credential permits operational APIs and cross-source data, including Task issuance, but not credential management or system administration. Asset execution reports require the assigned Asset's authenticated identity.
- The operator tasks an Asset to scan an area using a Core-defined Command. Tasks owns that Task and its lifecycle; the Asset executes it.
- The output depends on the Asset. An Asset with a software-defined radio and antenna produces an Object containing the scan data as its Task result.
- Separately, the operator invokes a Plugin Operation with that Object as input. The Plugin processes the scan data and returns a result. It owns the specialized algorithm and format; this processing is not the Asset scan Task.
- The scan Task can complete before the processing Operation is invoked. The Plugin does not initiate the scan in this example.
- Objects holds retained reports and result artifacts. Plugin detections published as Entities enter the shared picture directly without an operator review-and-publish step.
- Synchronization makes committed changes available to interested clients. The Plugin's UI presents the specialized result through supported command-interface contribution points.
- A planned stop or update waits for active Plugin work to finish or be explicitly cancelled. Removing it withdraws its capability and any UI contribution. The scan Task retains its recorded outcome; retained data follows its own retention policy.
- Task issuance/cancellation and Plugin management changes contribute actor-attributed records to activity history retained until Reset.

Area/building searches can instead be direct Plugin Operations that return results. An external aircraft-data or other open-source intelligence integration can run as managed ingestion and publish Entities for the external Command Interface to show on its map. Neither needs a taskable Plugin Entity.

These examples are design probes, not claims that all these interfaces exist. They should expose where two modules are trying to own the same state and where extension-specific behavior would otherwise leak into Core.

## Release workflow questions left to implementation planning

The shared version is settled. The following are recommended mechanics to evaluate, not additional accepted architecture decisions:

- Select the version once and derive Core, SDK and Protocol artifact versions from it.
- Validate the corresponding set together and record the source revision or revisions used.
- Publish new artifacts at that version even when some content is unchanged.
- Treat partial publication as an incomplete release; define how to retry missing artifacts without replacing already published ones.
- Mark a release complete only when all required artifacts are available and identify the same release.

A single workflow cannot make separate artifact registries one transaction. Completion and recovery therefore need an explicit policy. Each release documents a supported client-version range and clearly rejects unsupported clients; exact ranges, checks and version-number conventions remain implementation choices. Startup validates retained configuration and Plugin compatibility, reporting invalid configuration and leaving incompatible Plugins installed but disabled. Shared numbering alone answers none of those questions.

## Suggested order of design work

Design the dedicated responsibilities through concrete Atlas workflows and their public contracts. Define Protocol, SDK access and Core behavior together, with retained-state startup, explicit Reset and independent tests. Add shared utilities where the implemented workflows demonstrate a need. See the [system design](system-design.md) for the accepted boundaries. Command Interface implementation and individual Plugin algorithms remain outside this design.

The previous research module lists are alternatives to compare, not a settled architecture. No implementation scaffolding or workflow has been created from this outline.
