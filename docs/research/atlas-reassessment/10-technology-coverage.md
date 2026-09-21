# Technology coverage ledger

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Scope update: the user needs removable mission-specific extensions in separate repositories alongside permanent Core modules. See [temporary mission extensions](11-mission-extensions.md). Earlier proposals to absorb integrations apply to permanent capabilities; the old extension-management machinery remains open for simplification.

Baseline: `8edee4e2743fbf0f85c16dfe638d9222141cf279`, reviewed 20 September 2026. Versions below are source declarations, not recommendations to install those versions.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

This ledger makes scope explicit. The companion notes assess direct architectural choices and credible alternatives. The JSON inventory records indirect declarations and the full monorepo lockfile so dependencies are not silently hidden. It is not a vulnerability scan, license audit, or proof that every transitive package deserves to remain.

## Coverage

- Core and Protocol: both Go manifests, including indirect requirements.
- SDK, Plugin runtime, both Plugin examples, Core CLI, and root Node tooling: runtime and development declarations.
- Deployment: container images, runtimes, Compose, ingress, package/registry distribution, signing and relevant Actions tooling.
- Adjacent UI, simulation, and Meshtastic dependencies: present in the full lockfile but not independently reassessed. Their retention is undecided and they are not presumed to belong to Core.
- OS packages and transitive packages: evaluated at their owning runtime/tool choice. No independent alternative analysis of all 425 monorepo npm lock entries was performed.

## Node runtime and development declarations

The SDK has zero declared external runtime dependencies. Plugin runtime and both examples depend on Atlas packages internally. The table below deliberately includes both runtime and development declarations. The only direct external runtime packages in the inspected Node extraction scopes are `ink`, `react`, and `wrap-ansi` in Core CLI.

