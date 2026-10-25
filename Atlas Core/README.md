# Atlas Core

**Core is the running authority for one Atlas installation.** It validates requests,
records intent and evidence, stores data, and serves clients. It does not fly the
drone or turn a network acknowledgment into physical success.

## Deployment

Start with one TypeScript server on Node.js, ordinary internal modules, one SQLite
database in WAL mode, and local Object files. Core runs in a Docker container on
a Linux host. Explicit local TypeScript commands control its lifecycle and settings.
These are implementation choices, not Protocol requirements.

Operators and independent integrations connect over adequate IP using the SDK or
public HTTP API with credentials. Gateway software and constrained-radio transport
are separate projects. The operator UI is a separate Atlas project; closing it
does not stop Core. The [operating environment](../operating-environment.md) assumes
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

## Shared boundary, private mechanisms

Core and SDK consume one browser-safe TypeScript Protocol package of runtime
schemas and inferred types. Stock tooling exports its portable OpenAPI reference
under the [schema profile](../Atlas%20Protocol/schema-profile.md).
Core validates requests independently of SDK, and SDK validates responses before
exposing typed values. Node-specific storage, private SQL, and filesystem types stay inside Core.

Authorization, Task rules, transactions, file publication, recovery, and SDK workflows
remain ordinary handwritten code. No custom schema compiler, blanket generated
client/server layer, or generated database accessor is required. Use supported
libraries and qualify schema/export equivalence before selecting exact versions.
The [build profile](build-profile.md) requires exact locks and reproducible exports.
Protocol supplies its package, dependency lock, and qualification commands.
Core and SDK have no implementation or qualified runtime yet.

## Scope

This baseline covers one installation. Generic Plugin discovery and Operations,
Core-owned Plugin installation, supervision, and private dispatch are outside the
initial release. Independently operated integrations keep using public HTTP and
credentials, without Core managing their processes or promising their recovery.
Clustering, federation, operational backup/restore, operational-data migrations,
and automatic mission recovery across Core restart are also outside scope.

## Reading order

[Storage](storage.md) → [Lifecycle](lifecycle.md) → [Fusion](fusion.md) →
[Diagnostics](diagnostics.md) → [Qualification](qualification.md).

[Limits](limits.md) bounds admission. [Lifecycle](lifecycle.md) owns local commands
and destructive recovery. Shared behavior remains in [Protocol](../Atlas%20Protocol/README.md).
