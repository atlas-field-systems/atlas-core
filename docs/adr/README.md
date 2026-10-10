# Architecture decision records

ADRs record accepted tradeoffs and their rationale. Superseded records stay for history and link to their replacement. See the [documentation guide](../agents/domain.md) for when to add one.

| ADR | Decision | Status |
| --- | --- | --- |
| [ADR-0001](0001-release-core-sdk-and-protocol-together.md) | Release Core, SDK and Protocol together | Accepted |
| [ADR-0002](0002-core-manages-installed-plugins.md) | Core manages installed Plugins and their Operations | Accepted |
| [ADR-0003](0003-retain-durable-activity-history.md) | Retain durable activity history | Superseded by [ADR-0015](0015-separate-start-stop-restart-and-reset.md) |
| [ADR-0004](0004-core-owns-commands-and-assets-execute-tasks.md) | Core owns Commands and Assets execute Tasks | Accepted |
| [ADR-0005](0005-allow-compatible-client-versions.md) | Allow compatible client versions | Accepted |
| [ADR-0006](0006-protect-active-plugin-work-during-lifecycle-changes.md) | Protect active Plugin work during lifecycle changes | Accepted |
| [ADR-0007](0007-reconcile-asset-tasks-after-disconnection.md) | Reconcile Asset Tasks after disconnection | Accepted |
| [ADR-0008](0008-complete-scan-tasks-when-required-results-are-available.md) | Complete scan Tasks when required results are available | Superseded by ADR-0026 |
| [ADR-0009](0009-expose-objects-only-when-ready.md) | Expose Objects only when ready | Accepted |
| [ADR-0010](0010-operate-without-internet-access.md) | Operate without internet access | Accepted |
| [ADR-0011](0011-generate-shared-contracts-with-minimal-customization.md) | Generate shared contracts with minimal customization | Accepted |
| [ADR-0012](0012-build-replaceable-modules-on-shared-infrastructure.md) | Build replaceable modules on shared infrastructure | Superseded by [ADR-0014](0014-build-dedicated-atlas-systems.md) |
| [ADR-0013](0013-start-each-core-run-with-empty-data.md) | Start each Core run with empty data | Superseded by [ADR-0015](0015-separate-start-stop-restart-and-reset.md) |
| [ADR-0014](0014-build-dedicated-atlas-systems.md) | Build dedicated Atlas systems | Accepted |
| [ADR-0015](0015-separate-start-stop-restart-and-reset.md) | Separate Start, Stop, Restart, Reset and Hard Reset | Accepted |
| [ADR-0016](0016-use-go-sqlite-and-openapi-tooling.md) | Use Go, SQLite and OpenAPI tooling | Accepted |
| [ADR-0017](0017-deploy-core-and-plugins-as-docker-containers.md) | Deploy Core and Plugins as sibling Docker containers | Accepted |
| [ADR-0018](0018-confirm-writes-when-core-commits.md) | Confirm writes when Core commits | Accepted |
| [ADR-0019](0019-retire-assets-without-inventing-task-outcomes.md) | Retire Assets without inventing Task outcomes | Accepted |
| [ADR-0020](0020-limit-general-sdk-to-http-and-full-sync.md) | Limit the general SDK to HTTP and full synchronization | Accepted |
| [ADR-0021](0021-manage-plugin-operational-storage-through-reset.md) | Manage Plugin operational storage through Reset | Accepted |
| [ADR-0022](0022-one-publisher-per-track.md) | Give each Track one publisher for observed data | Accepted |
| [ADR-0023](0023-protect-required-entity-references-during-tasks.md) | Protect required Entity references during Tasks | Accepted |
| [ADR-0024](0024-use-live-geofeature-geometry-in-tasks.md) | Use live Geofeature geometry in Tasks | Accepted |
| [ADR-0025](0025-use-core-time-as-the-installation-reference-clock.md) | Use Core time as the installation reference clock | Superseded by [ADR-0029](0029-use-deployment-clocks-and-preserve-event-times.md) |
| [ADR-0026](0026-record-asset-completion-independently-of-result-availability.md) | Record Asset completion independently of result availability | Accepted |
| [ADR-0027](0027-administer-core-configuration-locally.md) | Administer Core configuration locally | Accepted |
| [ADR-0028](0028-trust-gateways-to-author-bound-asset-reports.md) | Trust gateways to author reports for bound Assets | Accepted |
| [ADR-0029](0029-use-deployment-clocks-and-preserve-event-times.md) | Use deployment clocks and preserve event times | Accepted |
