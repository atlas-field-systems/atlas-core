# Atlas Core

Atlas Core is being extracted and simplified from Atlas Modernization. This repository is currently a design and research workspace for Core, Protocol and SDK; the Command Interface is a separate consumer.

| Read for | Document |
| --- | --- |
| Users, field workflow and expected workload | [Operating model](docs/architecture/operating-model.md) |
| Initial MVP: Move To, Elevation Lookup and Object transfer | [MVP scope](docs/architecture/operating-model.md#initial-mvp) and [integration checks](docs/architecture/system-design.md#mvp-integration-checks) |
| Repository boundaries and module responsibilities | [System outline](docs/architecture/system-outline.md) |
| Collaboration between Core, SDK, Protocol and local tools | [System design](docs/architecture/system-design.md) |
| Selected technology stack and generation tools | [Stack decision](docs/adr/0016-use-go-sqlite-and-openapi-tooling.md) |
| Docker containers, Plugin separation and mounted storage | [Deployment decision](docs/adr/0017-deploy-core-and-plugins-as-docker-containers.md) |
| Domain vocabulary | [CONTEXT.md](CONTEXT.md) |
| Accepted tradeoffs and their rationale | [ADRs](docs/adr/) |
| Confirmed changes from the source system | [Modernization differences](docs/architecture/modernization-differences.md) |
| Source evidence, technology alternatives and proposed experiments | [Research index](docs/research/atlas-reassessment/README.md) |

The [documentation guide](docs/agents/domain.md) explains which document owns each kind of information and how to keep them consistent. Implementation specifications belong in [GitHub Issues](docs/agents/issue-tracker.md). Research proposals are not implementation commitments. The stack and deployment decisions above are accepted; implementation has not started.

## API planning review

The endpoint and SDK planning session produced the documents below. They preserve the session's decisions but overlap with architecture decisions merged separately. Read the [reconciliation notes](docs/planning-reconciliation.md) before using them as implementation requirements; they do not silently supersede the ADRs above.

| Read for | Document |
| --- | --- |
| Endpoint families and resource responsibilities | [API plan](docs/api-plan.md) |
| Proposed public methods, paths, inputs and effects | [API endpoint map](docs/api-endpoints.md) |
| HTTP, full synchronization and Asset hybrid modes | [SDK data access](docs/sdk-data-access.md) |
| Registration, reporting and resource operations | [SDK operations catalog](docs/sdk-operations.md) |
| Asset status, communications and heartbeat | [Asset status](docs/asset-status.md) |
| Component applicability and proposed storage mappings | [Data component catalog](docs/data-components.md) |
| Resource terminology from this planning session | [Planning glossary](docs/api-glossary.md) |
| Earlier implementation evidence | [Atlas Modernization reference](docs/atlas-modernization-reference.md) |
