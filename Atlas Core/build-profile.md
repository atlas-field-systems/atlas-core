# Build and schema profile

Protocol supplies executable schemas, exact boundary adapters, dependency locks,
and stock reference export. Its [qualification commands](../Atlas%20Protocol/qualification.md)
exercise built packages. Core has an executable server and functional workflows.
SDK supplies separate [client qualification](../Atlas%20SDK/qualification.md).
Sustained deployment gates remain unqualified.

## Reproducible build inputs

The build records one exact Protocol version and artifact SHA-256 shared by Core
and SDK. The release manifest records source revision, export hashes, schema profile
revision, target OS/architecture, Node.js and package-manager versions, and exact
schema, exporter, validator, database, and build-tool dependencies.

Lock direct and transitive dependencies with integrity hashes. Pin build and runtime
container images by digest. No floating tags, implicit global tools, or automatic
upgrades. The committed lock supplies the selected versions.

Use a supported Node.js LTS release and a Debian-based image, pinned by digest.
Keep SQLite, WAL, Object files, and owned logs in explicit persistent local mounts.
Qualify target architecture, native driver compatibility, permissions, shutdown,
and same-filesystem Object installation. The container writable layer is not retained storage.

A clean build uses frozen locks and fails on a mismatch. Stock tooling exports
checked-in runtime schemas with stable ordering, line endings, and no timestamps
or absolute build paths. Two clean exports from identical locked inputs must
produce identical files. Never patch generated output or build a custom compiler.
Private handwritten SQL and storage adapters stay behind Core modules. Protocol
never acquires database types or Node-specific dependencies.

Selected inputs: Node 24.22.1, npm 11.19.0, Fastify 5.12.7, multipart 10.1.6,
websocket 11.3.4, better-sqlite3 13.0.3, and embedded SQLite 3.53.4.
`package.json.atlasBuild` pins the Protocol hash and Debian amd64 image digest.
The base image bundles a newer npm; the build verifies and installs the pinned npm
artifact before frozen installation. `verify:inputs` queries the native engine.

After a clean committed build, run `npm run reference:export`,
`npm run release:source`, and `npm run release:manifest`. Ignored `artifacts/` contains
the checked stock reference, source archive, image ID, engine/build inputs, and
release manifest. Manifest generation rejects dirty source or mismatched image inputs.

`source.tar` exports the repository under `atlas/`, including Core and Protocol.
From Core in the matching release checkout, run `npm run release:consume`, or
`npm run release:consume -- /absolute/source.tar /absolute/release-manifest.json`.
The consumer checks the paired archive hash and both manifests and locks. It
extracts outside Git, prepares Protocol, frozen-installs Core and builds it.
Protocol, dependency, schema and native-engine inputs must match the release.
Git archives omit `.git`. The consumer supplies `ATLAS_SOURCE_REVISION`,
`ATLAS_SOURCE_TREE` and `ATLAS_SOURCE_DIRTY=false` from verified paired metadata.
Image builds and manifest generation still require the clean release checkout.

## Contract compatibility

The required current-result timing metadata changes the strict wire contract.
Timing metadata introduced 0.2.0; the required Task execution summary introduces
0.3.0. Neither reuses an older strict contract version. No product release tag
exists for 0.1.0. Clients declaring an older version are refused.
Existing 0.1.0 operational data lacks retained non-position status;
startup refuses its evidence format rather than inventing admission facts. Use a
fresh installation for 0.3.0 with private database format 4. Formats 1 through 3
are refused before interpreting images. Asset-reported Tags introduce Protocol
0.4.0 while retaining database format 4 because the new section is optional.
The supported [update command](lifecycle.md#commands) resets operational data
before changing software and retains credentials and operator profiles. Use that
path for upgrades and downgrades; older readers cannot parse retained tagged
images. Direct image substitution is unsupported. Operational-data migration
remains outside this release.

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

Exercise the actual Fastify adapter and [database worker](database.md), including
bounded queue refusal and worker loss after commit. Record the embedded SQLite
identity and queried-back WAL/FULL settings. Include exact SQL counter/time/alias
round trips and concurrent capture/checkpoint work. Framework or driver defaults
are not evidence that Atlas's boundary or durability rules hold.

Unsupported export behavior blocks selection of that tooling. Use an equivalent
allowed schema or a narrow boundary adapter with independent examples. Do not
weaken Protocol or fork the exporter. Reproducibility does not establish durability,
capacity, physical execution, or runtime conformance. Protocol commands live in
its qualification guide. Core commands live in its README. SDK supplies its
commands with its implementation.
