# Atlas Core

This repository is the planning home for extracting and simplifying Atlas Core and its related Protocol and SDK from Atlas Modernization. The Core system will live in an `Atlas Core/` folder, with Protocol and SDK beside it. The Command Interface is a separate consumer outside the Core system.

Read [what Atlas is for](docs/architecture/operating-model.md) for the operating model and user-facing behavior. Start with the [Core system outline](docs/architecture/system-outline.md) for the current planning state. [ADR-0001](docs/adr/0001-release-core-sdk-and-protocol-together.md) records the accepted shared Core/SDK/Protocol release version. Entities, Tasks and Objects remain the primary API pillars; supporting responsibilities and internal subsystem boundaries are being refined.

The implementation direction is [dedicated Atlas systems](docs/architecture/system-design.md), with shared utilities where needed, Protocol-generated bindings, minimal generator customization and independent tests. All external operational API consumers use the SDK, choosing basic API access or maintained shared-picture synchronization as their application needs.

The CLI/TUI uses local internal management interfaces for installation and lifecycle control, separate from the public API and SDK. Core also [manages installed Plugins](docs/adr/0002-core-manages-installed-plugins.md) and [retains activity history until Reset](docs/adr/0015-separate-start-stop-restart-and-reset.md) for Task and administrative actions.

Core [owns Commands and Assets execute Tasks](docs/adr/0004-core-owns-commands-and-assets-execute-tasks.md); Plugins expose Operations, process data and gather external sources. [Compatible client versions](docs/adr/0005-allow-compatible-client-versions.md) are allowed, and [planned Plugin stops and updates protect active work](docs/adr/0006-protect-active-plugin-work-during-lifecycle-changes.md).

Expected use is a few hours of local coordination at a time. An installed system [works without internet access](docs/adr/0010-operate-without-internet-access.md). [Start, Stop and Restart preserve data and logs; Reset clears them](docs/adr/0015-separate-start-stop-restart-and-reset.md). Field use is set up Core, connect Assets, then run the mission with Core continuously available. Restart and Reset are primarily development actions outside missions; recovering active mission execution across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Installed Plugin selections, credentials and configuration survive. Plugin lifecycle changes do not require restarting Core.

The [differences from Atlas Modernization](docs/architecture/modernization-differences.md) table compares confirmed successor changes against the inspected source revision.

The [architecture and technology reassessment](docs/research/atlas-reassessment/README.md) contains source evidence, technology alternatives and experiments to inform those decisions.

[CONTEXT.md](CONTEXT.md) defines the domain vocabulary. Research recommendations are provisional. Accepted architectural decisions live in `docs/adr/`; implementation specifications follow this repository's [GitHub issue convention](docs/agents/issue-tracker.md).
