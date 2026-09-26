# Core system outline

Status: working responsibility map. Repository boundaries and the Entities/Tasks/Objects API pillars are established directions. The seven groups below are the current draft; candidate subsystems and code layout remain open.

Read the [operating model](operating-model.md) for users and workflows, the [system design](system-design.md) for collaboration rules, and linked ADRs for accepted tradeoffs. This document assigns responsibilities rather than repeating their behavioral contracts.

## What is decided

The Atlas Core system will live in an `Atlas Core/` folder with sibling SDK and Protocol deliverables. Exact sibling names are unselected. The Command Interface is outside the Core system and folder; its eventual repository placement is undecided. Host installation tools and publishing workflows may live elsewhere in this repository without becoming server modules.

[ADR-0001](../adr/0001-release-core-sdk-and-protocol-together.md) defines the coordinated Core/SDK/Protocol release. [ADR-0005](../adr/0005-allow-compatible-client-versions.md) defines client compatibility and retained-setup validation. Shared numbering does not settle publication mechanics. [ADR-0016](../adr/0016-use-go-sqlite-and-openapi-tooling.md) selects the stack; [ADR-0017](../adr/0017-deploy-core-and-plugins-as-docker-containers.md) places Core modules together in one container with sibling Plugin containers.

## Define responsibilities separately from release artifacts

A module owns a coherent responsibility behind an explicit interface. A subsystem is an internal part that deserves separate planning. Neither implies another repository, process, package, container or release. [Dedicated systems](../adr/0014-build-dedicated-atlas-systems.md) replace the earlier reusable-framework proposal.

SDK and Protocol represent contracts across these responsibilities. Tasks owns Task behavior; Protocol describes its public contract and SDK implements consumer access. These are separate representations, not competing owners of the lifecycle.

Temporary capabilities belong in removable extensions in separate repositories. Permanent capabilities may use the same mechanism; longevity alone does not determine placement. Small helpers do not need independent Plugin lifecycles. Permanent Plugin placement and combined backend/UI packaging remain proposals.

## Atlas Core responsibility map

Entities, Tasks and Objects remain the three primary API pillars. Supporting modules provide shared capabilities without taking ownership of those resources.

| Module | Responsibility | Candidate subsystems | Ownership limit |
| --- | --- | --- | --- |
| Entities | Assets, Tracks and Geofeatures: identity, current state, observations, relationships and movement history until Reset | Resource lifecycle, reporting/check-in, queries, movement history | Owns Entity identity and observed state, not authentication credentials or work execution |
| Tasks | Requests for Assets to execute Core-defined Commands: assignment, delivery, progress, cancellation and outcomes | Current Task instructions and delivery, Command/target validation, reporting-Asset checks, outcome reconciliation, lifecycle transitions | Core owns Command semantics and recorded Task lifecycle; the Asset operating system owns scheduling, queue order, execution and interruption. Plugins are never Task targets; Plugins may initiate Tasks through the SDK using existing Core-defined Commands |
| Objects | Operational information and results: metadata, content, references and provenance | Metadata lifecycle, private content storage, whole-file uploads/retries, downloads, integrity and Reset cleanup | Exposes Objects only when ready through Core APIs accessed using the SDK; hides physical storage locations and does not own each Plugin's specialized processing or result format |
| Plugins | How permanent or temporary extensions attach to Core and how Core manages installed Plugins | Registration/discovery, configuration, compatibility, Operations, managed processing/ingestion, starting/stopping and availability | Uses Identity and access for authorization and existing APIs to read Objects or publish data; owns Plugin work separately and does not render UI |
| Identity and access | Caller identity and authenticated access | Operator identity and sessions, device/Plugin credentials, enrollment, credential revocation | Every authenticated operator has full control; no operator roles or permission tiers. Asset credentials identify the reporting Asset; Core-provided Plugin integration identity allows operational access without operator-managed Plugin keys; installation and Plugin lifecycle administration are local CLI/TUI responsibilities. Core enforces these fixed boundaries |
| Synchronization | How external clients obtain a current view and recover missed changes | Snapshots, committed-change publication, subscriptions, replay and retention | Supports Asset check-in reconciliation with Tasks. Server-side behavior only in this folder. Opt-in client caches, reconnect logic and shared-picture synchronization belong in the sibling SDK; basic SDK API access does not require them |
| System operations | How Core starts, stops, restarts, resets, is configured and observed | Startup/shutdown, configuration, health, diagnostics, activity history, maintenance coordination, explicit Reset/Hard Reset and first-use initialization | Does not turn every maintenance job into an operator Task or make Core its own release publisher |

