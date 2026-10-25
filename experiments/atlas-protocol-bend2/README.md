# Run Atlas Protocol in Bend2

This experiment implements Atlas Protocol 0.1.0 in Bend 2.0.39.
It validates and writes Protocol JSON, HTTP descriptors, and WSS frames.
Invalid input returns a bounded Protocol error. It performs no durable effects.
The existing [Protocol documentation](../../Atlas%20Protocol/README.md) defines the contract.

## Build

Install Clang 14 or newer. Run these commands from this directory.

```sh
sh scripts/install-bend.sh
sh scripts/build.sh
```

The installer checks the pinned official release archive's SHA-256.
Set `BEND` to an existing Bend 2.0.39 executable to use another installation.
The build produces `dist/atlas-protocol`, `dist/protocol.mjs`, and `dist/reference.mjs`.
The native executable requires no Node.js runtime.

## Validate a file

```sh
printf '%s' '{"latitude":51.5,"longitude":-0.1}' > position.json
dist/atlas-protocol read Position position.json
dist/atlas-protocol schemas
dist/atlas-protocol catalog
dist/atlas-protocol help
```

Successful reads print canonical JSON and exit zero.
Rejections print `{ "code": "...", "issues": [] }` to stderr and exit one.
Invalid command usage exits two.
`write` validates a constructed JSON value before serialization.
An optional boundary and budget file select lower admission limits.

`http-request` and `http-response` consume JSON descriptors.
Headers are arrays of `{ "name": "...", "value": "..." }`.
`body` and `uploadDescriptor` are byte arrays when present.
WSS commands consume original frame bytes and an optional context file.
Context fields retain the original package's names, such as `datasetId` and `requestId`.

## Run the checks

The tests reuse the original independent fixtures without changing their expectations.
Install the original package's locked test tools first.

```sh
(cd '../../Atlas Protocol' && npm ci --ignore-scripts)
sh scripts/verify.sh
```

`artifacts/verification.json` records fixture, route, and portable workflow results.
The native runner checks the same fixture corpus through subprocesses.
The focused suites cover exact numbers, strict JSON, schema data, semantic rules,
geometry, transport correlation, and command input/output.
Stock Redocly bundles and validates `artifacts/openapi.json` from the Bend schema data.
The reference retains public schemas that have no HTTP route, including WSS frames.
Error wording and code priority for several simultaneous failures can differ from TypeScript.

## Code entry points

`api.bend` exposes the consuming boundaries. `main.bend` owns command input/output.
`schemas.bend` and `exchanges.bend` own standard JSON Schema data and the operation catalog.
`rules.bend` and `geometry.bend` own stateless relationships and topology.
`numbers.bend` owns exact decimal admission, binary64 rounding, and canonical formatting.
`runtime.bend` combines these modules behind bounded read and write functions.

JavaScript files run tests or serialize standard reference data.
Protocol validation executes in Bend on both targets.
`unicode-data.bend` is generated data. Regenerate it with `scripts/generate-case-fold.mjs`.
Its license is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

These checks cover the stateless Protocol library. Core state, persistence, SDK
workflows, physical execution, and deployment capacity require their own qualification.
The optional BendTT kernel verdict requires Lean 4.34.0 and is separate from these checks.
