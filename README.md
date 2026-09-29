# Atlas Core

Atlas Core is being extracted and simplified from Atlas Modernization. This repository is currently a design and research workspace for Core, Protocol and SDK; the Command Interface is a separate consumer.

| Read for | Document |
| --- | --- |
| Users, field workflow and expected workload | [Operating model](docs/architecture/operating-model.md) |
| End-to-end testing policy, SDK–Core parity and required scenarios | [Testing strategy](docs/testing-strategy.md) |
| Initial MVP: Move To, Elevation Lookup and Object transfer | [MVP scope](docs/architecture/operating-model.md#initial-mvp) and [integration checks](docs/architecture/system-design.md#mvp-integration-checks) |
| Repository boundaries and module responsibilities | [System outline](docs/architecture/system-outline.md) |
| Collaboration between Core, SDK, Protocol and local tools | [System design](docs/architecture/system-design.md) |
| Deep-module design and review criteria | [Structure and interfaces](docs/agents/code-conventions.md#structure-and-interfaces) |
| Selected technology stack and generation tools | [Stack decision](docs/adr/0016-use-go-sqlite-and-openapi-tooling.md) |
| Docker containers, Plugin separation and mounted storage | [Deployment decision](docs/adr/0017-deploy-core-and-plugins-as-docker-containers.md) |
| General SDK scope, IP-connected Assets and radio gateway placement | [Two-mode SDK decision](docs/adr/0020-limit-general-sdk-to-http-and-full-sync.md) |
| Private Plugin work storage, Reset and uninstall cleanup | [Plugin storage decision](docs/adr/0021-manage-plugin-operational-storage-through-reset.md) |
| Track publishers, corrections, observation age and deliberate combination | [Track publisher decision](docs/adr/0022-one-publisher-per-track.md) |
| Deletion of resources required by unfinished Tasks | [Required Entity references](docs/adr/0023-protect-required-entity-references-during-tasks.md) |
| Live Geofeature geometry, offline adoption and geometry cutoffs | [Live geometry decision](docs/adr/0024-use-live-geofeature-geometry-in-tasks.md) |
| Reference clock for age, freshness and deadlines | [Core time decision](docs/adr/0025-use-core-time-as-the-installation-reference-clock.md) |
| Current rules by area | [Topic pages](docs/topics/README.md) |
| Domain vocabulary | [CONTEXT.md](CONTEXT.md) |
| Accepted tradeoffs and their rationale | [ADR index](docs/adr/README.md) |
| Confirmed changes from the source system | [Modernization differences](docs/architecture/modernization-differences.md) |
| Source evidence, technology alternatives and proposed experiments | [Research index](docs/research/atlas-reassessment/README.md) |

The [documentation guide](docs/agents/domain.md) explains which document owns each kind of information and how to keep them consistent. Implementation specifications belong in [GitHub Issues](docs/agents/issue-tracker.md). Research proposals are not implementation commitments. The stack and deployment decisions above are accepted; implementation has not started.

## API and SDK plans

The plans below record the agreed API and SDK behavior. The [reconciliation record](docs/planning-reconciliation.md) explains the decisions that align them with the architecture. Detailed schemas and explicitly open implementation choices remain to be designed.

| Read for | Document |
| --- | --- |
| Endpoint families and resource responsibilities | [API plan](docs/api-plan.md) |
| Public methods, paths, inputs and effects | [API endpoint map](docs/api-endpoints.md) |
| Rejection of stale edits to operator-managed data | [Concurrent descriptive edits](docs/architecture/system-design.md#concurrent-descriptive-edits) |
| HTTP mode and Full synchronization mode | [SDK data access](docs/sdk-data-access.md) |
| Registration, reporting and resource operations | [SDK operations catalog](docs/sdk-operations.md) |
| Operational status, Communication state and Contact | [Asset reporting](docs/topics/asset-reporting.md) |
| Task lifecycle, queues, Pause and Resume and reconnect reconciliation | [Tasks](docs/topics/tasks.md) |
| Entity identity, Track publishers, observation age and live Geofeature geometry | [Entities, Tracks and Geofeatures](docs/topics/tracks-and-geofeatures.md) |
| Administrative retirement without invented execution outcomes | [Asset retirement](docs/topics/identity-and-access.md#asset-retirement) and [decision](docs/adr/0019-retire-assets-without-inventing-task-outcomes.md) |
| Movement and activity history scope | [Movement history](docs/architecture/system-design.md#movement-history) and [activity log](docs/architecture/system-design.md#activity-history) |
| Component applicability and proposed storage mappings | [Data component catalog](docs/data-components.md) |
| Earlier implementation evidence | [Atlas Modernization reference](docs/atlas-modernization-reference.md) |
