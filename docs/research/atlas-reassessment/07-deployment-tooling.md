# Deployment, CLI, build, test, and release reassessment

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Scope update: the user needs removable mission-specific extensions in separate repositories alongside permanent Core modules. See [temporary mission extensions](11-mission-extensions.md). Earlier proposals to absorb integrations apply to permanent capabilities; the old extension-management machinery remains open for simplification.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

This note evaluates the deployment and tooling surface at Atlas Modernization source SHA
[`8edee4e2743fbf0f85c16dfe638d9222141cf279`](https://github.com/the-Drunken-coder/Atlas-Modernization/tree/8edee4e2743fbf0f85c16dfe638d9222141cf279).
The source snapshot supplied for this review is the authority. The conclusions are about the
current repository and a first deployment shape: one Core server serving field devices. They
are not an approval of the existing release or Plugin architecture.

The repository has two deployment products that have grown beside each other:

* `atlas-core` is a Node 24 npm package. It owns a typed lifecycle manager, invokes Docker
  Compose, retains a production Compose bundle, verifies image receipts, records deployment
  state, and exposes direct commands plus an Ink/React terminal interface. Its command list
  includes Core lifecycle, update, recovery, supervision, diagnostics, logs, and a large
  Plugin management surface. [`application.ts` lines 169-203](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L169-L203)
  and the manager wiring at [lines 1083-1154](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L1083-L1154)
  show this boundary directly.
* `services/core/scripts/atlas.py` is a Python Compose launcher. The deployment runbook still
  presents it as the production and Cloudflare Tunnel path, including `--production` and
  `--production --tunnel`. [`DEPLOYMENT_RUNBOOK.md` lines 7-121](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/DEPLOYMENT_RUNBOOK.md#L7-L121)
  The packaged CLI has a different product boundary: the external-ingress document says a
  host-managed `cloudflared` service owns the tunnel and that the CLI owns only local Core.
  [`EXTERNAL_INGRESS.md` lines 1-35](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-core/EXTERNAL_INGRESS.md#L1-L35)

That split is the most concrete deployment problem. It creates two operational interfaces and
two definitions of what “production” means. A simpler first system should select one supported
launcher, keep the other as an explicitly labelled development or migration tool, and make its
tests prove the supported path. The first system also needs a decision about whether Plugins
are separate containers at all. The present documents encode independent Plugin distribution,
catalog trust, and release workflows, but the reassessment question is open: those former
Plugins may be subsystems inside Core modules. Keeping that lifecycle without a demonstrated
field-device need would preserve a large amount of distribution and trust machinery.

## Current deployment shape

The npm workspace is deliberately broad. The root package uses npm workspaces and a lockfile
version 3, requires Node `>=24`, builds SDK, Meshtastic Link, Plugin runtime, Plugins, Core CLI,
command interface, and simulations, and has a postinstall SDK build. [`package.json` lines 1-59](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json#L1-L59)
The Core package itself is a publishable package with `atlas-core` as its bin entry. Its check
script runs formatting, lint, typecheck, tests, build, a packed-package install smoke, and a
portable-host smoke. [`surfaces/core-cli/package.json` lines 1-64](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json#L1-L64)

The package embeds a single production Compose topology. It starts a Core API and source
gateway from the same immutable Core image, PostgreSQL 15, MinIO, and a one-shot MinIO bucket
initializer. Ports bind to loopback, PostgreSQL and MinIO use external durable volumes, and the
Core image comes from `ATLAS_CORE_IMAGE`. [`surfaces/core-cli/assets/docker-compose.yml` lines 1-154](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/assets/docker-compose.yml#L1-L154)
This is a reasonable one-server foundation. It makes the host-side CLI the lifecycle authority
without giving the Core process access to the Docker socket.

The Core service is Go. Its module declares Go 1.26 and toolchain 1.26.5, with HTTP, WebSocket,
PostgreSQL, MinIO, logging, protocol, and `golang.org/x` dependencies. [`services/core/go.mod` lines 1-45](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L1-L45)
The production Dockerfile builds with a pinned Go 1.27 Alpine builder and `GOTOOLCHAIN=auto`,
then runs from a pinned Alpine 3.24 image as a non-root user with a curl readiness check.
[`services/core/docker/Dockerfile` lines 1-133](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docker/Dockerfile#L1-L133)
The Go module and container compiler versions are close, but they are not one compiler contract.
That is a reproducibility question to resolve before promising byte-for-byte image builds.

The CLI is not a thin wrapper around a few shell commands. `ProcessCommandRunner` owns child
processes, streams output, abort signals, process groups, and forced termination after a grace
period. [`application.ts` lines 412-470](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L412-L470)
The deployment manager calls Compose, pulls and verifies image receipts, checks local and
container image identities, asserts storage safety, regenerates and verifies deployment
configuration, and provisions credentials. [`application.ts` lines 1083-1154](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L1083-L1154)
That is useful behavior to preserve even if the terminal interface or Plugin model changes.

The interactive layer uses Ink 7, React 19, and `wrap-ansi`; it renders an alternate screen,
handles Ctrl-C itself, caps rendering at 30 FPS, and delegates operations to the same manager as
direct commands. [`terminal-ui.tsx` lines 1-3](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/terminal-ui.tsx#L1-L3)
and [lines 174-197](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/terminal-ui.tsx#L174-L197)
The TUI redesign decision explicitly rejected OpenTUI and a separate manager service in favor of
one typed headless manager with direct and Ink adapters. [`2026-09-12-atlas-core-tui-redesign.md` lines 1-12](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-12-atlas-core-tui-redesign.md#L1-L12)
That decision remains a constraint for a minimal change, while the reassessment may reopen it if
measurements show that React and Ink are costly on field operator hosts.

## Dependency and external-tool disposition

The table covers direct Core and shared build, deployment, release, and operational tooling in
the supplied inventory. SDK-only runtime dependencies are intentionally left to the SDK review.
“Keep” means the dependency currently has a concrete role. “Constrain” means retain it behind a
documented boundary and test. “Reconsider” means the simpler first system should prove the need
before carrying it forward.

| Area | Declared choice and use | Disposition and reason |
| --- | --- | --- |
| Host runtime | Node 24.19.0 from `.nvmrc`, npm workspaces, npm lockfile v3, package engines `>=24` | **Keep and document.** Node is the CLI runtime and the release-tool runtime. The npm package does not bundle Node, so install and upgrade behavior are part of the operator contract. npm trusted publishing currently requires a recent npm and OIDC workflow identity; validate the exact installed npm in the live release environment against [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/). |
| CLI language | TypeScript 7.0.2, `tsc` project build, Node standard library, `@types/node` 26.5.1 and `@types/react` 19.3.0 | **Keep.** `tsc` is enough for a package that mostly coordinates host processes and ships retained assets. The type packages are development-only and must not enter the tarball. Project references or another bundler would add value only after measuring package size or build time. |
| CLI runtime UI | React 19.2.8, Ink 7.1.1, `wrap-ansi` 10.0.1 | **Constrain and measure.** The TUI is a user interface, not a deployment prerequisite. Keep the headless manager as the stable seam. Before replacing Ink with plain ANSI, Cobra/Bubble Tea, or another renderer, measure cold start, terminal restoration, 40x24 and 80x24 rendering, cancellation, and macOS/Linux behavior. The current design decision rejects OpenTUI, so a rewrite needs evidence rather than preference. |
| CLI test | Vitest 5.0.1 plus Node `node:test` scripts | **Keep.** Vitest covers TypeScript unit and integration tests; Node test scripts cover packed consumers and release behavior. The package `check` repeats package and portable gates, which is useful in CI but makes local checks unnecessarily expensive. The existing problem report documents that duplication. [`2026-09-17-core-cli-pack-on-check.md` lines 1-17](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-17-core-cli-pack-on-check.md#L1-L17) |
| Shared coverage | `@vitest/coverage-v8` 5.0.1 at root | **Keep where used; omit from a Core-only extraction if unused.** Coverage is a development dependency, not an operator requirement. Verify the Core package does not inherit it into its tarball. |
| Formatting and lint | Biome 2.5.13, strict JS/TS/TSX rules | **Keep.** One formatter and linter is simpler than separate ESLint and Prettier installations. CI checks lint and format. [Biome CI guidance](https://biomejs.dev/guides/integrate-in-ci/) supports this boundary. |
| Browser test tool | Playwright 1.63.0 and `@vitest/browser-playwright` in shared workspaces | **Keep outside the CLI package.** These test the browser-facing surfaces. The Core package should not make browser binaries an install or deployment dependency. |
| React DOM | Root `react-dom` 19.2.8 | **Reconsider for Core extraction.** Ink needs React, not React DOM. Retain at the monorepo root only while command-interface or browser surfaces use it. |
| Go toolchain | Go 1.26 module/toolchain, Go 1.27 pinned Docker builder, `GOTOOLCHAIN=auto` | **Keep Go; constrain the compiler contract.** The service should remain Go. Choose either one pinned release compiler or explicitly accept the module-versus-builder split. Build the same commit through both paths and compare version metadata, module graph, image labels, and test results before changing the Dockerfile. |
| Go HTTP and protocol | `chi/v5`, `chi/cors`, `coder/websocket`, local Atlas protocol module, `uuid`, `zerolog`, `x/crypto`, `x/net`, `x/text` | **Keep.** These implement the Core server and protocol boundary. They are service dependencies, not reasons to make the CLI a Go binary. |
| Go storage | `pgx/v5` 5.11.0 and `minio-go/v7` 7.3.0 | **Keep for the first server.** They directly represent the durable PostgreSQL and S3-compatible object store. Use the existing storage recovery tests as the acceptance gate for upgrades. |
| JSON schema and generated protocol | `santhosh-tekuri/jsonschema/v6`, `x/text`, generated protocol artifacts | **Keep and test generated output.** The protocol workflow regenerates and checks for a clean diff. This is a useful build invariant. |
| Compose engine | Docker Engine, Docker CLI, Docker Compose >=2.17, Compose health checks and named volumes | **Keep for one server.** Compose expresses the API, source gateway, PostgreSQL, MinIO, and init container topology with health dependencies. The official [Compose services specification](https://docs.docker.com/reference/compose-file/services/) and [profiles](https://docs.docker.com/compose/how-tos/profiles/) describe the primitives used here. Kubernetes, Nomad, or Swarm would add an operator and control-plane requirement before field-device demand exists. |
| Docker image build | BuildKit/buildx, QEMU for release multi-architecture builds, local `registry:2` for CI acceptance | **Keep in CI; do not require on an operator host.** Release needs native amd64/arm64 evidence and a multi-architecture manifest. QEMU is a release convenience, not a production runtime. The local registry is an isolated test fixture. |
| Core images | GHCR repository, immutable digest references, OCI revision/version labels | **Keep and enforce.** The package Compose asset resolves an image from `ATLAS_CORE_IMAGE`; lifecycle code verifies image receipts and container identities. A floating tag should be an input to resolution only, never the final persisted identity. |
| PostgreSQL | Pinned `postgres:15` image, loopback port, external production volume, `pgx` client, `psql`/`pg_dump`/`pg_restore` in tests and recovery tooling | **Evaluate as a storage candidate.** Test concurrency, retained-state startup and Reset. Exclude the source backup/restore tooling. |
| MinIO | Pinned 2024-01-31 MinIO server and `mc` init images, `minio-go`, external production volume, bucket bootstrap | **Compare with local Object storage.** Test content integrity, retained-state startup and Reset. Backup and restore functionality is excluded. |
| Optional ingress | Cloudflare Tunnel image `cloudflare/cloudflared:2026.5.2`, tunnel token, dedicated bridge in the legacy overlay | **Keep optional and outside Core lifecycle initially.** Cloudflare Tunnel is an outbound connector, so a host service can publish loopback Core without exposing the Docker socket or adding public ports. [Cloudflare Tunnel overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) and [run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) support this boundary. Choose either host-managed or Compose-managed tunnel ownership; the current two paths must not both be called supported production. |
| Python operational scripts | Python 3 standard library scripts for `atlas.py`, Compose environment generation, live tests, coverage, and recovery selection | **Constrain as developer and CI tooling.** There is no Python runtime dependency in the published Core npm package. Keep the scripts while migration is underway, run `py_compile`, Ruff, and focused tests, and label `atlas.py` as legacy if `atlas-core` becomes the supported operator path. |
| Python style tool | Ruff 0.15.22 in CI, `services/core/scripts/ruff.toml` | **Keep for the scripts that remain.** Do not add a second Python framework or package manager solely for these standard-library utilities. |
| Shell utilities | Bash, curl, `jq`, shellcheck, GNU/coreutils behavior in CI and deployment scripts | **Keep as explicit host/CI prerequisites and test their use.** CI installs `jq` and shellcheck, runs shellcheck over scripts, and uses curl for readiness and HTTP integration. The package’s operator prerequisite list should say which commands are needed for a source checkout and which are unnecessary for a packed CLI. |
| Alpine runtime tools | `ca-certificates` and `curl` installed in the production image; non-root `atlas` user | **Keep minimal.** `ca-certificates` is needed for TLS and curl is needed for health checks. Do not add a shell, compiler, or package manager to the runtime image unless an operational command needs it. |
| CI action pinning | `actions/checkout@v7.0.1`, `setup-node@v7.0.0`, `setup-go@v7.0.0`, `setup-python@v7.0.0`, `upload-artifact@v7.0.1`, `download-artifact@v8.0.1`, `github-script@v9.0.0`, `create-github-app-token@v3.2.0`, `upload-pages-artifact@v5.0.0`, and `deploy-pages@v5.0.1`, all pinned by SHA | **Keep the pinning policy.** These actions provide checkout, toolchain setup, artifact transfer, workflow/API helpers, release credentials, and catalog publication. Update through a reviewed dependency change. The CI workflow shows the pinned setup and validation boundary. [`ci.yml` lines 30-63](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/ci.yml#L30-L63) |
| CI Go quality | `actionlint` v1.7.11, `golangci-lint-action` v9 running golangci-lint v2.12.2, Go `deadcode` v0.48.0, `go vet`, `gofmt`, race tests | **Keep.** These are distinct checks with clear failure modes. Go CI records them at [lines 65-115](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/ci.yml#L65-L115). A Core-only repository can retain them without the wider workspace. |
| CI security | CodeQL v4.38.0 for Go and JavaScript/TypeScript, Trivy action v0.36.0 with Trivy v0.70.0, zizmor action v0.6.4 with zizmor v1.25.2 | **Keep as CI signals, with an explicit release policy.** CodeQL covers source analysis; Trivy scans the filesystem and production image; zizmor audits workflow hazards. They do not belong in the operator install path. [`codeql.yml` lines 42-73](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/codeql.yml#L42-L73), [`nightly.yml` lines 43-95](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/nightly.yml#L43-L95) |
| Release image tools | Docker Buildx, QEMU, `docker/login-action` v4.6.0, `docker/build-push-action` v7.4.0, `docker/setup-buildx-action` v4.4.0, `docker/setup-qemu-action` v4.4.0 | **Keep for publication.** The release path builds and verifies linux/amd64 and linux/arm64 images. The operator only consumes the published digest. |
| Release registry and package | GHCR, npm registry, npm 11.6.2 in the release workflow, trusted publishing via OIDC, npm provenance and registry signatures | **Keep the identity chain; avoid token fallbacks.** The release document requires trusted publishing and `npm audit signatures`. [npm provenance](https://docs.npmjs.com/viewing-package-provenance/) and [trusted publishers](https://docs.npmjs.com/trusted-publishers/) provide the external contract. |
| GitHub release evidence | Immutable GitHub Release, release manifest, SHA-256 and npm integrity, Actions artifacts for 90 days, GitHub artifact/release attestations | **Keep, simplify only if release scope shrinks.** A sealed immutable release is the durable recovery bundle; Actions artifacts are temporary preparation state. GitHub describes [artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) as signed claims and [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) as a way to lock tag and assets. |
| Plugin catalog and signing | Ed25519 trust data and catalog URL in `plugin-trust.json`, GitHub Pages catalog, Plugin images and catalog release workflows | **Reconsider for the first Core server.** The trust primitives are sound when untrusted third-party distribution is a requirement. They are unnecessary product surface if the former Plugins become compiled or configured Core subsystems. Keep the trust model isolated until the subsystem decision is made; do not let it dictate Core’s deployment shape. |
| Release notes helper | OpenCode Go 1.18.21 invoked in the Core release workflow with a restricted one-file output contract | **Constrain.** It is release-automation convenience, not a release identity dependency. The candidate manifest, package hash, image digest, source SHA, and acceptance evidence must remain deterministic if the notes job is unavailable. |

The shared root also declares `react-dom` and Playwright-related packages for browser surfaces,
as well as the SDK and Plugin runtime workspaces. Those dependencies should not leak into an
extracted Core package. The inventory shows many transitive packages, including Vite, jsdom,
sharp, serialport, maplibre, and Wrangler. Their presence in the monorepo lockfile is not a
reason to make them Core deployment prerequisites. Package tarball contents and `npm pack
--dry-run` should remain a release gate.

## Build and test assessment

The CI layout is stronger than the local documentation makes apparent. The Core package has
native Linux amd64 and arm64 package checks; the platform acceptance workflow installs the same
tarball on Linux and macOS x64 and arm64. The Compose topology check asserts the image, loopback
ports, external MinIO volume, source gateway, and absence of `ATLAS_PLUGINS`. [`ci.yml` lines 237-330](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/ci.yml#L237-L330)
This is valuable evidence for a portable npm package, but a macOS package install is not proof
that Docker deployment works on macOS. The README already says deployment requires a local Linux
Docker daemon over its Unix socket. [`surfaces/core-cli/README.md` lines 350-358](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/README.md#L350-L358)

The CI build installs Python 3.11, `jq`, and shellcheck, compiles Python scripts, installs Ruff
0.15.22, runs Ruff, and checks shell syntax. [`ci.yml` lines 541-606](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/.github/workflows/ci.yml#L541-L606)
That makes the source-checkout developer path materially larger than the packed CLI consumer
path. The documentation should draw that line: operators need Node, Docker, Compose, and the
platform’s Docker daemon; contributors to the Python launcher and integration suite also need
Python, jq, curl, shellcheck, and Ruff.

The build workflow uses a pinned local `registry:2` container, pushes a candidate image, and
then exercises the packaged CLI against the exact candidate. The release workflow separately
builds a multi-architecture image, creates the npm tarball, records identity in a manifest, and
requires explicit publication approval. The release contract is unusually careful about exact
source SHA, annotated tags, immutable assets, GHCR digest promotion, npm provenance, and
idempotent reconciliation. [`RELEASING.md` lines 1-105](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-core/RELEASING.md#L1-L105)
It is appropriate for a public package and container. It is too much ceremony for an internal
single-server installation until the distribution model is settled, but it should not be
weakened merely to make local development faster.

The immediate efficiency issue is duplication. `atlas-core check` runs the packed package and
portable package gates, while the CI matrix also runs those gates. A useful split is a fast
developer check for format, lint, typecheck, unit tests, and build, with packed and portable
consumer tests explicit in CI and release candidate commands. Removing a test from the default
check is safe only if the command names remain discoverable and CI keeps both platform classes.

The second build issue is topology duplication. The packaged Compose file, development Compose
file, production Compose file, tunnel overlay, Python environment generator, and TypeScript
environment generator all encode overlapping service contracts. The existing problem report
confirms duplicate Compose environment sanitization and a dead `inherit` parameter. [`2026-09-17-compose-env-duplication.md` lines 1-14](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-17-compose-env-duplication.md#L1-L14)
The files cannot be blindly merged because their intended lifecycles differ: the package uses
published immutable images and external volumes, while development Compose builds source and
uses scratch volumes. A better simplification is one declarative service contract with explicit
profiles or generated variants, followed by topology tests for each supported mode.

## What survives if Plugins become Core subsystems

The current Plugin model has real implementation cost:

* Core’s command grammar includes install, enable, disable, update, rollback, uninstall,
  refresh, key rotation, status, and logs for Plugin identities. [`application.ts` lines 180-191](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L180-L191)
* The deployment manager regenerates Plugin files, verifies contracts and health, and passes
  Plugin IDs into Compose. [`application.ts` lines 1105-1150](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/src/application.ts#L1105-L1150)
* Compose is designed to manage one container per Plugin, while Core never receives the Docker
  socket. [`2026-08-25-compose-manages-plugin-containers.md` lines 1-11](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-25-compose-manages-plugin-containers.md#L1-L11)
* Plugin releases have independent SemVer, image, catalog, and signing documents. The Core
  release guide says Core publication does not build or promote Plugin releases. [`RELEASING.md` lines 183-192](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-core/RELEASING.md#L183-L192)

Those properties are useful for third-party or independently operated modules. They are a poor
default for a first-party field server if the modules are always shipped, upgraded, and
recovered as one system. A subsystem design can keep process boundaries only where a failure,
resource, or security boundary requires them. It can put versioning, catalog resolution, and
Compose generation under the Core release identity. This would remove a network of catalog
availability, trust checkpoint, Plugin image promotion, and rollback states.

The safe path is an experiment rather than a broad deletion. Select one current first-party
Plugin and implement a temporary in-tree subsystem representation with the same field-device
operation. Compare:

1. install and first start on a clean Linux host;
2. startup time and memory at idle and under field-device traffic;
3. failure isolation when the module panics or becomes unhealthy;
4. update and rollback after schema and data changes;
5. offline recovery from one Core release bundle;
6. operator steps and observable logs;
7. image and package evidence needed for a trusted release.

Keep independent containers only if the results show a concrete isolation or resource benefit.
Keep independent releases only if a module must ship on a different cadence or be installed by
an operator without a Core release. Keep the catalog only if the operator must discover or
install modules outside the Core bundle. Until one of those gates passes, the simpler default is
one Core release containing the server and its first-party subsystems, with optional external
components added later through a deliberate contract.

## Deployment and ingress decisions

For one server, Docker Compose is the right level of orchestration. The package Compose bundle
has four stateful or service roles, health dependencies, loopback ports, and named volumes. It
does not need scheduling, replica placement, leader election, or cluster networking. A move to
Kubernetes or another orchestrator should require an explicit field requirement such as two
servers, rolling upgrades without downtime, independent resource limits, or multi-host failover.
The current `container_name` and fixed volume/project identity also imply one instance per host;
that should be stated as an invariant.

A public deployment should remain optional. Core binds API, PostgreSQL, and MinIO to loopback;
the operator can put a reverse proxy or Cloudflare Tunnel in front of API port 8000. Cloudflare
Tunnel runs an outbound connector and can be a host-managed system service. The external-ingress
document correctly keeps tunnel credentials out of `~/.atlas/core/.env`. The legacy Compose
overlay, however, adds a dedicated tunnel network and hard-coded trusted-proxy address. Both
security models are defensible, but only one should appear as the supported recipe.

The first field test should therefore run with no public ingress, then with one separately
managed ingress process. The test must verify WebSockets, authentication, trusted proxy headers,
CORS, reconnect behavior, and that PostgreSQL and MinIO remain unreachable from the ingress.
Only after that should a bundled tunnel option be considered. The Core CLI should not acquire DNS
or tunnel-token lifecycle merely because the old Python launcher has that path.

## Release and catalog simplification

The Core release workflow is internally coherent: request a version against an exact source SHA,
reserve an immutable annotated tag, build a multi-architecture image and npm tarball, capture
hashes and acceptance evidence, publish to immutable GitHub Release assets, promote the exact
GHCR digest, publish through npm trusted publishing, and verify provenance and signatures. The
release guide states that publication is serialized and matching external state is idempotent.
[`RELEASING.md` lines 88-139](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-core/RELEASING.md#L88-L139)

If Core absorbs first-party modules, the release manifest should become the one system identity:
source SHA, selected artifact identities, module manifest and lifecycle validation evidence.
The current independent Plugin catalog and image publication can then become an optional external
integration, rather than a default dependency of every Core deployment. Do not remove signed
catalog verification from a build that still installs untrusted external modules. First decide
whether those modules exist in the first field release.

The existing release workflow invokes OpenCode Go for notes and uses a release helper package to
reconcile GHCR and npm state. That is a reasonable convenience boundary, but the release cannot
depend on generated prose or a model service for identity. The manifest and acceptance evidence
must remain generated from deterministic commands, with notes treated as an annotation. The
current one-file notes contract is close to that boundary.

## Invariants for a first Core server

Accepted successor requirements apply to any candidate deployment:

- One Core server serves field devices and one or two operators. The implementation language, transport, packaging and storage remain open.
- Start, Stop and Restart retain operational data and logs. Reset clears operational records, Object content, history and Atlas-managed logs while preserving installed selections, credentials, configuration, software and Plugin artifacts.
- Startup reapplies retained setup. First use or post-Reset startup initializes what is absent without making every startup destructive.
- Core owns installed Plugin lifecycle. Independent Plugin lifecycle changes leave Core and unrelated Plugins available and protect active work as defined in ADR-0006.
- Installed local operation must not require internet access. Individual integrations retain their own external dependencies.
- Core/SDK/Protocol release together at matching versions, with supported runtime compatibility defined separately.

Named volumes and non-destructive storage mounts are compatible implementation choices, not requirements to keep PostgreSQL, MinIO, Compose, Go or Node. The source's paired backup/restore and deployment-journal machinery remain historical evidence. Backup and restore functionality is excluded. Ordinary restart retention does not imply automatic interrupted-work resumption. Updates to a new Core release perform Reset, so operational-data migrations are excluded.

## Design issues and decision gates

### Two production launchers

**Observed conflict:** the Python runbook path manages source-built production Compose and a
Cloudflare overlay, while the packaged npm CLI manages published immutable images and excludes
tunnel ownership. The files and docs are both current at this SHA.

**Recommendation:** choose `atlas-core` as the supported operator interface for the first field
release, and label `atlas.py` as development, migration, or test support. Port only missing
diagnostics or recovery behavior into the typed manager. Update the runbook to describe one
production path. If the field trial proves that a source checkout is required for recovery,
retain the Python launcher as a documented emergency tool with a separate Compose contract.

**Gate:** a clean Linux host should install the packed tarball, initialize durable volumes, pull
the exact image, start, stop, restart, recover, and update without the repository checkout.

### Plugin boundary

**Observed conflict:** the CLI, Compose, trust files, catalog workflows, independent release
workflow, and rollback semantics all assume independently distributed Plugin containers. The
reassessment now questions whether first-party Plugins are simply Core subsystems.

**Recommendation:** run one in-tree subsystem experiment before preserving the independent model
as a requirement. Make failure isolation, resource use, offline recovery, update rollback, and
operator steps the comparison criteria. If no criterion requires an independent artifact, fold
the first-party module into the Core release identity. Keep a narrow external-module interface
only if the product later needs third-party or independently operated components.

**Gate:** a field-device workload and a fault-injection run must demonstrate the benefit of a
separate process or release. “The catalog already exists” is not a gate.

### Ink/React TUI

**Observed conflict:** the current design decision is explicit and coherent, but the TUI adds a
large runtime to a host-side operational tool. The user experience may still be justified for
long-running update and recovery operations.

**Recommendation:** preserve the headless manager and direct command API. Measure the current TUI
before considering a plain ANSI or Go implementation. Include terminal restore after SIGINT,
operation cancellation, log streaming, narrow terminals, startup time, and memory. A replacement
must improve an observed operator failure or package cost.

**Gate:** repeatable measurements on Linux amd64, Linux arm64, macOS x64, and macOS arm64,
including an SSH session, with no loss of cancellation or recovery semantics.

### Compose versus cluster orchestration

**Observed choice:** the package and recovery model assume one project, one host, fixed named
volumes, and one API/source gateway pair.

**Recommendation:** keep Compose until a field requirement calls for multi-host scheduling,
replication, or no-downtime rolling changes. A cluster migration would need a new storage and
identity model, so it is not a deployment-tool cleanup.

**Gate:** a written requirement for multiple Core servers or independent service scaling, plus a
recovery design for PostgreSQL and MinIO. Do not use a Kubernetes deployment to solve the current
launcher/documentation split.

### Tunnel ownership

**Observed conflict:** the runbook’s managed Compose tunnel and the external-ingress document’s
host service have different credential and trusted-proxy boundaries.

**Recommendation:** make host-managed ingress the first supported public path. Keep a Compose
overlay as a tested development fixture or delete it after migration. `atlas-core` should not
store tunnel credentials or manage DNS in its first release.

**Gate:** external proxy acceptance for WebSockets, auth, CORS, trusted proxy headers, reconnect,
and port isolation, followed by a credential rotation test.

### Compose and environment duplication

**Observed conflict:** package, development, production, and tunnel files encode overlapping
service settings, and Python and TypeScript both sanitize Compose environment values.

**Recommendation:** identify one service contract and derive explicit dev, production, and ingress
variants from it. Keep topology checks for each supported variant. Remove the duplicate helper
only after its callers are gone.

**Gate:** rendered Compose JSON for every supported mode must preserve image identity, health
dependencies, loopback bindings, volume durability, auth, and trusted proxy semantics.

### Go compiler reproducibility

**Observed conflict:** `go.mod` selects Go 1.26/toolchain 1.26.5 while the production builder is
Go 1.27 with automatic toolchain selection.

**Recommendation:** either pin the builder to the module toolchain or record a deliberate policy
that the image builder may be one minor release ahead. Include the selected compiler in OCI
labels and the release manifest.

**Gate:** two clean builds from the exact source SHA, with module downloads disabled after cache
warmup, and a review of binary, SBOM, test, and image-label differences.

### MinIO recovery semantics

**Observed limitation:** the server and `mc` image are pinned to an old release, while mirror-style
backup preserves current objects rather than acting as a complete object-history backup.

**Recommendation:** if MinIO is selected, test content integrity and lifecycle behavior directly.
The source backup workflow is excluded from Atlas Core.

**Gate:** initialize empty storage, create usable Objects, and verify metadata and bytes survive
same-release Stop/Start and Restart. Verify Reset and a Core release update clear operational
state while preserving installation setup. Do not restore backups or replay operational migrations.

## Unknowns to resolve from live systems

The snapshot cannot establish several external facts. They need live checks before a release
decision:

* whether `atlas.py` is still used by field operators or only by developers;
* the minimum Docker Engine and Compose versions that support every command used by the CLI,
  including `compose --wait`, platform image inspection, health dependencies, and external
  volumes;
* whether Node 24.19.0 and the release workflow’s npm 11.6.2 satisfy the repository’s configured
  npm trusted publisher exactly;
* whether GHCR anonymous pulls, npm provenance, npm signatures, GitHub release immutability, and
  artifact attestations are enabled in the live repository;
* whether Linux arm64 hosts can build, pull, and run the pinned PostgreSQL, MinIO, `mc`, and
  Cloudflare images without an architecture-specific workaround;
* whether the current MinIO image should be upgraded before field storage is populated;
* whether the tunnel token is host-managed, a CI secret, or currently copied into the Compose
  environment by operators;
* whether field connectivity needs offline operation, a local-only server, public ingress, or
  multiple Core servers;
* whether first-party modules must update independently or can be versioned and recovered as a
  single Core bundle.

## Suggested first implementation slice

Evaluate one documented installation path with a representative Core/SDK/Protocol workflow before choosing the packaging stack. Compare the retained source deployment with simpler candidates using the same observable behavior. Core-managed trusted Plugins are accepted; the source's host-only Plugin management is not the successor requirement.

The lifecycle acceptance gate creates operational records, Object content, activity history and diagnostic logs. Stop and Start, then Restart, and verify that they remain available. Reset and verify that they are cleared while installed Plugin selections, credentials, configuration, software and Plugin artifacts survive. Test retained-state startup and fresh initialization separately. No paired backup restoration is required by this gate.

Published evidence should identify the tested source revision, artifact versions, configuration and lifecycle outcomes. Backup and restore functionality is excluded. Mission execution continuity across Core restart is outside scope. The version-update gate must perform Reset, clearing operational data/logs while preserving setup and Plugin artifacts; operational-data migrations are excluded.

### Official external references consulted

* [Docker Compose services](https://docs.docker.com/reference/compose-file/services/) and [profiles](https://docs.docker.com/compose/how-tos/profiles/)
* [Node child processes](https://nodejs.org/api/child_process.html)
* [TypeScript project build mode](https://www.typescriptlang.org/tsconfig/#build)
* [Vitest guide](https://vitest.dev/guide/) and [Biome CI](https://biomejs.dev/guides/integrate-in-ci/)
* [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)
* [MinIO `mc mirror`](https://min.io/docs/minio/linux/reference/minio-mc/mc-mirror.html)
* [Cloudflare Tunnel overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) and [run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
* [npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [provenance](https://docs.npmjs.com/viewing-package-provenance/), and [signature audit](https://docs.npmjs.com/verifying-registry-signatures)
* [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations), [OIDC hardening](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect), and [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
