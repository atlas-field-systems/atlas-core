# Local representative Command Catalog

This is [ticket #99](https://github.com/atlas-field-systems/atlas-core/issues/99), within [Slice 0 #94](https://github.com/atlas-field-systems/atlas-core/issues/94). Run the shared command from [the fixture guide](README.md):

```sh
python3 scripts/verify.py --bootstrap
```

The public SDK export `lookupCommand(name)` returns an installed Command definition or `undefined`. Each definition contains its Protocol edition (`protocolVersion`), complete representative `metadata` copied from Protocol, canonical `inputSchema` reference and `validateInput(unknown)` function. SDK-authored members use camelCase; `metadata` keeps Protocol's snake_case names. Lookup and validation require no network or Core process. Metadata is immutable, and validation does not change the caller's input.

Protocol authors `MoveTo` and `Pause` inputs and their `x-atlas-command` metadata once. The metadata's containing schema establishes the association. Clean generation copies the same canonical `protocol.json` bytes into the SDK's disposable generated directory, so the package includes its own contract artifact. The SDK discovers the metadata and compiles references into that artifact with the existing pinned schema adapter. It declares no second input schema, custom generator template, operation wrapper or registration API. The normal verifier includes the copied artifact in its two fresh generation comparisons and SDK build/package isolation checks.

Move To preserves the accepted [spatial input](../../docs/topics/spatial-data.md#move-to), using `target.kind` with `position` or a `geofeature_id`. Both target variants use canonical shared definitions. Optional `target_altitude` is a sibling of `target` in this representative encoding and requires explicit WGS84 ellipsoid metres. Metadata permits queued and immediate scheduling, with queued as the default. Scheduling belongs to Task creation, not this input object, and schema validation never inserts a default. Pause keeps its tagged no-additional-input representation and immediate scheduling. Success descriptions name Asset-reported facts; lookup does not execute them.

| Requirement | Implementation | Executed evidence |
| --- | --- | --- |
| Local typed known/unknown lookup | Public SDK `lookupCommand`, with an inferred definition-or-undefined result | `catalog.test.ts` checks full independently authored Move To/Pause metadata, the unpublished edition, literal schema references and absent lookups |
| Canonical metadata/schema association | Metadata is attached to its named Protocol input; validators compile its corresponding canonical reference | Valid Move To/Pause inputs succeed and a different Command tag fails through the returned definition |
| Accepted Move To target and altitude | Protocol target union reuses `Position` and `Identifier`; explicit optional `TargetAltitude` | Handwritten `catalog-fixtures.json` covers named coordinates, Geofeature UUID, omitted altitude, zero and negative ellipsoid height |
| Structural rejection without altered input | Existing SDK Ajv adapter retains strict validation without coercion, defaults or property removal | Wrong/missing tags, mismatched/both target variants, incomplete or invalid coordinates, malformed/missing IDs, unsupported altitude reference and unknown fields fail; inputs remain equal to their independent original values |
| Generated public input and shared numeric facts | Supported generated TypeScript `MoveTo` type and canonical numeric schemas | JSON round-trip retains independently expected double coordinates; inclusive bounds succeed; nonfinite coordinates and heights fail |
| Clean reconstruction and consumer isolation | Verbatim canonical artifact copy inside the existing generation entry point | Two absent-output generations compare the artifact and generated bindings; strict TypeScript, SDK build/package checks and all existing contract workflows remain required |

These focused checks exercise the actual local package boundary, which an HTTP fixture cannot reach. They run automatically with the shared scenario discovery and CI. The first lookup test failed because the public export was absent; Pause then failed because its entry was absent; the accepted Geofeature target failed before its canonical variant was added.

The shared verifier's `.artifacts/verification.json` records the checked source revision, clean/dirty status, exact tool versions and generated digests. The required final evidence is its passing result at the committed clean revision. The [Protocol lock](../../Atlas%20Protocol/toolchain.json), Protocol/Core Go module graphs and SDK npm lock retain all existing exact pins; this ticket changes none.

Both entries carry `binding: "representative"`. This is incomplete Command input/catalog binding evidence, not a complete published Catalog, supported-release promise, live Geofeature resolution, Task admission or execution. A structural UUID check cannot establish that a point Geofeature exists or enforce its live-geometry cutoff. Full validity declarations, control ordering/expiry, queue behavior, immutable Task storage, Asset support and physical arrival remain with their operational slices. Public Protocol `paths` stays empty, and no Catalog HTTP route or remote lookup dependency is added.
