# Atlas Core

Atlas Core is being extracted and simplified from Atlas Modernization. This repository contains Core, Protocol and SDK design, research and a bounded [Slice 0 contract foundation](tests/contract/README.md); the Command Interface is a separate consumer.

| Read for | Document |
| --- | --- |
| Users, field workflow and expected workload | [Operating model](docs/architecture/operating-model.md) |
| End-to-end testing policy, SDK–Core parity and required scenarios | [Testing strategy](docs/testing-strategy.md) |
| Initial MVP: Move To, Elevation Lookup and Object transfer | [MVP scope](docs/architecture/operating-model.md#initial-mvp) and [integration checks](docs/testing-strategy.md#mvp-integration-checks) |
| Implementation slices, route/scenario coverage and specification tickets | [Implementation sequence](docs/architecture/implementation-sequence.md) |
| Executed representative generation and validation proof | [Pinned toolchain proof](docs/research/atlas-reassessment/13-protocol-toolchain-proof.md) |
| Repository boundaries and module responsibilities | [System outline](docs/architecture/system-outline.md) |
| Collaboration between Core, SDK, Protocol and local tools | [System design](docs/architecture/system-design.md) |
| Deep-module design and review criteria | [Structure and interfaces](docs/agents/code-conventions.md#structure-and-interfaces) |
| Selected technology stack and generation tools | [Stack decision](docs/adr/0016-use-go-sqlite-and-openapi-tooling.md) |
| Docker containers, Plugin separation and mounted storage | [Deployment decision](docs/adr/0017-deploy-core-and-plugins-as-docker-containers.md) |
| General SDK scope, IP-connected Assets and radio gateway placement | [Two-mode SDK decision](docs/adr/0020-limit-general-sdk-to-http-and-full-sync.md) |
| Start, Stop, Restart, Reset, Hard Reset, Dataset identity and release updates | [Dataset lifecycle](docs/topics/dataset-lifecycle.md) and [lifecycle decision](docs/adr/0015-separate-start-stop-restart-and-reset.md) |
| Plugin Operations, lifecycle, configuration, private work storage and uninstall cleanup | [Plugins](docs/topics/plugins.md) and [storage decision](docs/adr/0021-manage-plugin-operational-storage-through-reset.md) |
| Track publishers, corrections, observation age and deliberate combination | [Track publisher decision](docs/adr/0022-one-publisher-per-track.md) |
| Deletion of resources required by unfinished Tasks | [Required Entity references](docs/adr/0023-protect-required-entity-references-during-tasks.md) |
| Live Geofeature geometry, offline adoption and geometry cutoffs | [Live geometry decision](docs/adr/0024-use-live-geofeature-geometry-in-tasks.md) |
| Asset-owned completion and independent result availability | [Completion decision](docs/adr/0026-record-asset-completion-independently-of-result-availability.md) |
| Reference clock for age, freshness and deadlines | [Core time decision](docs/adr/0025-use-core-time-as-the-installation-reference-clock.md) |
| Current rules by area | [Topic pages](docs/topics/README.md) |
| Domain vocabulary | [GLOSSARY.md](GLOSSARY.md) |
| Accepted tradeoffs and their rationale | [ADR index](docs/adr/README.md) |
| Confirmed changes from the source system | [Modernization differences](docs/architecture/modernization-differences.md) |
| Source evidence, technology alternatives and proposed experiments | [Research index](docs/research/atlas-reassessment/README.md) |
| Proposed convention improvements from historical PR feedback | [Coding conventions retrospective](docs/research/pr-review-retrospective/README.md) |

The [documentation guide](docs/agents/domain.md) explains which document owns each kind of information and how to keep them consistent. Implementation specifications belong in [GitHub Issues](docs/agents/issue-tracker.md). Research proposals are not implementation commitments. The stack and deployment decisions above are accepted. Slice 0 establishes shared contract tooling and an isolated fixture workflow; operational Core behavior remains unimplemented. The original isolated Protocol proof remains executable research evidence.

## API and SDK behavior

Current API and SDK rules live on the topic pages. The [decision log](docs/planning-reconciliation.md) records the dated decisions behind them. Detailed schemas and explicitly open implementation choices remain to be designed.

| Read for | Document |
| --- | --- |
| Current rules, routes and SDK operations by area | [Topic pages](docs/topics/README.md) |
| Route families, public methods, paths, inputs and effects | [API endpoint map](docs/api-endpoints.md) |
| Component applicability and proposed storage mappings | [Data component catalog](docs/data-components.md) |
| Earlier implementation evidence | [Atlas Modernization reference](docs/atlas-modernization-reference.md) |

## Contract foundation

[Slice 0](tests/contract/README.md) adds the shared Protocol baseline, generated Core/SDK bindings, narrow validation adapters and local representative Catalog lookup. Its isolated checks cover HTTP/SQLite/file workflows and canonical non-HTTP messages. Run its required checks with `python3 scripts/verify.py --bootstrap`. Operational Core workflows remain with their owning implementation slices.
