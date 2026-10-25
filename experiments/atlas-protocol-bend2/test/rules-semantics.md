# Refinement integration

This inventory describes the Bend refinement hooks and focused tests.
The original Protocol source and owning documents remain the behavior contracts.

## API

Both production modules import only pure Bend modules and Base definitions.
`C` refers to `common.bend`. Every failure has an empty issue list.

```text
rules.refine(name: String, value: C.Json) -> Result<&2, &2, C.Failure, Unit>
rules.scope(name: String, value: C.Json) -> C.Code
geometry.check(value: C.Json) -> Result<&2, &2, C.Failure, Unit>
geometry.reserve(value: C.Json, budget: C.Budget) -> Result<&2, &2, C.Failure, Unit>
```

The interpreter calls `refine` after structural checks and child number formatting.
It calls referenced child titles independently. The hook does not walk children.
Unknown titles pass. `geometry.check` also assumes structural acceptance.
The consuming boundary calls `geometry.reserve` on the complete parsed tree before
coordinate conversion, topology allocation, or schema interpretation.

`scope` handles `Point`, `LineString`, `Polygon`, and `Geometry`.
An unsupported string geometry type gives `UnsupportedGeometry`; other geometry
shape failures give `InvalidGeometry`. Other titles give `InvalidValue`.
Section metadata failures therefore keep `InvalidValue`.
A value-state Geometry section missing its value gives `InvalidGeometry`.

## Handled refinement titles

| Titles | Additional predicate |
| --- | --- |
| `Uuid`, `NewId` | Exact lowercase UUID spelling and UUIDv4 version/variant for new IDs. |
| `Counter`, `Sequence`, `ObjectLength` | Canonical bounded decimal strings, with positive Sequence. |
| `Secret` | Canonical 256-bit base64url token and permitted final bits. |
| `Timestamp` | Actual Gregorian date and clock fields, with exact nanoseconds. |
| `ContentType`, `Sha256` | Parameter-free ASCII media token and lowercase 64-digit digest. |
| `Attitude`, `Gimbal` | Null undefined angles at converted pitch/elevation of either 90-degree pole. |
| `Power` | Unique reserve IDs, including across different reserve kinds. |
| `LineString`, `Polygon` | Supported exact longitude extent and edges. Polygon also checks topology below. |
| `InputSection.status`, `InputSection.communications`, `InputSection.telemetry`, `InputSection.attitude`, `InputSection.power`, `InputSection.camera`, `InputSection.camera_optics`, `InputSection.gimbal`, `InputSection.type`, `InputSection.geometry` | Applicable source-time keys. Power requires current reserve IDs and battery-only overrides. Telemetry requires equal airspeed presence in values and constituents. |
| `ReadSection.status`, `ReadSection.communications`, `ReadSection.telemetry`, `ReadSection.attitude`, `ReadSection.power`, `ReadSection.camera`, `ReadSection.camera_optics`, `ReadSection.gimbal`, `ReadSection.type`, `ReadSection.geometry` | The same section checks. Null evidence permits only exact initial Status, Capacity, and SubjectType values with initial metadata and absent overrides. |
| `AssetReport`, `ObservationReport` | Report content and constituent origin context. Asset contact proof requires a generation time. |
| `Asset`, `Observation`, `Track` | Section Dataset, Entity, origin, and publisher/source scope. Reused scoped report IDs require equal sequence. Observation and Track reject overlapping Entity IDs. Retained older Asset process origins remain valid. |
| `ResultDeclarations` | Unique result Object IDs. |
| `DeclarationBatch` | Repeated Object IDs may repeat the same required flag but cannot change it. |
| `TaskQueue` | Confirmation revision cannot exceed the current revision. |
| `TaskControl` | Revision zero iff no request. Confirmations are positive and not future. Current confirmations match the requested Task and queue effect. |
| `Task` | Resume expiry is strictly after acceptance and at most 60 seconds later. |
| `ExecutionPayload` | Resume effect has captured_at <= applied_at < instructions_valid_until, including equal capture/application instants as in TypeScript. |
| `Activity` | Deleted attribution requires an Operator ID. |
| `HistoryReading`, `HistoryFirst`, `HistoryPage` | Unknown time iff null. Exact strictly ordered query bounds. Unique full reading scope, known times first, exact instant order, then complete identity order. Unknown and uncertain share identity ordering. |
| `AssignedTasks` | Exactly ten seconds of instruction validity. Matching Asset, nonterminal Tasks, and strictly increasing Task IDs. |
| `BeginAssetContact`, `ContactChallenge`, `ReplaceAssetProcess` | Changed replacement generation. Challenge lifetime from 1 ns through ten seconds. First report matches Asset, generation, current mode, and challenge proof. |
| `Put`, `Changes`, `SnapshotPage` | Concrete resource ID/version consistency, unique resource keys, strict snapshot resource order, and negotiated snapshot count. |
| `ChangeBatchData`, `LiveChangeBatchData` | Batch cursor advances. |
| `ReplayPage` | Contiguous previous cursors, no advancing cursor cycles, matching last through cursor, and completion at the fixed boundary. Unchanged progress is allowed. |
| `ServerFrame` | Every nested Put image matches the frame Dataset in live batches, snapshots, and replay pages. |

Structural checks already cover `Command.move_to`, `Command.pause`, `Command.resume`,
`Capabilities`, `PowerTimes`, `Associations`, `ObjectEdits`, `TrackSource`,
`ErrorObject`, and `HttpError`. Their refinements pass after validated children.
Per-field bounds, arrays, nullability, and terminal cancellation variants remain
in schema data. Generic Unicode and numeric checks remain interpreter callbacks.

## Geometry

Coordinates are converted once into `numbers.Exact` per path. Exact signed limb
arithmetic checks orientation, area, bounds, and longitude steps greater than 180.
Edge bounding boxes prune pairs before orientation arithmetic.
The checks reject both longitude endpoint spellings in one path and Polygon edges
along a pole. Rings require closure, nonzero edges and area, no adjacent backtracking,
and no nonadjacent intersection, touching, or overlap. Either winding remains valid.

The reserve walk follows the original member traversal and refusal precedence.
It rejects holes and paths above 1,024 pairs, charges each Polygon `n*n + 8*n`,
and aggregates every nested changes array and qualifying snapshot items array.
Exhausted aggregate work or changes gives `ResourceLimit` before topology allocation.

## Verification and integration limits

Run `node --test test/geometry.test.mjs test/rules.test.mjs` from this directory.
Both test scripts compile native executables with Bend 2.0.39 and delete artifacts.
The semantic suite reuses the 157 non-budget raw-JSON independent fixture cases.
The tests use schema data from commit `28ea884` and the real schema interpreter.
Corpus cases have a finite ten-minute test timeout, with no latency target.
The initial 60-second timeout was insufficient for the complete geometry frame
and its out-of-range counterpart, which retains earlier valid large polygons.

The focused driver converts the schema's 309-digit binary64 maximum metadata to
its equivalent short binary64 bound before `numbers.accept`. Parent integration
must provide that conversion or equivalent support for schema metadata bounds.
Command IO, HTTP/WSS context and response correlation, stock reference tooling,
authority, and durable state transitions belong to the parent integration.

The optional `--verdict` kernel recheck could not run because Lean 4.34.0 was
unavailable. Normal Bend typechecking remains the compiler check used here.
