# Atlas Protocol

**Protocol is the shared language of Atlas, independent of a particular server.**
It defines resource shapes, messages, commands, errors, and externally observable
behavior. An implementation can conform without using Core's language or database.

## Design priorities

Protocol favors readable, strongly typed contracts that apply across Asset types,
implementation languages, and links. Use descriptive JSON field names and reusable
schemas that people can inspect.

Compact encodings can reduce bandwidth use without changing the readable public
contract. The compaction method remains undecided.

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
| Plugin | An independently installed processing or integration capability |
| Operation | One invocation of a Plugin capability, distinct from an Asset Task |

An installation also has setup that outlives a Dataset: credentials, configuration,
installed selections, and software. Dataset identity prevents old work from being
mistaken for a submission to a fresh system.

## Contract ownership

Author public schemas and Command metadata once in a language-neutral OpenAPI
artifact. Define reusable JSON components and their permitted compositions in
[Entities](entities.md#component-composition). HTTP and non-HTTP messages reuse
those definitions. [Messaging](messaging.md) describes the supported exchanges;
[Wire](wire.md) defines Core's IP binding. The Command Catalog is available locally;
it is not a network discovery service. Plugins may define specialized Operation
payloads, but cannot invent Entity components or Asset Commands.

Review concrete field proposals in the [component field reference](components/README.md).

Use standard generation for Go and TypeScript declarations and ordinary HTTP
bindings. Runtime validation must be integrated explicitly. Keep algorithms,
authorization, transitions, storage, and synchronization implementation out of
schemas and generator templates.
Schema validity alone does not establish authorization, identifier relationships,
or valid state transitions. Consuming Core and SDK code must check the relevant context.

Keep this folder self-contained so it can become its own repository. A separate
repository does not itself change compatibility policy: initially Core, SDK, and
Protocol share one exact version string. Each Core and SDK release supports that
one Protocol version; a mismatch is refused. There is no version-range negotiation,
automatic downgrade, or translation between versions. Plugins release independently.

## Reading order

[Entities](entities.md) → [Observations](observations.md) → [Tracks](tracks.md) →
[Identity](identity.md) → [Reports](reports.md) →
[Movement history](movement-history.md) →
[Tasks](tasks.md) → [Operations](operations.md) → [Objects](objects.md) →
[Messaging](messaging.md) → [Wire](wire.md) → [Synchronization](synchronization.md).

These pages specify behavior. Exact schemas, supported generator features, and
cross-language fixtures remain incomplete and unqualified.
