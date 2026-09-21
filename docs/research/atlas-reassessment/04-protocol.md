# Atlas Protocol reassessment

Current reset contract: [ADR-0013](../../adr/0013-start-each-core-run-with-empty-data.md) supersedes earlier durability and cross-run retention recommendations. Every Core start wipes operational data. Data migrations, preserve-data restart and backup/restore are excluded from the successor; historical source observations below remain evidence, not requirements.


Successor decision update: [Core owns Commands and Assets execute Tasks](../../adr/0004-core-owns-commands-and-assets-execute-tasks.md). Plugins expose Operations, process data or ingest external sources; they cannot introduce Asset Commands or be taskable Tool Assets. [Planned stops and updates protect active Plugin work](../../adr/0006-protect-active-plugin-work-during-lifecycle-changes.md). Source descriptions below remain historical evidence; conflicting research proposals are superseded.

Planning update: [ADR-0001](../../adr/0001-release-core-sdk-and-protocol-together.md) accepts one release workflow and matching Core, SDK and Protocol versions, including unchanged components. [Compatible client versions are now accepted](../../adr/0005-allow-compatible-client-versions.md); concrete compatibility checks and upgrade overlap remain open. The [system outline](../../architecture/system-outline.md) is the current planning entry point; module and subsystem assignments in these research notes remain proposals. Permanent Plugins and combined backend/UI extensions are also under consideration, so lifetime alone does not determine placement.

Research date: 2026-09-20
Research timestamp: 2026-09-20T15:35:31-04:00

This note records a source review of the Atlas Protocol schema, generators,
runtime validators, cross-language consumers, and the adjacent radio contract.
It is research for the reassessment. It does not amend a design decision or
authorize implementation.

The source snapshot supplied for this review is the Atlas Modernization tree at
`8edee4e2743fbf0f85c16dfe638d9222141cf279`. It was unpacked at
`/private/tmp/atlas-core-reassessment-20260920` and did not contain Git
metadata, so source links use the supplied SHA. The destination worktree was
changed by this task only through this note. No application, issue, pull
request, or commit was changed by this task.

The planning constraints supplied with this review are treated as accepted
constraints: the successor may make breaking changes when they simplify the
system, its first deployment has one server and field devices connecting to
it, and Plugin packaging remains undecided. The last constraint permits
former Plugin capabilities to become Core modules or subsystems. It does not
permit collapsing the domain distinction between an Operation and a Task.

## Finding

[Proposal] The simplest credible first version is a reduced JSON-first device
contract with explicit message kinds, explicit task lifecycle messages, and a
small generated Go and TypeScript surface. Keep JSON Schema as the immediate
source format only if the successor deliberately limits itself to the subset
that its generators and validators implement. Do not make OpenAPI or TypeSpec
the canonical domain model merely to obtain HTTP documentation. Run a small
Protobuf experiment before choosing it for device transport, because compact
binary delivery may justify a second source format only if the device payload
and toolchain measurements require it. This is a device slice, not a proposal
to erase browser or operator-facing Core endpoints. Those endpoints need an
explicit API projection and admin-resource decision, even if they share the
same Asset, Operation, Task, and error definitions.

