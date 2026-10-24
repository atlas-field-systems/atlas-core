# Build and schema profile

Protocol supplies executable schemas, exact boundary adapters, dependency locks,
and stock reference export. Its [qualification commands](../Atlas%20Protocol/qualification.md)
exercise built packages. Core and SDK remain unimplemented and must pass the
remaining integration and deployment gates before release.

## Reproducible build inputs

The build records one exact Protocol version and artifact SHA-256 shared by Core
and SDK. The release manifest records source revision, export hashes, schema profile
revision, target OS/architecture, Node.js and package-manager versions, and exact
schema, exporter, validator, database, and build-tool dependencies.

Lock direct and transitive dependencies with integrity hashes. Pin build and runtime
container images by digest. No floating tags, implicit global tools, or automatic
upgrades. Choose supported available versions during implementation and commit
those locks. This page assigns no unverified library release numbers.

A clean build uses frozen locks and fails on a mismatch. Stock tooling exports
checked-in runtime schemas with stable ordering, line endings, and no timestamps
or absolute build paths. Two clean exports from identical locked inputs must
produce identical files. Never patch generated output or build a custom compiler.
Private handwritten SQL and storage adapters stay behind Core modules. Protocol
never acquires database types or Node-specific dependencies.

## Shared schema profile

The [Protocol profile](../Atlas%20Protocol/schema-profile.md) owns runtime schema
vocabulary, the OpenAPI edition, composition, and null representation. One
browser-safe TypeScript source supplies inferred types and the portable reference.
Core and SDK import it rather than independently describing request/response shapes.
Choose stock schema/export tooling only after proving equivalent meaning across
runtime acceptance and the OpenAPI export for the supported profile.

Declare explicit lengths, counts, numeric bounds, and patterns. Formats require
explicit consuming-boundary validation. UUIDs, UTC nanosecond timestamps, exact
integer tokens, uint64 decimal strings, geometry work, and cross-field relationships
need Protocol's checks. No coercion, default insertion, property removal, or shared
global validator mutation may change acceptance.

## Validate before information is lost

Validate bounded original UTF-8 before typed decoding. Reject duplicate decoded
keys, malformed strings, excessive structure, and invalid numeric tokens before
information disappears. Numeric ranges apply to exact source values, not rounded
binary64 results. Known spatial values may then use binary64 under Protocol rules.
Omission remains distinct from null and zero through construction and serialization.
Inferred types alone cannot establish runtime validity. Ordinary JSON number parsing
before exact token checks cannot enforce the original numeric contract.

## Required implementation qualification

Qualify locked versions on supported Node.js and actual supported browsers before
claiming those targets. Exercise SDK input validation, serialization, direct HTTP,
Core decoding, response validation, and complete WSS frames with independent valid
and invalid cases. Include omitted/null/zero, disjoint alternatives, unknown members,
duplicate escaped keys, exact bounds, and byte/value/depth limits.

Compare runtime schemas and the portable OpenAPI export against independent expected
results, including export constraints that annotations alone cannot enforce. Verify
a consumer can install built packages without source-tree imports. Check that the
shared package loads in browsers without Node storage or filesystem dependencies.
Verify host validation settings remain unchanged under concurrent use. Stream binary
adapters without passing file bytes through JSON validators. Preserve the
[demonstrated boundary pitfalls](protocol-qualification.md) as relevant regressions.

Unsupported export behavior blocks selection of that tooling. Use an equivalent
allowed schema or a narrow boundary adapter with independent examples. Do not
weaken Protocol or fork the exporter. Reproducibility does not establish durability,
capacity, physical execution, or runtime conformance. Protocol commands live in
its qualification guide. Core and SDK provide their own build and integration
commands when those implementations exist.
