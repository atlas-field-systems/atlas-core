# Atlas Protocol

**Protocol is the shared language of Atlas, independent of a particular server.**
It defines resource shapes, messages, commands, errors, and externally observable
behavior. An implementation can conform without using Core's language or database.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Dataset | One operational data lifetime, ending at Reset |
| Entity | An Asset, Track, or Geofeature with a stable identity |
| Asset | A system that reports state and can execute supported Commands |
| Track | Observations about something, owned by one publisher |
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
artifact. HTTP and non-HTTP messages reuse those definitions. The Command Catalog
is available locally; it is not a network discovery service. Plugins may define
specialized Operation payloads, but cannot invent Entity components or Asset Commands.

Use standard generation for Go and TypeScript declarations and ordinary HTTP
bindings. Runtime validation must be integrated explicitly. Keep algorithms,
authorization, transitions, storage, and synchronization implementation out of
schemas and generator templates.

Keep this folder self-contained so it can become its own repository. A separate
repository does not itself change compatibility policy: initially Core, SDK, and
Protocol share a release number. Peers negotiate explicitly supported editions;
equal major versions are not sufficient proof. Plugins release independently.

## Reading order

[Entities](entities.md) → [Identity](identity.md) → [Reports](reports.md) →
[Tasks](tasks.md) → [Operations](operations.md) → [Objects](objects.md) → [Wire](wire.md) →
[API](api.md) → [Synchronization](synchronization.md).

These pages specify behavior. Exact schemas, supported generator features, and
cross-language fixtures must be qualified as each workflow is implemented.
