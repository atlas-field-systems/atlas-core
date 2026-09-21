# Atlas Plugins reassessment

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and logs; Reset clears them while keeping setup and installed artifacts. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup/restore is not selected. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Successor decision update: [Core owns Commands and Assets execute Tasks](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or ingest external sources; they cannot introduce Asset Commands or be taskable Tool Assets. [Planned stops and updates protect active Plugin work](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Source descriptions below remain historical evidence; conflicting research proposals are superseded.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

This note reviews the Atlas Plugin runtime, Source Gateway, SDK credentials,
Tool Assets, catalog, release lifecycle, and external execution options. It is
research for the reassessment. It does not amend an ADR or authorize code
changes.

The source snapshot supplied for this review is Atlas Modernization commit
`8edee4e2743fbf0f85c16dfe638d9222141cf279`. It was unpacked at
`/private/tmp/atlas-core-reassessment-20260920` without Git metadata, so the
repository links below use that supplied SHA. The destination worktree already
contains the parent task's other reports. This task changed only this note. No
source, issue, pull request, or commit was changed.

## Requirement clarification

The user needs temporary capabilities for a single flight, test, or specialized system, maintained in separate repositories and removable afterward. That establishes a concrete purpose for optional extensions alongside permanent Core modules. The prior internal-module default below is narrowed accordingly: publishing Atlas data does not make a temporary processor a Core-owned capability. See [temporary mission extensions](11-mission-extensions.md) for the revised recommendation and removal test.

## Summary

The repository implements a coherent, trusted first-party Plugin platform. A
Plugin is a separate deployment process behind Core-owned HTTP routes. It may
call a private Source Gateway for external data and may use the normal Atlas
SDK. Core owns the public API, limits, cancellation, error mapping, durable
Atlas actions, and Task semantics. The Source Gateway owns source origins,
credentials, egress checks, request policy, bounds, retries, and circuit state.

That platform fits the current Reference and Building Scan examples. It is not
evidence that every former Plugin should remain a Plugin. The product direction
now puts one server and field devices first, and breaking changes are allowed.
The architectural question is which responsibility earns a process or
deployment seam:

| Placement | Use it when | What it gives up |
| --- | --- | --- |
| Core subsystem or module | The feature is part of Atlas's mission, shares Core storage and authorization, and should ship with the server | Its dependencies and failures join the Core release and process |
| In-process capability behind a typed interface | The feature is trusted, bounded, and compatible with Core's language and runtime | No independent crash, memory, restart, or release boundary |
| Managed Plugin process | The feature needs an independent failure domain, dependency set, resource budget, credential boundary, scaling decision, or release cadence | A private protocol, supervisor, image/config lifecycle, health and recovery work |

Independent Plugin releases are therefore a candidate tradeoff, not a settled
constraint. A signed catalog and digest-pinned image solve delivery coupling.
They do not solve hostile-code isolation, and they cost more than an in-process
module. An external source adapter can stay a Core-owned module while using
Source Gateway policy. A source adapter does not automatically need a Plugin.

Keep permanently supported domain behavior in Core. A temporary processor can create durable Entities or participate in Tasks while remaining an external extension. Core owns resource and lifecycle rules; the extension owns its specialized processing and dependencies. Independent repository ownership and removal are now explicit reasons for that separation. Execution and packaging choices remain proposals.

The current trust model must stay explicit. All releases are trusted
first-party images. A Plugin receives no external-source credential, but the
first Compose topology lets every Plugin use every connector. An SDK-using
Plugin receives one shared full-access Core API key. A compromised Plugin can
therefore call unrelated Core operations and may open direct outbound
connections unless the deployment enforces network policy. Source Gateway is a
credential and policy broker, not a sandbox for trusted code.

## What exists at the supplied SHA

### Runtime and Core-to-Plugin protocol

`@the-drunken-coder/atlas-plugin-runtime` is the supported TypeScript authoring
kit. It derives a language-neutral manifest, serves `/manifest`, `/health`,
and `/operations/{operation_id}`, carries cancellation, and supplies Source
Gateway and Tool Asset clients. The runtime validates identifiers, deadlines,
spatial `map_area` input/output, request bounds, and stable private errors;
unexpected exception text stays inside the process. See the [runtime README](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/README.md#L1-L62),
[manifest and spatial code](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/src/index.ts#L22-L139),
and [private server](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/plugin-runtime/src/index.ts#L165-L280).

The Source Gateway client rejects credentialed or path-bearing origins,
preserves repeated tuples and binary bodies, disables redirects, and propagates
cancellation. Core strictly decodes responses, bounds bytes, rejects bad
content and protocol versions, and maps cancellation/deadlines. See [client](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/plugins/client.go#L19-L229)
and [client tests](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/plugins/client_test.go#L15-L229).

The registry discovers without blocking Core startup, retains cached discovery,
separates transport/application health, rejects excess concurrent work, and
keeps availability after a handled operation failure. Tests cover discovery
recovery, malformed input, deadlines, cancellation, capacity, identity, and
protocol errors. Core exposes `GET /plugins`, invokes through the registry, and
maps private failures into stable public categories. See [registry tests](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/plugins/registry_test.go#L73-L231),
[public handler](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_plugins.go#L14-L85),
and [route decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-24-core-owns-plugin-http-interface.md#L4-L10).

An Operation is a bounded synchronous JSON request and response. Core owns the
deadline, request and response limits, cancellation, admission bound, and
public error mapping. The Plugin validates opaque input and owns the result.
The documented semantic contract says Operations are read-only, even when the
external provider uses HTTP POST for a query. Durable writes and work that
outlives the request belong to Core actions or Tasks. Core cannot prove that
opaque Plugin code is side-effect free, so Plugin tests carry that
responsibility.

### Source Gateway

Source Gateway is a private Compose service with health and connector-request
routes. Strict base settings and connector fragments reject unknown fields,
unsupported entries, invalid origins, duplicate IDs/routes, unsafe policies,
and invalid secrets at startup. See [configuration](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/SOURCE_GATEWAY.md#L1-L65).

Each connector owns origin, route, headers, read-only behavior, secret source,
egress class, bounds, timeout, concurrency, rate, cache, retry, and circuit
policy. The Gateway resolves secrets, blocks disallowed private addresses,
never follows redirects, and rejects path/origin/credential overrides and
oversized or malformed envelopes. See [normalization](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/sourcegateway/config.go#L20-L136)
and [execution/tests](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/sourcegateway/gateway.go#L263-L476).

It does not authenticate individual Plugin callers. The first deployment trusts
every Plugin with every connector, and Compose does not stop trusted code from
making direct outbound requests. Source Gateway is therefore a credential and
policy broker, not hostile-code containment; enforced egress isolation would be
needed for untrusted images. See [the trust statement](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L238-L262)
and [Gateway tests](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/sourcegateway/gateway_test.go#L90-L350).

### SDK, credentials, and Tool Assets

Plugins do not access storage directly. SDK calls use ordinary Core
authentication, validation, idempotency, persistence, and Task rules, but all
Plugins currently share one full-access managed key; Core has no Plugin actor or
capability scope. The host manager provisions and rotates it through the
host-only `managed-keys` command in the running Core container. See [access and
security](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L264-L273)
and [key lifecycle](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md#L130-L151).

This makes managed Plugins suitable only for trusted first-party operation.
A bug or compromise can call unrelated Core operations. A Core subsystem can
use typed internal services and avoid a network credential. Third-party or
operator-supplied code would require per-Plugin identity, capabilities, feed and
Task scope, rotation, and audit provenance before expansion.

A taskable Plugin registers an ordinary `asset` with subtype `tool` and a stable
Plugin-derived ID. Tool Assets receive normal Protocol-authored Commands and
Tasks; manifests cannot invent Commands. Cancellation aborts the handler,
planned stop fails active Tasks with `asset_stopped`, replacement fencing uses
`asset_restarted`, and a crash leaves accepted Tasks nonterminal until operator
cancellation. The Plugin never resumes automatically. See [Tool Asset decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-08-25-tool-assets-use-protocol-commands.md#L4-L10)
and [security](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/docs/SECURITY.md#L117-L135).

### Interactions, Datastreams, and Plugin state

`map_area` is the one fixed interaction kind. The Command Interface renders a
generic rectangle editor and spatial result viewer, validates shared contracts,
and displays provenance, freshness, attribution, and truncation. It does not
branch on Plugin IDs, Operation IDs, or providers. See [generic interaction
integration](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L413-L428).

Datastreams are named in the model, but no discovery or delivery route exists.
Transport, ordering, replay, latency, retention, and persistence wait for a
concrete transient-data product. A continuous source can create durable Tracks
through a Task without becoming a Datastream. See [the Datastream boundary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/README.md#L430-L448).

Plugin caches, temporary files, and source checkpoints are disposable. Durable
intent and results use normal Atlas resources. A private volume or generic
Plugin KV store would add ownership, backup, migration, retention, and rollback
rules and remains deferred.

## The placement decision to make

The current Plugin vocabulary describes an implementation, not a product
necessity. For each proposed feature, ask which authority it needs and which
failure should be isolated.

| Question | Core subsystem | Managed Plugin |
| --- | --- | --- |
| Does it primarily create or update Atlas resources? | Natural owner. Core can validate and persist directly. | Adds a full-access network client and a private protocol. |
| Does it drive a field-device Task? | Natural owner of Task and runtime semantics. | Useful only if task behavior needs a separate runtime or dependency set. |
| Does it need a vendor SDK or native library that Core should not load? | A trusted module may still be enough if its dependency is supported. | Separate process contains crashes and dependency conflicts. |
| Must operators stop or upgrade it without restarting the server? | Requires a deliberate module lifecycle. | Process lifecycle gives this directly. |
| Does it need an independent CPU, memory, or egress budget? | Core needs resource accounting. | A supervisor can impose a process budget, with hardening work. |
| Does it need a different release cadence? | Version with Core. | Independent artifact can justify catalog and compatibility checks. |
| Does it hold a source credential? | Source Gateway can hold it for a Core adapter. | Source Gateway can hold it for a Plugin, but current Plugin identity is not per-connector. |
| Does it need an executable browser UI? | Fixed Core renderer remains safer. | Current platform does not allow executable UI code. |

The former Building Scan example is a good seam test because it has a source
adapter, bounded spatial Operation, and generic UI interaction. It is also a
deletion test. If making it a Core subsystem removes a container, private
protocol, shared SDK key, image, catalog entry, and restart transaction while
preserving source and UI contracts, the Plugin seam may not earn its cost for
the first field-device product.

The former ADS-B Tool Asset scenario is different. Its continuous source
observation writes Tracks and has long-running Task cancellation and runtime
fencing. Those are Core concepts. A separate Plugin is justified only if the
observer's dependency, failure, resource, or release boundary matters more
than the cost of the SDK credential and separate lifecycle.

## Catalog and independent release as an option

The supplied code and docs implement an independent lifecycle for schema-4
deployments. A catalog entry, Installed Plugin, Enabled Plugin, and runtime
status are separate. The host manager retains release documents, image
digests, Core deployment bundles, generated active files, transaction journals,
and run intent. It uses explicit operator approval and recovery paths. Core and
the browser do not receive Docker or host-filesystem authority. See [the
management state model](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md#L17-L124)
and [state and commands](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-plugins/MANAGEMENT.md#L233-L269).

The release document is strict, declarative, digest-pinned, and first-party.
Compatibility includes package schema, private protocol majors, fixed
interactions, and the exact Protocol revision when the SDK is used. See [the
release validator](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/scripts/plugin-release-validation.mjs#L7-L59)
and [the independent-release decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md#L4-L10).

Those controls are valuable only if an independent artifact matters. For a
one-server first release, a Core subsystem can remove this lifecycle entirely:

| Managed Plugin responsibility | What a Core module can remove |
| --- | --- |
| Catalog signature, release document, image digest, compatibility | Core package and ordinary dependency verification, unless a separate artifact is needed |
| Installed versus enabled state | Core configuration and one server lifecycle |
| Generated Compose fragments and active-file receipts | Typed module wiring and Core-owned source config |
| Plugin health polling and private HTTP errors | Typed calls with Core's existing error and readiness policy |
| Shared SDK key injection | Internal service calls and existing Core authorization |
| Plugin container stop, recovery, and restart policy | Core process lifecycle, while accepting shared failure domain |
| Cross-process cancellation and response bounds | Core context and Task cancellation, while preserving output bounds |

These removals are real. They also remove independent crash isolation and the
ability to update one feature without changing Core. Choose from deployment and
failure needs, not from the existence of a catalog implementation.

One source consistency check matters if the managed path is retained. The
authored Building Scan overlay says `restart: unless-stopped` at [its Compose
fragment](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/plugins/building_scan/compose.yml#L14-L31),
while the independent manager requires generated and retained services to use
`restart: "no"`. The manager may intentionally normalize authoring input into
active output. Acceptance must inspect the generated model and live container,
not only the authored overlay. If the overlay is consumed directly, the two
documents conflict.

## External technology options

### Separate Compose process

Docker documents that default container capabilities and mounts may provide
incomplete isolation, including with kernel vulnerabilities. See [Docker Engine
security](https://docs.docker.com/engine/security/). Rootless mode can reduce
daemon and container privilege through a user namespace. See [Docker rootless
mode](https://docs.docker.com/engine/security/rootless/). These controls harden
a managed process. They do not scope the shared Core key or prevent direct
egress by themselves.

Compose provides dependency ordering and health checks. It does not wait for an
application to be ready merely because a container is running. `service_healthy`
can gate creation of a dependent service. See [Compose startup and shutdown
order](https://docs.docker.com/compose/how-tos/startup-order/). Atlas uses this
for the acceptance stack and keeps Plugin status separate from Core readiness.

Compose fits a feature that earns an external boundary and already matches the
current image, health, network, and acceptance shape. Its cost is manager,
image receipt, generated config, recovery journal, and host supervisor. It is a
deployment mechanism, not hostile-code isolation.

### Trusted child process

Node's `child_process.spawn` supports async execution, explicit environment and
working directory, timeout, `AbortSignal`, and kill signal. See [Node child
process documentation](https://nodejs.org/api/child_process.html). A
Docker-free installation could keep the private HTTP protocol and use one
trusted child per feature.

It removes image and network plumbing, not lifecycle semantics. The launcher
still needs executable hashes, private socket binding, OS identity, CPU/memory,
file/descriptor and output limits, health, stop escalation, crash handling,
release receipts, and recovery. This is credible only where Docker is
unavailable and a trusted service manager already exists.

### In-process package, worker, or `vm`

An in-process module removes the HTTP hop and shared API key. It joins Core's
process, event loop, dependency graph, startup path, and release unit. A panic,
memory leak, blocking call, or dependency conflict can affect the server. A
Core subsystem accepts this shared failure domain deliberately and can use
typed internal services. A feature that needs independent stop, upgrade, or
resource budgets should not be hidden behind an in-process label.

Node documents `worker_threads` as parallel JavaScript inside one Node
instance. Workers can share memory and are distinct from child processes where
process isolation matters. See [worker threads](https://nodejs.org/api/worker_threads.html)
and [cluster](https://nodejs.org/api/cluster.html). Workers are useful for
trusted CPU work, not a Plugin security boundary. Node's `vm` documentation
states directly that `node:vm` is not a security mechanism. See [VM
documentation](https://nodejs.org/api/vm.html). Node's Permission Model is a
seat belt for trusted code and explicitly does not provide security guarantees
against malicious code. See [Permission Model](https://nodejs.org/api/permissions.html).

### WebAssembly

WebAssembly modules are sandboxed and leave the host only through imports, but
the format defines no syscalls or APIs. See [security](https://webassembly.org/docs/security/)
and [portability](https://webassembly.org/docs/portability/). WASM is worth
testing for an untrusted compute-only parser or geometry helper, not as a
drop-in full Plugin. A full module would need host contracts for bounds,
cancellation, logging, source requests, SDK calls, Tasks, health, and quotas;
network/filesystem imports are only as safe as that host.

The useful narrower design passes bounded bytes from a trusted adapter or Core
subsystem to WASM while keeping credentials, network, writes, and Task authority
outside it. See the [specifications](https://webassembly.org/specs/).

## Trust and lifecycle invariants

The successor constraints below are distinct from the historical placement mechanisms in this assessment:

1. A catalog signature authenticates release bytes and image identity. It does
   not prove runtime behavior or enforce egress.
2. Plugin identity and discovery need explicit contracts. The source uses
   configured IDs and matching manifests; successor discovery mechanics remain open.
3. Source connector configuration owns external origin, secret, route policy,
   egress, limits, retry, cache, rate, and circuit behavior.
4. Core owns durable resources, Tasks, validation, idempotency, feed writes,
   and public error semantics.
5. Plugins are not Assets or Task targets. They may issue existing Core-defined
   Commands as Tasks to Assets, but cannot introduce Asset Commands.
6. Long Plugin work uses a Core-owned Operation attempt with queryable state,
   explicit cancellation and an outcome. It continues after caller disconnection.
   The old synchronous/Tool Task model is historical. Restart preserves records;
   automatic resumption of interrupted execution is not implied.
7. A Datastream name does not provide a transport, replay guarantee, ordering,
   or retention policy.
8. Installed, enabled, and runtime-available are different states. A runtime
   outage must not silently delete installed state.
9. The source trusted Plugin private HTTP interface has no caller authentication.
   This is historical evidence, not a selected successor transport policy. Installed
   successor Plugins are trusted user-built extensions; credential mechanisms remain open.

An in-process Core module can preserve invariants 3 through 8 while removing
private process and catalog states. A managed Plugin preserves them across a
process boundary but adds independent lifecycle state. Choose the smallest set
the first product needs.

## Experiments and acceptance

These are proposed experiments, not accepted ADRs.

### Experiment 1: compare one feature in Core and as a Plugin

Use Building Scan as a deletion test. Build two throwaway implementations with
the same `MapArea` input, spatial result, provenance, attribution, truncation,
and controlled source fixture. One is a Core-owned source adapter and typed
operation. One is the existing Plugin path. Keep Source Gateway policy in both
cases where source credentials or egress rules apply.

Record exact lines of code, build dependencies, startup time, memory, failure
behavior, request latency, cancellation time, operator steps, release steps,
and test count. Count lifecycle responsibilities removed by the Core version:
private manifest, health poller, shared SDK key, container, image, endpoint
fragment, catalog receipt, active-file generation, restart impact, and recovery
journal. Count what the Core version adds: internal interface, module wiring,
Core tests, Core release coupling, and failure-domain impact.

Acceptance is a decision record with measured values and a statement of which
failure domain the product accepts. The Plugin wins only if its independent
failure, dependency, resource, or release boundary matters in the first
deployment. The Core version wins if it preserves source and UI contracts while
removing lifecycle machinery without making Core's failure behavior
unacceptable.

The current Plugin acceptance path supplies the process-side evidence. It
starts Core, PostgreSQL, MinIO, Source Gateway, Plugin, and a controlled
internal source, then checks manifest and operation discovery, spatial output,
invalid input, malformed geometry, source outage, caller cancellation, Plugin
stop, and recovery. See [acceptance README](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/tests/acceptance/plugins/building-scan/README.md#L1-L18)
and [scenario](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/tests/acceptance/plugins/building-scan/scenario.mjs#L23-L260).

### Experiment 2: field-device Task ownership

Model the ADS-B monitoring scenario with a Core subsystem and with a Tool
Asset-backed Plugin. Use the same field-device or simulated Asset, Task input,
progress, cancellation, runtime stop, replacement, and crash cases.

Acceptance requires that both variants make Task outcome and operator recovery
legible. If the Plugin variant adds no useful independent dependency, resource,
or failure boundary, keep the observer in Core and retain only the Source
Gateway connector. If the external process is required, measure the cost of the
full-access key, process restart, stranded Tasks, and separate release.

### Experiment 3: trusted child process only if a process seam survives

Build a throwaway Docker-free launcher for the existing Reference Plugin. Keep
the three private HTTP routes and Source Gateway client unchanged. Use a local
socket or loopback address, explicit environment allowlist, unprivileged OS
user, output cap, executable hash, and a supervisor.

Acceptance requires an equivalence matrix for manifest, health, timeout,
cancellation, response bounds, startup, graceful and forced stop, crash,
resource limits, direct-egress denial, key rotation, release receipts, and
interrupted rollback on every target OS. If the launcher needs a custom
supervisor, network namespace, cgroup policy, secret store, image verifier, and
recovery journal, it has moved the Compose cost rather than reducing it.

### Experiment 4: compute-only WASM helper

Pass bounded bytes to a small untrusted parser or geometry transform. Give it
memory, output, execution-time, and module-size limits. Do not give it network,
filesystem, process, environment, Core SDK, or arbitrary host imports.

Acceptance requires safe trap behavior, cancellation within the operation
deadline, repeatable output across supported architectures, explicit digest or
signature evidence, and measured maintenance cost against a normal Core or
TypeScript implementation. This tests a helper boundary. It does not prove
that a full WASM Plugin should own source access or Tasks.

### Experiment 5: evaluate artifact independence after the seam

For the feature chosen in Experiment 1, compare Core package release with an
independent immutable artifact. Record how often it changes, whether operators
need to update it without Core, whether rollback must preserve Core storage,
and whether image verification is materially easier than ordinary package
verification.

Acceptance is a release-cost and recovery-cost comparison. Independent release
should be retained only when its operator value exceeds catalog, compatibility,
receipt, supervisor, and rollback complexity. It should not be retained merely
because the current repository already has a catalog manager.

## Uncertain product questions

1. Is the first expansion target still trusted first-party code, or does it
   include operator-supplied or third-party code? The latter starts a security
   project before it starts a marketplace.
2. Which first field-device feature needs a failure, dependency, resource, or
   release boundary that Core cannot provide?
3. Do product targets run Docker Compose with a recovery-aware supervisor? If
   not, is a child process launcher worth implementing?
4. Does any source adapter need durable private checkpoint state that cannot be
   represented as Atlas resources or a source cursor?
5. Does any real product need transient delivery outside durable Tracks or
   Objects, with explicit replay, ordering, retention, backpressure, and
   subscriber authorization?
6. Should a crash leave Tasks for operator cancellation, or is automatic resume
   a requirement? The current Plugin model intentionally does not resume.
7. Is one shared full-access Core key acceptable for the actual deployment
   threat model? It should not be assumed acceptable if trust expands.
8. Should connector access be granted per feature or module? The current first
   deployment gives every trusted Plugin every connector.
9. Is `map_area` enough for the next operator interaction? New interactions
   need fixed Protocol contracts and generic renderers.
10. Does an actual parser or geometry workload justify a WASM helper? Without
    that evidence, WASM adds an ABI and maintenance burden.

## Recommendation for this reassessment

Preserve an optional extension mechanism for temporary mission capabilities alongside the modular Core. Begin with a responsibility and failure-domain comparison for one
source-backed feature and one field-device Task. Keep the Source Gateway's
credential, egress, and request policy boundary available independently of
where the adapter executes.

Use a Core subsystem for capabilities Atlas intends to support permanently. Keep temporary mission capabilities in separate repositories, even when they share Core resource contracts. Keep the managed Plugin path when
measured work shows a need for independent failure, dependency, resource,
credential, or release control. Treat independent artifact release as a second
decision after the execution seam is justified. Treat catalog signing,
container hardening, and WASM as answers to different questions.

Do not add Datastream delivery, persistent Plugin state, Plugin dependencies,
third-party catalogs, or unattended updates while those forcing scenarios are
unconfirmed. Do not describe the current Compose topology as hostile-code
isolation.

Repository claims are pinned to the supplied SHA in the links above. External
claims use the first-party Node.js, WebAssembly, and Docker documentation linked
in the relevant sections.
