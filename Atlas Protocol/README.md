# Atlas Protocol

**Protocol is the shared language of Atlas, independent of a particular server.**
It defines resource shapes, messages, commands, errors, and externally observable
behavior. An implementation can conform without using Core's language or database.

## Design priorities

Protocol favors readable, strongly typed contracts that apply across Asset types,
implementation languages, and links. Use descriptive JSON field names and reusable
schemas that people can inspect.

The initial binding is HTTP/JSON over TLS and WSS. Compact encodings and
constrained-radio bindings are outside the initial contract. Gateways can translate
external radio traffic while preserving original public evidence and retry facts.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Dataset | One operational data lifetime, ending at Reset |
| Entity | An Asset, Observation, Track, or Geofeature with a stable identity |
| Asset | A system that reports state and can execute supported Commands |
| Observation | One publisher's ongoing record of a detected subject |
| Track | Atlas's shared target identity and state, built from Observations |
| Fusion policy | Decides Observation-to-Track associations and Track state |
| Geofeature | An authored point, line, or polygon |
| Command | A Protocol-defined instruction and its validity rules |
| Task | One recorded request for an Asset to execute a Command |
| Object | Complete file content plus metadata |

An installation also has setup that outlives a Dataset: credentials, configuration,
and software. Dataset identity prevents old work from being mistaken for a
submission to a fresh system.

## Contract ownership

The [schema profile](schema-profile.md) selects one browser-safe TypeScript package
of runtime schemas and inferred public types, with a portable OpenAPI 3.1.0 export.
It encodes these contracts and the local [Command Catalog](command-catalog.md) once.
[Entities](entities.md#component-composition) defines reusable components and their
permitted compositions. HTTP and WSS reuse those definitions. [Messaging](messaging.md)
defines exchanges; [Wire](wire.md) defines Core's IP binding. The Catalog is a local
artifact, not network discovery. Concrete fields live in the
[component reference](components/README.md).

Core and SDK reuse shared runtime validation at consuming boundaries. Schema validity
alone does not establish authority, identifier relationships, or valid transitions.
Keep those checks, storage, algorithms, and workflow code in their owning modules.
Stock tooling exports the reference after qualification; there is no custom compiler
or blanket requirement to generate clients, servers, or database accessors.

Keep this folder self-contained so it can become its own repository. A separate
repository does not itself change compatibility policy: initially Core, SDK, and
Protocol share one exact version string. Each Core and SDK release supports that
one Protocol version; a mismatch is refused. There is no version-range negotiation,
automatic downgrade, or translation between versions.

## Reading order

[Entities](entities.md) → [Observations](observations.md) → [Tracks](tracks.md) →
[Identity](identity.md) → [Reports](reports.md) →
[Movement history](movement-history.md) →
[Tasks](tasks.md) → [Objects](objects.md) →
[Messaging](messaging.md) → [Wire](wire.md) → [Synchronization](synchronization.md).

[Operators](operators.md) defines profile lifecycle. [Report format](report-format.md)
and [execution evidence](execution-evidence.md) define the separate source envelopes.

These pages own behavior, message fields, and bounds. The [package guide](package-usage.md)
covers @atlas/protocol 0.3.0, inferred types, exact boundaries, and stock reference
export. [Qualification](qualification.md) runs built-package checks and the independent
fixture corpus. Core and SDK own separate qualification of their consuming workflows.
Protocol-only checks establish neither server durability nor supported deployment capacity.
