# Atlas Core

**Core is the running authority for one Atlas installation.** It validates requests,
records intent and evidence, stores data, and serves clients. It does not fly the
drone or turn a network acknowledgment into physical success.

## Deployment

Core is one TypeScript server on Node.js, with ordinary internal modules,
one SQLite database, and local Object files. Fastify supplies the HTTP adapter;
the [database worker](database.md) owns SQLite, transactions, and checkpoints.
Core runs in a Docker container on Linux. Explicit local TypeScript commands
control its lifecycle and settings. Protocol remains independent of these choices.

Operators and independent integrations connect over adequate IP using the SDK or
public HTTP API with credentials. Gateway software, constrained-radio transport, and the operator UI are separate
projects. Closing the UI does not stop Core. The [operating environment](../operating-environment.md) assumes
host internet access while allowing interruptions on field links. Local Core work
does not require a cloud service.

## Ownership inside the server

| Owner | Responsibility |
| --- | --- |
| Identity | Authenticate keys, record attribution, and enforce revocation |
| Entities/reporting | Descriptions, accepted Asset and Observation reports, retained Tracks and associations, contact, and position history |
| Fusion policy | Observation-to-Track decisions and derived state, initially one-to-one |
| Tasks | Command admission, intent, requested order, and reported execution |
| Objects | Complete content publication, metadata, holds, and cleanup |
| Synchronization | Publish and replay whole committed picture changes; own temporary snapshots and HTTP history views |
| Local administration command | One lifecycle or settings operation; explicit recovery for interrupted destructive work |

Core's internal owners use direct calls and a shared transaction boundary.
Keep each domain's tables private behind its owner. Add no generic event bus,
scheduler service, or module framework without a concrete need.

## HTTP adapter

Fastify owns routing, bounded body ingestion, streams, and connection shutdown.
Pass original bounded UTF-8 to Protocol before ordinary JSON parsing. Use Protocol's
readers and writers; Fastify schemas do not become another contract definition.
Disable input coercion, default insertion, field removal, and default request logging.
Stream multipart Object content separately from its bounded JSON descriptor.
The error handler closes connections with unread request bodies so clients retire them.

The adapter authenticates requests and dispatches complete domain operations to
the database worker. Domain modules own policy and durable effects. Recheck authority
and Dataset inside the transaction. Keep framework types at the HTTP boundary.
Use supported WebSocket integration with explicit connection and queue ownership.
Socket failure after commit leaves the recorded effect intact and delivery uncertain.

## Shared boundary, private mechanisms

Core and SDK consume one browser-safe TypeScript Protocol package of runtime
schemas and inferred types. Stock tooling exports its portable OpenAPI reference
under the [schema profile](../Atlas%20Protocol/schema-profile.md).
Core validates requests independently of SDK, and SDK validates responses before
exposing typed values. Node-specific storage, private SQL, and filesystem types stay inside Core.

Authorization, Tasks, transactions, file publication, recovery, and SDK workflows
remain ordinary handwritten code. Use supported libraries without a custom schema
compiler, blanket generated client/server layer, or generated database accessors.
The [build profile](build-profile.md) records exact locks and reproducible exports.
Protocol supplies its package, dependency lock, and qualification commands.
Core implements all 66 initial exchanges. The [SDK qualification](../Atlas%20SDK/qualification.md)
exercises client workflows against Core.

## Build and run

Use Node 24.22.1 and npm 11.19.0. From this directory:

```sh
export ATLAS_TEST_ROOT="$(mktemp -d /var/tmp/atlas-tests.XXXXXX)"
npm run protocol:prepare
npm ci --include=dev
npm run verify:inputs
npm test
npm run build:prepare
npm run image:build
npm run test:container
npm run fixture:retention
```

The entry points are `dist/runtime.js` in the container and `dist/cli.js` locally.
Use [local commands](lifecycle.md#commands) for setup and operation. Tests create fresh
owned installations under `ATLAS_TEST_ROOT`, outside the source workspace. When omitted,
the harness creates a new system temporary directory. Existing installations are never used.
See [qualification](qualification.md) for the limits of the evidence.

## Scope

This baseline covers one installation. Generic Plugin discovery and Operations,
Core-owned Plugin installation, supervision, and private dispatch are outside the
initial release. Independently operated integrations keep using public HTTP and
credentials, without Core managing their processes or promising their recovery.
Clustering, federation, operational backup/restore, operational-data migrations,
and automatic mission recovery across Core restart are also outside scope.

## Reading order

[Storage](storage.md) → [Database worker](database.md) → [Lifecycle](lifecycle.md) →
[Service readiness](readiness.md) → [Fusion](fusion.md) → [Diagnostics](diagnostics.md) →
[Qualification](qualification.md).

[Limits](limits.md) bounds admission. [Lifecycle](lifecycle.md) owns local commands
and destructive recovery. Shared behavior remains in [Protocol](../Atlas%20Protocol/README.md).
