# Atlas Protocol

`protocol.json` authors shared wire definitions and the 19 direct-IP operational routes required by [S1 #122](https://github.com/atlas-field-systems/atlas-core/issues/122). Its unpublished `0.1.0` edition is for local qualification, without a released compatibility claim. See [generation policy](../docs/adr/0011-generate-shared-contracts-with-minimal-customization.md), [S0 coverage](../tests/contract/README.md), and the [operational encoding](operational-contract.md). Authored routes require operational Core/SDK workflow evidence before completion.

The separate [private Plugin dispatch artifact](plugin-dispatch.json) belongs to the [focused bookkeeping component](../Atlas%20Core/plugins/README.md#persistence-and-contract-source), independently of public HTTP generation and SDK routes.

Protocol owns identifiers, counters, Dataset/version context, typed Asset/Task/queue resources, Enrollment grants, process claims, report acceptance, sparse telemetry, movement pages and the implemented Command Catalog. `NullableIdentifier` keeps explicit null separate from omission. Remaining Entity variants and Commands belong to their owning slices. Schema validation does not replace Core's authority, counter-range, transition or freshness decisions. [Catalog checks](../tests/contract/README-99.md) qualify inputs and metadata separately from operational admission/execution.

Slice 0's required `process_proof` and `contact_challenge` fields qualify the direct IP report-context representation only. The [trusted gateway decision](../docs/adr/0028-trust-gateways-to-author-bound-asset-reports.md) allows a bound gateway to construct reports without an originating Asset's Core-format signature. Concrete gateway authority and freshness fields remain future Protocol work with that integration; the current fixture does not qualify gateway reporting.

`MovementObservationTime` and `ReportContext` retain `clock_uncertainty_ms` as optional nullable compatibility metadata under [ADR-0029](../docs/adr/0029-use-deployment-clocks-and-preserve-event-times.md), without computation or an S1 uncertainty budget. `SourceInstant` and `NullableSourceInstant` keep the accepted source string spelling while retaining date-time validation; their supported `x-go-type: string` annotation prevents generated Go from rewriting it. The current Catalog advertises only queued coordinate-target Move To. Broader target/Pause definitions remain structural examples for S6 and are absent from operational lookup.

Run from the repository root with Python 3.12+, Linux amd64, Node 24.21.0 and npm 11.19.0:

```sh
python3 scripts/verify.py --bootstrap
```

The entry point checks exact versions, downloads checksum-pinned Go/sqlc/Ruff when absent, installs npm dependencies locally, verifies both Go module graphs, and regenerates from absent outputs twice. It then runs Go formatting/build/test/vet, Prettier formatting of handwritten TypeScript/JavaScript, Ruff formatting and lint of repository Python, strict TypeScript checking, SDK compilation, and real contract workflows. No global generator or npm package installation is needed. `ATLAS_TOOLS` selects another user-owned cache; the default is `$XDG_CACHE_HOME/atlas-protocol-tools` or `~/.cache/atlas-protocol-tools`. Fresh downloaded archives are checked before extraction; cached executables must still report their locked versions. `python3 -O scripts/verify.py --toolchain-self-test` also executes the deliberately wrong checksum/version checks.

Go tests execute freshly on every verification run while compilation and dependency caches remain available; a real external-corpus regression checks that execution policy.

Apply the checked formatting (Prettier, then Ruff import order and formatting) after a bootstrap run. The shared settings live in `.prettierrc.json` and `ruff.toml` at the repository root:

```sh
python3 scripts/format.py
```

Generation alone, after locked dependencies have been installed:

```sh
python3 scripts/generate.py
```

Generated directories are ignored build artifacts. Delete them freely. Never edit or post-process them. `scripts/generate.py` assembles canonical components with fixture-owned paths from sorted `tests/contract/*.contract.json` fragments, rejects duplicate paths/components, and invokes supported generators with small configurations. Public strict server bindings come from `protocol.json`; fixture bindings contain only fixture operations; private query bindings come from authored SQL. Fixture declarations cannot replace canonical facts.

| Owner | Authored files and locks |
| --- | --- |
| Protocol | `protocol.json`, `toolchain.json`, `tools/go.mod`, `tools/go.sum`, generator configuration; exact OpenAPI, generator and Ruff editions |
| Core | `../Atlas Core/go.mod`, `go.sum`, `httpcontract/`; request-validation integration, nullable/runtime bindings and SQLite dependencies |
| SDK | `../Atlas SDK/package.json`, `package-lock.json`, `src/`; TypeScript transport, Ajv response-validation integration and local npm tooling locks |
| Test tooling | `../tests/contract/`; illustrative contracts, expectations, runner, private SQL; `../Atlas Core/tests/contractfixture/` for handwritten fixture handlers |

## Exact qualified pins

These preserve the [#69 proof](../docs/research/atlas-reassessment/13-protocol-toolchain-proof.md), which remains unchanged as research prior art.

| Tool or dependency | Version |
| --- | --- |
| OpenAPI | 3.0.3 |
| Go, Node, npm | 1.27.1, 24.21.0, 11.19.0 |
| oapi-codegen, sqlc | 2.8.0, 1.31.1 |
| Generator kin-openapi parser | 0.142.0, separate Protocol tool module graph |
| Core kin-openapi validator | 0.149.0, separate Core runtime module graph |
| oapi-codegen runtime, nullable, nethttp-middleware | 1.7.0, 1.2.0, 1.2.0 |
| modernc.org/sqlite, embedded SQLite | 1.60.1, 3.53.4 |
| openapi-typescript, openapi-fetch | 7.13.0, 0.17.0 |
| Ajv, ajv-formats | 8.20.0, 3.0.1 |
| TypeScript, tsx, Node types | 5.9.3, 4.23.15, 24.10.1 |
| Prettier (SDK npm lock), Ruff | 3.9.9, 0.16.10 |

Go archive SHA-256: `63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445`.

sqlc archive SHA-256: `497ae4fcdfa64c5b0c311ffe4c2bd991e43991e82e5367792ed78bc2dca27354`.

Ruff archive SHA-256: `9567ff1201e2fb3da31ff04c35587d768c66d6cb42dfa84de474e2bfe360b608`.

## Supported schema profile

The [research qualification](../docs/research/atlas-reassessment/13-protocol-toolchain-proof.md#supported-schema-profile) defines the retained profile: named component schemas and local references; explicit required/closed objects; nullable scalars, arrays and directly named nullable objects; typed dictionaries; nested partial updates; typed arrays, enums, bounds, UUID formats and decimal patterns; tagged `oneOf` variants; simple response-context `allOf`; JSON and bounded binary bindings. The [Slice 0 coverage records](../tests/contract/README.md) distinguish executed checks against these deliverables from prior-art and pending qualification.

Position always supplies both latitude and longitude. Each coordinate explicitly uses `format: double`, producing Go `float64`. Decimal tokens stay strings across generated bindings. The profile check rejects trailing newline/CRLF and noncanonical decimal representations in both the pinned SDK schema consumer and real Go HTTP validation. No coercion, default insertion or deletion of unknown fields is enabled.

Ajv keeps strict schema checking except `strictRequired`, a compilation diagnostic that treats a field required by one `allOf` member as undeclared when another member defines it. Runtime `required` validation remains enabled. An independent profile check confirms the composed mutation context rejects an absent commit cursor. This is a supported adapter configuration, not another declaration of that field.

The SDK response adapter qualifies explicit three-digit HTTP status codes from `100` through `599` with inline Response Objects and local Header Object references. Construction rejects `default`, status ranges such as `2XX` and other malformed status keys, including mixed exact/fallback declarations, before requests. Fallback and range matching remain unqualified. Response Object `$ref` resolution remains unqualified; local Header references do not establish general reference resolution.

At each exact status, the adapter qualifies separately declared `application/json`, JSON suffix media such as `application/problem+json`, and binary alternatives. It selects the authored schema by the received media type, refuses colliding normalized JSON declarations and requires an explicit JSON response byte bound; [response coverage](../tests/contract/README-97.md) records the independent HTTP checks.

S1's focused schema consumers additionally qualify `not` with a singleton numeric enum for heading's exclusive upper boundary and `x-go-type: string` source timestamps. External references, recursive schemas, other composition profiles, nullable enum combinations, OpenAPI 3.1/3.2 features and custom endpoint templates remain unqualified. A new feature needs an independent fixture and executed check before adoption. Operational range, authority and cross-field decisions stay with their owning modules.

### Binding representation limits

Generated Go UUID and ordinary date-time bindings can change a valid string's spelling when re-encoding it. For example, uppercase or UUID URN inputs become bare lowercase UUIDs, and ordinary date-times ending in `+00:00` or `.500Z` become `Z` or `.5Z`. Shared source times use the named string bindings above and retain their original spelling; Core-owned times still use ordinary date-time bindings.

Slice 0 does not qualify signing or canonicalization. The operational [signed-report workflow](../docs/topics/asset-reporting.md#shared-report-context) canonicalizes validated original facts instead of reconstructing them from normalized values. Its encoding is in [the operational contract](operational-contract.md#enrollment-and-signatures).

### JSON request representation

A JSON request contains one complete UTF-8 document. Object member names must be unique within each object after JSON escape decoding, including objects nested in arrays. Reject duplicate names before schema validation and typed decoding so both consumers see the same value.

String values and member names must represent Unicode scalar values. Reject invalid UTF-8 and escaped unpaired surrogates such as `"\ud800"` or `"\udc00"` before decoding can replace them with `�`. Valid multibyte text, properly paired surrogate escapes and literal backslash text remain supported. The user selected rejection of unpaired surrogate escapes in the [3 October decision](../docs/planning-reconciliation.md#json-request-representation-3-october-2026).

The Core adapter requires an explicit positive request-body bound and applies it before document or schema checks consume the stream. Oversized bodies use the accepted [`payload_too_large`/413 refusal](../docs/architecture/operating-model.md#workload-fixtures-and-admission-bounds). Fixture limits are qualification values, not production sizing. The [request checks](../tests/contract/README-96.md) verify rejection without persistence effects and valid Unicode round trips.
