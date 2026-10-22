# Build and schema profile

This is the selected implementation profile, not a qualified toolchain. The current
repository has no executable schemas, locks, generated packages, or runtime evidence.
Implementation must supply the artifacts and pass the gates below before a release.

## Reproducible build inputs

The build records one exact Protocol version and artifact SHA-256 shared by Core
and SDK. Private Plugin dispatch has its own exact edition. The release manifest
records source revision, generated-output hashes, schema profile revision, target
OS/architecture, compiler/runtime versions, and all generator and validator versions.

Pin the Go toolchain, `oapi-codegen`, and `sqlc` to exact versions and module checksums.
Pin the JavaScript runtime and package manager. Lock `openapi-typescript`,
`openapi-fetch`, validators, and the lossless JSON codec, including transitive
dependencies and integrity hashes. Pin build and runtime container images by digest.
No floating tags, version ranges, implicit global tools, or generator auto-upgrades.
Select actual available versions during implementation and commit those locks.
This page deliberately assigns no unverified tool release numbers.

A clean build uses frozen locks and fails on a mismatch. Generation uses stock
configuration and checked-in source artifacts, with stable ordering, line endings,
and no timestamps or absolute build paths in output. Two clean builds from the same
locked inputs must produce identical generated files. Handwritten private SQL feeds
`sqlc`; Protocol never acquires storage types. Never patch generated output.

## Schema profile

The [Protocol schema profile](../Atlas%20Protocol/schema-profile.md) alone selects
the OpenAPI edition, schema vocabulary, composition, and null representation.
Core's build must preserve those definitions with stock generation, including
closed tagged alternatives and omission versus explicit null.
Installed Plugin schemas use that supported vocabulary and local references.
Plugin payloads remain lossless JSON under their installed schemas and message limits.

Use explicit min/max lengths, item/property counts, numeric bounds, and patterns.
Require `additionalProperties: false` on closed objects. Validate formats explicitly
at consuming boundaries; do not rely on an annotation enabling a validator option.
UUIDs, UTC nanosecond timestamps, exact integer tokens, uint64 decimal strings,
geometry topology, and cross-field relationships need the checks defined by Protocol.
No coercion, default insertion, property removal, or shared global validator mutation.

## Lossless boundary

Validate bounded original UTF-8 before typed decoding. Reject duplicate decoded keys,
malformed strings, excessive structure, and invalid numeric tokens before information
can disappear. Protocol's numeric ranges apply to exact source values, not rounded
binary64 results. Known spatial values may then use double precision.

Operation payloads use a browser-compatible lossless JSON tree. Number leaves retain
their original token text, including `1e-400`, precise decimals, and large integers.
Objects compare decoded keys without member-order significance; arrays retain order.
Numeric equality uses exact token spelling under [Operation rules](../Atlas%20Protocol/operations.md#payload-facts).
Absent members differ from null. Ordinary `JSON.parse` into numbers and decode into
Go `float64` maps are not payload fallbacks. Serialization preserves the same facts.
No parser/generator agreement alone is an independent oracle.

## Required implementation qualification

Qualify the locked versions together on Go, supported Node.js, and actual supported
browsers before claiming those targets. Execute independent valid and invalid cases
through SDK caller validation, serialization, direct HTTP, Core decoding, response
validation, and complete WebSocket frames. Include omitted/null/zero construction,
union alternatives, unknown properties, duplicate escaped keys, exact integer bounds,
and lossless payload round trips at byte/value/depth limits.

Verify generated declarations preserve nullable fields and required alternatives,
and that a consumer can install the built packages without source-tree imports.
Verify normal host validation settings remain unchanged, including concurrent use.
Stream binary adapters without passing file bytes through JSON validators.
Keep the [demonstrated boundary pitfalls](protocol-qualification.md) as regressions.

An unsupported profile feature fails the build. Resolve it by using an equivalent
allowed schema or a narrow handwritten boundary adapter with independent examples.
Do not weaken accepted Protocol behavior, claim arbitrary schema support, or fork
the generator. Locks and passing generation establish reproducibility only. They
do not establish durability, capacity, physical execution, or runtime conformance.