| External package | Declared versions | Used by | Recommendation route |
| --- | --- | --- | --- |
| `@biomejs/biome` | `2.5.13` | [packages/plugin-runtime](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/package.json), [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json), [plugins/building_scan](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/package.json), [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `@types/node` | `26.5.1`, `^26.5.1` | [packages/plugin-runtime](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/package.json), [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json), [plugins/building_scan](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/package.json), [plugins/reference](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/reference/package.json), [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `@types/react` | `19.3.0` | [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `@vitest/browser-playwright` | `5.0.1` | [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json) | [SDK](05-sdk.md) |
| `@vitest/coverage-v8` | `5.0.1` | [root](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `ink` | `7.1.1` | [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `playwright` | `1.63.0` | [root](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json), [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `react` | `19.2.8` | [root](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json), [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `react-dom` | `19.2.8` | [root](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `typescript` | `^7.0.2` | [packages/plugin-runtime](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/package.json), [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json), [plugins/building_scan](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/package.json), [plugins/reference](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/reference/package.json), [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `vitest` | `5.0.1`, `^5.0.1` | [packages/plugin-runtime](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/package.json), [packages/sdk](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json), [plugins/building_scan](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/package.json), [plugins/reference](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/reference/package.json), [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |
| `wrap-ansi` | `10.0.1` | [surfaces/core-cli](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/surfaces/core-cli/package.json) | [deployment and tooling](07-deployment-tooling.md) |

Internal Atlas package dependencies are recorded in JSON and excluded from this third-party table. They are still important module-coupling choices.

## Go direct requirements

| External module | Version | Assessment |
| --- | --- | --- |
| `github.com/coder/websocket` | `v1.8.15` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L8) |
| `github.com/go-chi/chi/v5` | `v5.3.2` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L9) |
| `github.com/go-chi/cors` | `v1.2.2` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L10) |
| `github.com/google/uuid` | `v1.6.0` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L11) |
| `github.com/jackc/pgx/v5` | `v5.11.0` | [Assessment](02-storage.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L12) |
| `github.com/minio/minio-go/v7` | `v7.3.0` | [Assessment](02-storage.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L13) |
| `github.com/rs/zerolog` | `v1.35.1` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L14) |
| `golang.org/x/crypto` | `v0.57.0` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L16) |
| `golang.org/x/net` | `v0.59.0` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L17) |
| `golang.org/x/text` | `v0.42.0` | [Assessment](03-core-runtime.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/go.mod#L18) |
| `github.com/santhosh-tekuri/jsonschema/v6` | `v6.0.3` | [Assessment](04-protocol.md), [manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/go.mod#L7) |

## Go indirect requirements

These are not separate architecture decisions unless Atlas imports their APIs directly. Retain only the graph required by selected direct dependencies, regenerate it with the selected toolchain, and audit that resulting graph before release. Replacing the owning library is the comparison that matters here. The Protocol validator is covered above because it is direct in its own module.

| Declared indirect module | Declared versions | Proposed treatment |
| --- | --- | --- |
| `github.com/cespare/xxhash/v2` | `v2.3.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/dustin/go-humanize` | `v1.0.1` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/jackc/pgpassfile` | `v1.0.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/jackc/puddle/v2` | `v2.2.2` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/klauspost/compress` | `v1.19.2` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/klauspost/cpuid/v2` | `v2.4.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/klauspost/crc32` | `v1.3.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/mattn/go-colorable` | `v0.1.14` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/mattn/go-isatty` | `v0.0.20` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/minio/crc64nvme` | `v1.1.1` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/minio/md5-simd` | `v1.1.2` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/philhofer/fwd` | `v1.2.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/rs/xid` | `v1.6.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/santhosh-tekuri/jsonschema/v6` | `v6.0.3` | Explicitly assessed as Protocol validator in [Protocol](04-protocol.md) |
| `github.com/tinylib/msgp` | `v1.6.4` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `github.com/zeebo/xxh3` | `v1.1.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `go.yaml.in/yaml/v3` | `v3.0.5` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `golang.org/x/sync` | `v0.23.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `golang.org/x/sys` | `v0.48.0` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |
| `golang.org/x/text` | `v0.39.0` | Align selected module graph; direct Core use assessed in [runtime](03-core-runtime.md) |
| `gopkg.in/ini.v1` | `v1.67.3` | Recompute from selected direct modules; no independent abstraction or replacement justified by this review |

## Deployment and service choices

| Technology | Disposition to evaluate | Assessment |
| --- | --- | --- |
| Go runtime/toolchain, Node runtime, TypeScript | Compare Go and TypeScript server modules on one representative slice; keep TypeScript for browser consumers | [Runtime](03-core-runtime.md), [system options](08-system-options.md) |
| PostgreSQL and pgx | Retain as baseline; test an embedded alternative only against server concurrency, retained-state startup and Reset behavior | [Storage](02-storage.md) |
| MinIO server, mc and S3 | Reopen the storage engine; distinguish a vendor swap from eliminating cross-store recovery | [Storage](02-storage.md) |
| Docker, Compose, BuildKit/buildx and QEMU | Use only the deployment/platform support the first server needs | [Deployment](07-deployment-tooling.md) |
| Alpine base image, CA certificates, curl/wget health checks | Keep required runtime support; compare health checks and image composition with the chosen package | [Deployment](07-deployment-tooling.md) |
| Cloudflare Tunnel and Pages | Optional ingress and former UI hosting, not Core domain dependencies | [Deployment](07-deployment-tooling.md) |
| npm workspaces, registry and lockfile | Keep one build/install story; changing to pnpm needs a demonstrated benefit | [Deployment](07-deployment-tooling.md) |
| GitHub Actions, Releases, GHCR and Pages catalog hosting | Simplify release units before replacing provider tooling | [Deployment](07-deployment-tooling.md) |
| JSON Schema 2020-12, HTTP, JSON, WebSocket, browser fetch/WebSocket | Separate contract semantics from generator and transport implementation | [Protocol](04-protocol.md), [SDK](05-sdk.md) |
| Ed25519 catalog signatures, SHA-256 artifact identity, SemVer/private majors | Keep required integrity if distributed artifacts remain; do not carry a catalog for built-in capabilities | [Plugins](06-plugins.md), [deployment](07-deployment-tooling.md) |
| Python standard-library scripts, shell, Ruff, ShellCheck, jq | Reduce duplicate operator paths; retain narrow checks for files still present | [Deployment](07-deployment-tooling.md) |
| OSM/Overpass external data and GeoJSON | Integration choices outside Core storage ownership; keep attribution, bounded access and source-specific parsing with the integration | [Plugins](06-plugins.md) |
| Vitest, Playwright, Biome, Go tests/vet/lint and coverage | Keep tests that exercise contracts; remove duplicated orchestration, not correctness cases | [SDK](05-sdk.md), [deployment](07-deployment-tooling.md) |
| CodeQL, Trivy, zizmor and golangci-lint | Keep applicable automated analysis; do not confuse architecture assessment with a clean security scan | [Deployment](07-deployment-tooling.md) |

## Action identities

The following is the distinct Action set across source workflows, including adjacent UI/radio jobs. Pins and all usage locations are in the JSON inventory. A successor workflow should include only tools needed by its selected packages.

| Action | Reassessment |
| --- | --- |
| `actions/checkout` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/create-github-app-token` | Reevaluate permissions and automation identity with the smaller release pipeline |
| `actions/deploy-pages` | Omit if neither a separate UI nor signed Plugin catalog needs Pages hosting |
| `actions/download-artifact` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/github-script` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/setup-go` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/setup-node` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/setup-python` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/upload-artifact` | Retain only for applicable builds/checks; keep immutable pinning |
| `actions/upload-pages-artifact` | Omit if neither a separate UI nor signed Plugin catalog needs Pages hosting |
| `aquasecurity/trivy-action` | Retain only for applicable builds/checks; keep immutable pinning |
| `docker/build-push-action` | Retain only for applicable builds/checks; keep immutable pinning |
| `docker/login-action` | Retain only for applicable builds/checks; keep immutable pinning |
| `docker/setup-buildx-action` | Retain only for applicable builds/checks; keep immutable pinning |
| `docker/setup-qemu-action` | Omit unless supported release architectures require emulation |
| `github/codeql-action/analyze` | Retain only for applicable builds/checks; keep immutable pinning |
| `github/codeql-action/init` | Retain only for applicable builds/checks; keep immutable pinning |
| `golangci/golangci-lint-action` | Retain only for applicable builds/checks; keep immutable pinning |
| `zizmorcore/zizmor-action` | Retain only for applicable builds/checks; keep immutable pinning |

## Inventory method and limits

`dependency-inventory.json` was extracted from a `git archive` of the fixed source SHA. It records manifest values, Go requirement lines, YAML `uses`/`image` declarations, Dockerfile `FROM` lines, physical source-line counts, and npm lock entries. It executes no install or lifecycle scripts. Workflow references include repeated and parameterized image declarations; they are not a count of unique external services.

The inventory records 33 Node dependency declarations, 12 unique external Node package names, 34 Go requirement declarations across two modules, 226 workflow/image declarations, and 425 full-monorepo npm lock entries. These categories overlap and must not be added into a single dependency count.

The source references are permanent GitHub links. The temporary inspection archive is `/private/tmp/atlas-core-reassessment-20260920`; the report does not depend on that directory surviving. The original local working folder was left unchanged.