[Observed] The current Protocol is already a buildable Go module. Its
canonical source is a draft 2020-12 JSON Schema, with authored Go types,
generated Go validators and revision data, generated TypeScript types and
validators, examples, command catalog output, and a conformance corpus. The
Protocol README names the implemented surface as Entity, immutable Task,
Object, command catalog and manifest, requests, lifecycle, runtime,
telemetry check-in, query and revision, errors, feed, and validators
[
  source README
](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/README.md#L1-L42).

[Observed] The current build is healthy at the reviewed snapshot. With
`GOCACHE=/private/tmp/atlas-protocol-go-cache`, `go test ./...` passed in the
Protocol module, and `go run ./tools/check` reported that examples, Go
contracts, and generated artifacts are current. Those checks establish the
current implementation baseline. They do not establish that the current
shape is the right first-version boundary.

## Current contract inventory

| Area | Current source or artifact | Consumers and evidence | Reassessment reading |
| --- | --- | --- | --- |
| Canonical shape | `packages/protocol/schema/jsonschema/atlas.schema.json` | The Protocol README and schema generator load this bundle. The schema declares draft 2020-12 and `$defs` [schema](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L1-L6). | Keep one explicit source. Reduce the domain before changing the authoring technology. |
| Authored Go API | `packages/protocol/generated/go/atlasprotocol/types.go` | Go contract parity checks compare structs and enums to schema projections [contracts](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/go_contracts.go#L18-L37). | This is an ergonomic second authored surface inside a generated directory. Either move helpers beside plain generated wire structs, or document and test the projection as an intentional boundary. |
| Go runtime validation | Embedded schema plus `validator` package | `validator.go` compiles the bundle once, normalizes Go values to JSON, validates a named definition, then applies semantic rules [runtime validator](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/validator/validator.go#L1-L75). | Keep a small semantic rule registry. Do not pretend the JSON Schema alone defines polygon closure, aggregate geometry limits, command uniqueness, or duplicate feature IDs. |
| TypeScript output | `packages/protocol/generated/typescript/index.ts` | SDK reexports generated types and predicates from `packages/sdk/src/protocol.ts` [SDK bridge](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/protocol.ts#L1-L134). | Preserve generated client types if the public SDK remains TypeScript. Remove duplicated handwritten validator behavior where the reduced protocol can use one shared fixture corpus. |
| Schema to TypeScript generator | `tools/internal/artifacts/typescript_types.go` and `typescript_validators.go` | The generator handles refs, constants, enums, `anyOf`, `oneOf`, `allOf`, arrays, objects, and a custom runtime expression [TypeScript generator](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/typescript_validators.go#L10-L116). | The generator has become a small compiler. A reduced schema subset is a simpler option than growing this compiler. |
| Schema to Go parity | `go_contract_schema.go` plus static contract tables | The parity projection rejects some `oneOf` object unions, finite string domains, unsupported keywords, and tuple-only `prefixItems` [Go projection](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/go_contract_schema.go#L225-L309). | These restrictions are real design constraints. Publish them as a schema style guide or choose a generator that supports the needed subset. |
| Command catalog | Schema named definitions plus authored namespace JSON files | `command_catalog.go` reads namespace files, validates them, rejects duplicate names, sorts them, and emits `generated/command_catalog.json` [catalog generator](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/command_catalog.go#L20-L39). The command design explicitly calls the namespace files a second authored source [command docs](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L82-L106). | For a small device command set, put operation metadata and typed input/output references in one protocol-owned definition. Keep a separate catalog only if its authoring workflow is proven useful. |
| Revision | Raw bytes of schema plus path delimiters hashed with SHA-256 | `revision.go` hashes exact file bytes [revision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/revision.go#L12-L24). Core serves it and the SDK rejects mismatch [protocol docs](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/README.md#L39-L46). | Use a protocol version for compatibility. Keep an exact source hash as build metadata and drift evidence, not as the device handshake contract. |
| Conformance | Shared request validation JSON plus Go, Core HTTP, and SDK tests | Protocol embeds the corpus [corpus type](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/conformance/request_validation.go#L9-L32); Core consumes it [Core conformance](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/integration/request_conformance_test.go#L14-L93); SDK consumes the same cases [SDK conformance](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/test/request-conformance.test.ts#L1-L70). | Keep the shared corpus, add device-envelope and lifecycle cases, and make both language validators pass the same reduced fixture set. |
| Radio boundary | Link-side generated TypeScript contract | `generate-contract.mjs` reads the Protocol schema and revision, but also owns a hardcoded operation list [radio generator](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/scripts/generate-contract.mjs#L1-L116). The accepted decision says the Protocol is the sole source and Link generates the complete Radio contract [radio decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-02-meshtastic-radio-contract-is-generated-from-atlas-protocol.md#L3-L9). | Treat radio as an adapter. Move operation inventory into Protocol metadata or explicitly call the Link list a transport projection. Do not research or redesign the radio stack as part of this Protocol decision. |

The schema is broad for the stated first deployment. It has about 130 `$defs`,
31 `anyOf`, 5 `allOf`, 9 `if` and `then` pairs, 12 `not`, 56 `const`, and no
`oneOf`. The generated languages therefore depend on structural conventions,
including conditional cursor responses [cursor rules](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L12-L68), feed unions [feed](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L667-L710), recursive JSON values [JSON value](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L1136-L1162), and the status-specific TaskResource union [TaskResource](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L2330-L2699).

[Observed] Artifact tests intentionally reject drift in fields, requiredness,
nullability, field types, enums, unsupported `not`, overlapping unions, and
tuple-only arrays [Go contract tests](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/go_contracts_test.go#L11-L180). Keep those parity tests in any successor generator.

The Protocol documentation correctly says that schema validation is not the
whole semantic contract. The conformance corpus separates `schema_valid` from
full `valid` because polygon closure and aggregate position limits do not fit
the selected JSON Schema vocabulary [conformance boundary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/README.md#L26-L32). That distinction should remain explicit in a successor.

## Dependency decision table

This table distinguishes a direct Protocol dependency from a consumer or
development dependency. A package appearing in the repository does not make
it part of the Protocol wire contract.

| Dependency or technology | Current role | Successor disposition | Reason and falsifiable check |
| --- | --- | --- | --- |
| Go 1.26 and toolchain 1.26.5 | Protocol implementation, generator, tests | [Proposal] Keep for the Go server and generator if Go remains the server language. | It is an implementation choice, not a wire dependency. Recheck the smallest generated API and build time after reducing the schema. |
| `github.com/santhosh-tekuri/jsonschema/v6` 6.0.3 | Direct Protocol runtime compiler and validator | [Proposal] Keep for a JSON-first experiment, or replace with a standard generated validator only after measuring behavior parity. | `packages/protocol/go.mod` has one direct library plus indirect `x/text` [module](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/go.mod#L1-L9). Compile the reduced schema and run 100 shared fixtures in Go and TypeScript. |
| `golang.org/x/text` and `github.com/dlclark/regexp2` | Transitive support in the Go module | [Proposal] Keep transitive only if the selected validator still needs them. | Do not make an indirect library a domain decision. `go mod graph` and a clean module build are the gate. |
| Standard Go `encoding/json`, `embed`, `crypto/sha256`, reflection and AST packages | Normalization, schema embedding, hashing, code generation and parity checks | [Proposal] Keep only the standard-library pieces still needed. | A reduced source can remove reflection and custom compiler code. Measure generated code and handwritten helper count. |
| TypeScript 7, Biome, Vitest, Playwright, Node 24 | SDK build, tests, and generated TypeScript consumption | [Proposal] Keep at the SDK boundary; do not add these to the Go Protocol module. | The SDK package uses Node >=24 and TypeScript, Vitest, and Biome in its scripts [SDK package](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/package.json#L23-L80). Protocol itself has no npm runtime dependency. |
| Core Go module and local Protocol replace | Core imports generated Go Protocol types and validators | [Accepted planning constraint] Keep a single server-owned dependency edge in v1. | Core owns routes, auth, persistence, lifecycle, and deployment; Protocol owns portable shapes and validity [boundary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/README.md#L19-L35). Verify no schema package imports Core or database code. |
| SDK generated TypeScript import | Public clients use generated types, predicates, and revision | [Proposal] Keep if a TypeScript SDK remains. | The generated index is a public boundary. Replace exact-revision rejection with explicit protocol version handling in the successor. |
| Plugin Runtime and Plugin packages | Current private operation process, SDK clients, and independent release machinery | [Unknown] Remove as a required Protocol dependency while Plugin scope is undecided. If capabilities become Core modules, keep only the domain operation definitions that still have consumers. | The current Plugin release decision couples exact Protocol revision to independent packages [plugin release](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-01-plugins-release-independently-from-atlas-core.md#L3-L10). Breaking changes are allowed, so preserving this coupling has no first-version value. |
| `@bufbuild/protobuf` and Meshtastic packages | Adjacent Link transport, not Protocol direct dependency | [Proposal] Keep outside the Protocol module. Test Protobuf for a device projection before making it canonical. | Link currently depends on Buf, Meshtastic packages, SDK, and serialport [Link package](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/package.json#L36-L50). The Protocol should not import this stack. |
| `serialport` | Physical link adapter dependency | [Accepted boundary] Keep adjacent only. | It says nothing about domain shape, validation, or server compatibility. A radio projection may be generated from the Protocol but must not redefine it. |

The dependency cut is small: Go and one JSON Schema implementation for the
server-side experiment, with TypeScript tooling only at the SDK edge. Plugin
Runtime is conditional, not a reason to retain its current private machinery.

## Domain design for one server and field devices

### Invariants to retain

| Invariant | Current evidence | Successor treatment |
| --- | --- | --- |
| An Asset has one stable identity and one Asset Host relationship | Protocol and Core boundary documentation treats Asset identity and assignment as domain data. | [Proposal] Retain a small Device or Asset identity record. Do not copy the full current entity model until a device workflow needs it. |
| An Operation describes a capability or command | The tasking document defines an Operation-like command definition, with command name, input, output, catalog, and manifest [command vocabulary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L3-L49). | [Accepted planning constraint] Retain Operation as a capability description. It can live in a Core subsystem when Plugins disappear. |
| A Task is one execution of one command assigned to one Asset | The tasking docs state one Task has one Command and a fixed assigned Asset [task rules](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L37-L49). | [Accepted planning constraint] Retain this distinction. Do not turn every Operation response into a durable Task. |
| Task lifecycle is explicit | Current statuses are pending, acknowledged, in progress, completed, failed, and cancelled [lifecycle](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L296-L337). | [Proposal] Keep explicit offer, acknowledge, start, progress, complete, fail, and cancel messages. Keep transition rules in Core, with device acknowledgements and outcomes in the wire contract. |
| Lifecycle operations are named | Current docs intentionally use lifecycle routes and named request schemas rather than a generic Task patch [routes](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L341-L365). | [Proposal] Keep named lifecycle messages. This is easier to reason about on a field device and avoids a generic patch language for state transitions. |
| Idempotency and bounded outcomes matter | Current Task docs describe idempotency and bounded output summaries [task outcome](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L296-L337), while failures and cancellations use closed enums [failure model](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/commands-and-tasking.md#L419-L440). | [Proposal] Keep task IDs, request IDs, correlation IDs, bounded result summaries, and closed failure categories. Make duplicate delivery behavior a conformance case. |
| Protocol and Core have separate authority | Protocol owns shape and validity; Core owns routes, auth, persistence, lifecycle, order, safety, and delivery [boundary](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/atlas-protocol/README.md#L19-L35). | [Proposal] Keep this deep boundary even if the package layout changes. It is more important than preserving current directories. |

### First-version shape

[Proposal] A first server and field-device version should start with
`DeviceHello` and `ServerHello`; ready and heartbeat messages; bounded
telemetry or observation; Operation definitions with typed input and output;
Task offer, acknowledgement, progress, completion, failure, and cancellation;
bounded results or references; and transport or application error envelopes.

This is a proposal, not an accepted schema. It defers the current full feed,
Plugin status, Source Gateway, administrative and spatial operations, and
arbitrary Object surface until a concrete workflow needs them. A device may
send an observation without a Task, and a server may invoke a synchronous
Operation without creating a durable Task. A Task remains the durable
execution record rather than the universal event envelope.

[Unknown] The first device workload, maximum payload, offline duration, device
language, and need for compact binary are not established. Measure them rather
than infer them from the current MeshLink adapter.

## Schema and code generation choices

### Option A: reduced JSON Schema as canonical source

[Proposal] This is the lowest-risk immediate simplification if the first
device protocol remains JSON. Keep one bundle, explicit discriminators, closed
branches, named messages, and a documented keyword subset. Generate plain Go
wire structs and TypeScript types. Keep semantic checks in one small registry
with shared fixtures, and treat HTTP or feed documentation as a projection.

The official JSON Schema material defines newer array, dynamic-reference,
unevaluated, format, and bundling vocabularies [JSON Schema 2020-12](https://json-schema.org/draft/2020-12). The local generator does not implement every keyword: its TypeScript expression generator rejects some, and its Go projection rejects some unions and tuple forms. Declare the subset and reject other keywords at build time. `unevaluatedProperties` depends on annotation results from applicators [JSON Schema core](https://json-schema.org/draft/2020-12/json-schema-core), so do not claim full draft portability while using a partial compiler.

### Option B: OpenAPI 3.1 as canonical source

[Proposal] Use OpenAPI as a projection if HTTP descriptions are needed, not as
the device domain source. OpenAPI 3.1's Schema Object is a superset of JSON
Schema 2020-12 and its discriminator supports `oneOf`, `anyOf`, and `allOf`
[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0). It does not solve the
semantic registry, task transitions, idempotency, or device delivery.

### Option C: TypeSpec as canonical authoring language

[Proposal] Defer TypeSpec. It has declarations, imports, namespaces, and
decorators [overview](https://typespec.io/docs/language-basics/overview/), and
models can emit to OpenAPI [OpenAPI guide](https://typespec.io/docs/getting-started/typespec-for-openapi-dev/). It adds a compiler and another semantic source without directly providing Task transitions, shared validators, or the device envelope.

### Option D: Protobuf as canonical device source

[Proposal] Run this experiment if measured payload size or fragmentation makes
JSON too expensive. Protobuf gives generated APIs and a binary wire format; the
official guide recommends binary for cross-system communication [Protobuf Editions](https://protobuf.dev/programming-guides/editions/). Proto3 field numbers make additions wire-safe in many cases, while changing them is unsafe [evolution](https://protobuf.dev/programming-guides/proto3/); required fields were removed as an evolution tool [style guide](https://protobuf.dev/programming-guides/style/).

Protobuf requires choices for dynamic JSON, GeoJSON, large Object content,
unknown fields, and presence. ProtoJSON accepts proto and lower camel case
names, while unknown fields reject by default [ProtoJSON](https://protobuf.dev/programming-guides/json/). If it wins, use explicit `oneof` variants, reserve field numbers, bound dynamic values, and make Protobuf the only device source. Do not keep an untested JSON Schema and `.proto` pair. Authored Go is also rejected as the cross-language source: the SDK and Link already consume TypeScript, and a Go source would need another schema or reflection path.

## Patches, unions, versioning, and compatibility

### Patches

[Proposal] Do not put a generic JSON Patch language in the first task
contract. Keep named lifecycle operations. Add JSON Patch only when a measured
workflow needs arbitrary partial document edits and the team specifies path
allowlists, operation limits, array behavior, and failure atomicity. Never use
a generic patch to encode a Task transition.

### Unions

[Proposal] Every union branch should have one stable discriminator such as
`kind`, `status`, or `event`, and branches should be closed. The current schema
uses `anyOf` and `const` without `oneOf`, so generated Go and TypeScript rely on
custom projection rules. Make reduced JSON branches mutually exclusive. If
Protobuf is selected, map them to explicit `oneof` fields.

### Version and compatibility

[Accepted planning constraint] Breaking changes are allowed for the successor.
Do not preserve exact revision equality only to avoid migration work.

[Proposal] Put an integer protocol major in the device handshake and envelope.
Use a minor or capability set only if the first rollout genuinely needs
nonbreaking additive variation. Reject an unsupported major before accepting a
Task. Keep a source or build hash for diagnostics, generated artifact freshness,
and support reports. Do not use the raw-byte SHA as compatibility semantics.

This challenges a current choice. The docs call the revision a drift token,
but the SDK compares exact values and Plugin release couples to it. A
whitespace, description, or key-order change therefore creates a mismatch
without a domain change. The repository records this tension in the raw-schema
revision note [problem](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/problems/2026-09-18-protocol-revision-hashes-raw-schema.md#L1-L13). With Plugins undecided and breaking changes accepted, delete this coupling instead of adding canonicalization solely to preserve it.

## Radio as an adjacent boundary

[Observed] Link reads the canonical schema and revision, imports SDK types, and
emits operation maps. Its adapter dependencies include Buf, Meshtastic,
firmware protobufs, serialport, TypeScript, and test tooling [Link package](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/package.json#L36-L50).

[Observed] The source decision says Link is completely generated from Protocol,
yet the generator owns a hardcoded inventory of entity, task, runtime, object,
query, catalog, Plugin, and spatial operations [inventory](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/meshtastic-link/scripts/generate-contract.mjs#L11-L44).

[Proposal] Put operation inventory and radio eligibility in Protocol metadata,
or explicitly label the Link list as a projection with a test that every entry
resolves to a Protocol definition. The current radio decision uses UTF-8 JSON
and fragmentation [decision](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/docs/design-decisions/2026-09-02-meshtastic-radio-contract-is-generated-from-atlas-protocol.md#L3-L9). Treat that as experiment evidence, not proof of a final encoding.

## Concrete experiments and acceptance gates

These experiments are intentionally small and can falsify the proposal before
an implementation migration.

| Experiment | Measure | Pass condition | Decision it informs |
| --- | --- | --- | --- |
| Reduced JSON Schema slice | Generated Go and TypeScript lines, handwritten code, build time, validator agreement on 100 fixtures, and number of schema keywords needed | No custom generator feature is added for the five first-version message groups; both languages agree on all fixtures | Whether JSON Schema remains the immediate canonical source |
| TypeSpec slice | Same models emitted to JSON Schema and OpenAPI, generated API ergonomics, custom semantic code, and review diff size | It reduces authored and handwritten code without introducing a second semantic source | Whether TypeSpec earns a later authoring trial |
| Protobuf device slice | Wire bytes, fragmentation, encode/decode cost, generated API size, presence and unknown-field behavior, and fixture agreement | Payload reduction or device/toolchain benefit is material at real payload sizes and parity remains tractable | Whether binary transport is worth a distinct canonical source |
| Revision replacement | Cosmetic schema change, additive message field, and breaking field change across server and device handshake | Cosmetic change does not break a compatible runtime; major change is rejected clearly | Whether version and hash semantics are separated |
| Operation and Task corpus | Synchronous Operation, observation, duplicate Task offer, replayed completion, cancellation, and retry | Each case has one owner and deterministic idempotency behavior in Go, TypeScript, and Core | Whether the domain boundary survives package consolidation |
| Radio projection gate | Generate a selected operation list from Protocol metadata or a declared projection file | Every generated input and output reference resolves and no undeclared operation reaches the radio contract | Whether Link remains an adapter |

## Unknowns that block a final technology decision

* [Unknown] Maximum and typical device message sizes, fragmentation limits, and
  offline replay duration.
* [Unknown] Device implementation languages and whether generated Go or
  TypeScript is useful on the device, or whether another generated target is
  required.
* [Unknown] Whether device capabilities and command schemas must be discovered
  dynamically at runtime.
* [Unknown] Whether the first milestone needs arbitrary Objects, GeoJSON,
  change feeds, spatial operations, or only tasking and observations.
* [Unknown] Whether Plugin capabilities will be separate deployable processes
  or Core modules. This determines whether private Plugin manifest and exact
  revision machinery can be deleted.

[Accepted planning constraint] None of these unknowns justify preserving every
current Protocol definition. The successor can start with a small explicit
contract, break old clients, and add a measured capability only when a first
server and field-device workflow proves it necessary.
