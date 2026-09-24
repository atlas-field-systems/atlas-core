# Atlas Core

Atlas Core is being extracted and simplified from Atlas Modernization. This repository contains accepted design work and the first Core, Protocol and SDK runtime slice; the Command Interface is a separate consumer.

| Read for | Document |
| --- | --- |
| Users, field workflow and expected workload | [Operating model](docs/architecture/operating-model.md) |
| SDK–Core parity, integration and future gateway test requirements | [Testing strategy](docs/testing-strategy.md) |
| Initial MVP: Move To, Elevation Lookup and Object transfer | [MVP scope](docs/architecture/operating-model.md#initial-mvp) and [integration checks](docs/architecture/system-design.md#mvp-integration-checks) |
| Repository boundaries and module responsibilities | [System outline](docs/architecture/system-outline.md) |
| Collaboration between Core, SDK, Protocol and local tools | [System design](docs/architecture/system-design.md) |
| Selected technology stack and generation tools | [Stack decision](docs/adr/0016-use-go-sqlite-and-openapi-tooling.md) |
| Docker containers, Plugin separation and mounted storage | [Deployment decision](docs/adr/0017-deploy-core-and-plugins-as-docker-containers.md) |
| Domain vocabulary | [CONTEXT.md](CONTEXT.md) |
| Accepted tradeoffs and their rationale | [ADRs](docs/adr/) |
| Confirmed changes from the source system | [Modernization differences](docs/architecture/modernization-differences.md) |
| Source evidence, technology alternatives and proposed experiments | [Research index](docs/research/atlas-reassessment/README.md) |

The [documentation guide](docs/agents/domain.md) explains which document owns each kind of information and how to keep them consistent. Implementation specifications belong in [GitHub Issues](docs/agents/issue-tracker.md). Research proposals are not implementation commitments.

## API and SDK plans

The plans below record the agreed API and SDK behavior. The [reconciliation record](docs/planning-reconciliation.md) explains the decisions that align them with the architecture. Detailed schemas and explicitly open implementation choices remain to be designed.

| Read for | Document |
| --- | --- |
| Endpoint families and resource responsibilities | [API plan](docs/api-plan.md) |
| Public methods, paths, inputs and effects | [API endpoint map](docs/api-endpoints.md) |
| HTTP, full synchronization and Asset hybrid modes | [SDK data access](docs/sdk-data-access.md) |
| Registration, reporting and resource operations | [SDK operations catalog](docs/sdk-operations.md) |
| Asset status, communications and heartbeat | [Asset status](docs/asset-status.md) |
| Movement and activity history scope | [Movement history](docs/architecture/system-design.md#movement-history) and [activity log](docs/architecture/system-design.md#activity-history) |
| Component applicability and proposed storage mappings | [Data component catalog](docs/data-components.md) |
| Earlier implementation evidence | [Atlas Modernization reference](docs/atlas-modernization-reference.md) |

## First runtime slice

The first runtime slice starts one Go Core with separate installation and operational storage, then inspects authenticated health and Dataset identity through the TypeScript SDK. The remaining resource and lifecycle work is tracked in the implementation issues.

## Local installation

Prerequisites: Go 1.26.2, Node 25, pnpm 11.0.9 and Docker Compose. Build the image while packages are available; starting an installed image does not require internet access.

```sh
cd core
go build -o bin/atlasctl ./cmd/atlasctl
cd ..
core/bin/atlasctl -root . setup
docker compose build core
core/bin/atlasctl -root . start
```

Setup prints the first administrative credential once and keeps a protected copy in `state/setup/first-key` (mode 0600). The installation database stores its verifier, never the plaintext key. Restrict access to `state/setup`; it is mounted only into Core. If access is lost, `core/bin/atlasctl -root . recover` issues another administrative credential through the private local boundary. `core/bin/atlasctl -root . stop` preserves setup, Dataset data, Object storage and logs. The Core process is independent of an SDK or Command Interface connection.

Setup also creates `state/setup/enrollment-key` (mode 0600), the deployment enrollment authority that tooling supplies to Asset integrations. The SDK's `prepareAssetEnrollment()` allocates an Asset ID, request ID and Asset credential; the integration must persist that identity **before** calling `enrollAsset()`, so that a retry after a lost response or restart reuses it. Core stores only credential verifiers. `core/bin/atlasctl -root . revoke-enrollment` stops new enrollments without affecting enrolled Assets.

Asset reports (status, partial updates and check-in) carry a stable report ID and an increasing sequence; a resent report returns the current Entity and an older sequence is rejected. Every commit appends the Entity to a change log that clients replay with `GET /queries/changed-since` or follow live on the `/feed` WebSocket. `ATLAS_CHANGE_RETENTION` (default 50,000) sets how many changes stay replayable; a client that falls further behind loads a new snapshot. The SDK's `mode: "full"` keeps a synchronized local picture and serves the same read methods from it.

Compose binds the public API to host loopback port 8080 by default. Use a trusted TLS ingress before exposing it to other machines; enrollment sends the prepared Asset credential to Core. [Protocol](protocol/openapi.yaml) defines the public routes and which kinds of credential may call each; every request carries `Authorization: Bearer <key>`. Readiness checks both SQLite stores and private Object storage. Start waits for a private container health probe and reports startup failure if required storage is unavailable. Dataset identity and writing release persist across same-release starts. A different writing release refuses startup and requires a future explicit update/Reset flow.

## Development checks

```sh
cd core && go vet ./... && go test ./... && cd ..
scripts/check-generation.sh
scripts/test-e2e.sh            # add --docker for the Compose scenarios
```

End-to-end scenarios in `tests/e2e/` build and start the real Core, drive it through the real SDK and direct Protocol requests, and assert each promise against independently authored wire fixtures in `protocol/fixtures`. Every scenario also writes a readable transcript to `tests/e2e/artifacts/`. The run fails when a transcript differs from the committed file; regenerate with `ATLAS_E2E_UPDATE=1 scripts/test-e2e.sh` and review the diff. The Docker scenarios build the Core image from the checkout and exercise the private setup, Start and Stop commands against mounted storage. See the [code conventions](docs/agents/code-conventions.md#tests).

Generation pins sqlc 1.31.1, oapi-codegen 2.8.0 and openapi-typescript 7.13.0. Generated files are never edited by hand.
