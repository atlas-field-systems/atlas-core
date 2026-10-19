# Atlas Protocol

Protocol is the shared language of Atlas. This self-contained package supplies
one authored [OpenAPI 3.1 contract](openapi.json), generated Go and TypeScript
declarations, runtime validation, HTTP and WebSocket binding checks, and fixtures.
Core server mechanisms and SDK client workflows remain separate work.

## Contract ownership

`openapi.json` owns exact version `0.1.0`, shared resource and message shapes,
routes, query values, replies, and local Catalog metadata. The Catalog contains
only `move_to`, `pause`, and `resume`. There is no Catalog network endpoint.
Core and SDK must support this exact version. Plugins release independently and
own specialized payload schemas through the declared `PluginPayload` boundary.
They cannot introduce Entity components or Asset Commands.

Generate declarations with stock oapi-codegen 2.8.0 and openapi-typescript 7.13.0.
Never edit `*.gen.go` or `*.gen.ts`. Go nullable wrappers preserve omitted, null,
and value states. UUIDs and timestamps remain validated strings. Quantities use
double precision; 64-bit counters remain decimal strings with checked range.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Dataset | One operational data lifetime, ending at Reset |
| Entity | An Asset, Track, or Geofeature with a stable identity |
| Asset | A reporting system that can execute supported Commands |
| Track | Observations owned by one publisher |
| Geofeature | An authored point, line, or polygon |
| Task | One request for an Asset to execute a Catalog Command |
| Object | Complete streaming file content plus metadata |
| Operation | One invocation of a Plugin capability |

## Verify and consume

Install Go 1.27.2, Node 24.21.0, and npm 11.19.0, then run from a clean checkout:

```bash
bash 'Atlas Protocol/verify.sh'
```

The command installs locked dependencies and the pinned generator, validates the
contract and independent inventory, compares regeneration, builds both consumers,
runs type rejection checks, vet, race tests, HTTP/WS and file fixtures, gate
canaries, and imports the built npm artifact and standalone Go module.
Use `bash scripts/generate.sh` from this folder after an intentional contract edit.

Go imports `atlas/protocol` from this module. TypeScript imports `@atlas/protocol`
from the npm package built by `npm run build` and `npm pack`.

```typescript
import {Decode, Encode} from '@atlas/protocol';
const position = Decode('Position', new TextEncoder().encode(
	'{"latitude":0,"longitude":90}'));
const wire = Encode('Position', position);
```

`Decode` validates before typed decoding. `Encode` checks supplied values and
validates encoded bytes. Go also exposes `ValidateJSON`. Direct generated JSON
helpers provide declarations and union access, without validation. Construct a Go
union variant through `Encode` then `Decode` before nesting it, so unset required
nullable fields cannot become explicit unknown values during generated marshaling.

`ValidateRequest` and `ValidateResponse` consume bodies. The caller owns the stream,
authentication, staging, and commitment. `CheckContent` verifies streaming length
and SHA-256. `ValidateFrame` checks one text frame against caller-owned connection
state. It runs no timer or connection loop. Limits are explicit and configurable;
defaults reflect provisional Core admission, 1 MiB JSON and 2 GB files. Synchronizing
callers supply their negotiated whole-message budget.

## Conformance limits

Fixtures qualify this package's stateless boundaries, not a Core server or SDK.
Core still owns credential validity, atomic commits, retries, source authority,
contact expiry, Task transitions, deletion guards, durable replay, and recovery.
Plugin owners validate their specialized payloads against the referenced release
schemas. Transport cancellation, persistent state, physical execution, deployment
capacity, and field thresholds need integration qualification. The TypeScript
runtime is qualified in Node 24. Browser bundling is not covered by verification.

## Reading order

[Entities](entities.md) → [Identity](identity.md) → [Reports](reports.md) →
[Tasks](tasks.md) → [Operations](operations.md) → [Objects](objects.md) →
[Messaging](messaging.md) → [Wire](wire.md) → [Synchronization](synchronization.md).
The [component reference](components/README.md) explains fields and units.