These are responsibility groups, not seven required services, containers, packages or final subfolder names. Subsystems should be introduced when they make a module's ownership and interface clearer.

## Gap check

These supporting responsibilities have proposed homes within the seven groups:

| Responsibility | Proposed home and boundary |
| --- | --- |
| API serving, request limits, validation and error mapping | Shared API facilities; the corresponding module owns routes and domain behavior; Protocol defines public contracts |
| Storage connections, transactions and initialization | Shared utilities, with private data access and state rules owned by each module |
| Publication of committed changes | The changing module supplies the public representation; Synchronization distributes it. See [change publication](system-design.md#change-publication) |
| Background loops and shutdown | System operations coordinates lifetimes; each module owns its job's meaning, retry rules and limits |
| Presence and report authority | Entities records observations such as last report; Identity and access authenticates callers; Tasks checks assigned-Asset reporting |
| Plugin configuration and secrets | Plugins owns extension settings and validation; System operations supplies loading facilities; Identity and access owns Atlas credentials; provider authentication belongs to the integration |
| Runtime retention and Reset | System operations coordinates retained-state startup; the shared host-side local management module owns lifecycle execution and interrupted-action recovery across Core shutdown. Each module owns its state rules. Removing a Plugin does not itself reset data. See [local lifecycle coordination](system-design.md#local-lifecycle-coordination) |
| Activity history | System operations supplies recording/query facilities; Identity and access supplies actors; owning modules supply action meaning. See [activity history](system-design.md#activity-history) |
| Installation and release tooling | Local tools coordinate with Core lifecycle owners; publishing the shared release is outside the running server |

Shared facilities do not need independent top-level modules merely because several modules use them.

Objects keeps publication and recovery under [one implementation owner](system-design.md#object-publication-and-recovery-ownership). The sibling SDK keeps coupled picture state under [one local operational picture owner](../sdk-data-access.md#local-operational-picture-ownership). These ownership choices do not prescribe package layout or add independently deployed modules.

## Define each module with the same short brief

For each candidate, identify its capability and one concrete workflow, the state and rules it owns, its public interface including failure/cancellation behavior, collaborators, and behavior it delegates. Name subsystems only where they improve planning. Decide base-system or Plugin placement after establishing responsibility. Include an end-to-end acceptance scenario, with shutdown or removal where relevant.

Protocol fields and SDK methods follow from those briefs. Package layout follows ownership decisions; the accepted stack above supplies the implementation tools. Start with the [initial MVP](operating-model.md#initial-mvp). The [scan workflow](operating-model.md#scan-data-and-processing) remains a later example exercising Tasks, Objects and Plugins together.

## Release workflow questions left to implementation planning

Proposed mechanics: select a version once, derive artifact versions, validate the set together and record its source revisions. Define partial-publication retry and completion without replacing published artifacts; separate registries are not one transaction. These are implementation questions, not new accepted decisions.

## Suggested order of design work

Define Core behavior, Protocol contracts and SDK access through concrete Atlas workflows. See [MVP integration checks](system-design.md#mvp-integration-checks) for the first examples and [generation and testing](system-design.md#generation-and-testing) for broader validation. Command Interface implementation and production Plugin algorithms remain outside this design. No implementation scaffolding is established by this outline.
