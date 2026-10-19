# Atlas Protocol

Protocol is the shared language of Atlas. This self-contained package supplies
one authored [OpenAPI 3.1 contract](openapi.json), generated declarations, validation,
HTTP and WebSocket checks, and fixtures. Core and SDK runtimes remain separate work.

## Contract ownership

`openapi.json` owns exact version `0.1.0`, shared resource and message shapes,
routes, query values, replies, and local Catalog metadata. The Catalog contains
only `move_to`, `pause`, and `resume`. There is no Catalog network endpoint.
Core and SDK must support this exact version. Plugins release independently and
own specialized schemas at `PluginPayload`, without new Entity components or Commands.

Stock generators are oapi-codegen 2.8.0 and openapi-typescript 7.13.0.
Never edit `*.gen.go` or `*.gen.ts`. Go nullable wrappers preserve omitted, null,
and value states. UUIDs and timestamps stay strings. Spatial quantities use
doubles; 64-bit counters use decimal strings with checked range.

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

The command checks the contract and inventory, deterministic stock generation,
both consumer builds, type rejection, vet, race tests, HTTP/WS and file fixtures,
gate canaries, and standalone Go and built npm consumption.
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
validates encoded bytes. Supply JSON values and omit unused optional properties;
explicit `undefined` is rejected. Go also exposes `ValidateJSON`. Direct generated JSON
helpers provide declarations and union access, without validation. Construct a Go
union with `Variant[TelemetrySection]("TelemetryValue", "TelemetrySection", value, limits)`
before nesting it. This validates required nullable fields before stock marshaling
can fabricate real zero readings from omitted fields. Unchecked generated `From*`,
`Merge*`, and JSON methods cannot recover those omissions.
Go nullable roots use `nullable.Nullable[T]`. `PluginPayload` uses `json.RawMessage`.
Every TypeScript Plugin number is an immutable native raw JSON atom.
`PluginNumberText(value)` returns its exact numeric token or `undefined`.
Construct exact Plugin values with `Decode('PluginPayload', bytes)`. Copy them
with `Encode` and `Decode`. `structuredClone` refuses native atoms in Node 24.
Supplied JS numbers retain only the digits already present in memory.
Source-aware parsing, `rawJSON`, and `isRawJSON` are required at module load.
Unsupported runtimes fail locally.

`ValidateRequest` returns checked query JSON in `Query` or `query`. Use `Decode`
with the operation's query schema to read it, including mathematical integer spellings.
`ValidateRequest` and `ValidateResponse` consume bodies. The caller owns the stream,
authentication, staging, and commitment. `CheckContent` verifies streaming length
and SHA-256. `ValidateFrame` checks one text frame against caller-owned connection
state. Default limits reflect provisional Core admission, 1 MiB JSON and 2 GB files.
Synchronizing callers supply their negotiated whole-message budget.

## Conformance limits

Fixtures qualify this package's stateless boundaries, not a Core server or SDK.
Core owns credential validity, commits, retries, source authority, contact expiry,
Task transitions, deletion guards, replay, and recovery.
Validation failures are local diagnostics. Core chooses wire `ErrorResponse` values.
A response validation failure does not determine whether its mutation committed.
Host validators cannot change Protocol acceptance, and Protocol leaves their policy
unchanged. Invalid or unprepared contract rules refuse locally.
Plugin owners validate their specialized payloads against the referenced release
schemas. Transport cancellation, persistent state, physical execution, deployment
capacity, and field thresholds need integration qualification. The TypeScript
runtime is qualified in Node 24. Browser bundling is not covered by verification.

## Reading order

[Entities](entities.md) → [Identity](identity.md) → [Reports](reports.md) →
[Tasks](tasks.md) → [Operations](operations.md) → [Objects](objects.md) →
[Messaging](messaging.md) → [Wire](wire.md) → [Synchronization](synchronization.md).
[Component reference](components/README.md) covers fields and units.
