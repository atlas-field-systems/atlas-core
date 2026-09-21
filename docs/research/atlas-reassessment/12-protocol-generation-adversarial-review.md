# Adversarial review of Protocol-driven generation

Current lifecycle contract: [ADR-0015](../../adr/0015-separate-start-stop-restart-and-reset.md) supersedes wipe-on-start. Start, Stop and Restart retain operational data and Atlas-managed diagnostic logs; Reset clears them while keeping setup and installed artifacts. Core stays running throughout field missions; Restart and Reset are primarily development actions outside missions. Mission execution continuity across Core restart is outside scope. Updates to a new Core release perform Reset; operational-data migrations are excluded. Backup and restore functionality is excluded. Source observations below describe the inspected historical implementation; successor recommendations remain provisional unless backed by an accepted decision.


Research date: 20 September 2026.
Status: concept review, with its bounded direction now accepted in [ADR-0011](../../adr/0011-generate-shared-contracts-with-minimal-customization.md). The user requires minimal customization, substantial independent testing and low maintenance complexity. No generator, schema language or broader generated implementation has been selected. No implementation experiment was run.

## Verdict

More generation is likely to reduce Atlas maintenance when it removes repeated declarations of the same public contract. It does not establish that fewer generated-versus-handwritten lines means less technical debt. The maintenance target is fewer independent authored decisions per ordinary change, including schema conventions, generator code, templates, configuration, adapters and tests.

Support the direction, then prove the extent. Generate shared types, structural validation, serialization and reference documentation. Evaluate generated SDK transport calls and Core API bindings against a thin handwritten alternative. Keep runtime storage, authorization enforcement, Task reconciliation, Plugin supervision and SDK synchronization behavior explicitly implemented. The current lifecycle requires retention across ordinary Stop/Start and Restart, with cleanup on Reset and updates to a new Core release. Backup/restore and operational-data migrations are excluded. These boundaries do not change the generator-maintenance tradeoff.

The user's aim is feasible: changing a public field or operation should usually require one contract edit plus actual behavior changes, while regenerated declarations follow automatically. A changed operational rule still legitimately changes the Core implementation and its independent behavior tests. Generation cannot remove that work merely by relocating it into a template or schema extension.

## Review method

Three independent agents inspected the existing source with separate read-only assignments:

| Reviewer | Assignment | Initial conclusion |
| --- | --- | --- |
| Terra, medium, maintenance adversary | Find why generation could increase solo-maintainer debt | Keep structural generation; require evidence before expanding endpoint generation |
| Luna, extra high, contract adversary | Challenge validation, serialization and compatibility assumptions | Approve mechanical contract generation and transport bindings only with independent behavior and compatibility checks |
| Terra, medium, case challenger | Establish the strongest case for generation and attempt to falsify it | Real declaration duplication can be removed; compare with a smaller generated layer and handwritten bindings |

The parent independently checked source evidence, measured maintenance surfaces and challenged the proposed comparison baseline. Agreement among agents is review evidence, not a measured productivity result.

The inspected source is the previously prepared Atlas Modernization snapshot at `8edee4e2743fbf0f85c16dfe638d9222141cf279`, located at `/private/tmp/atlas-core-reassessment-20260920`. The archive itself contains no Git metadata. Current successor requirements come from the [operating model](../../architecture/operating-model.md), not old source policy.

## Evidence for the benefit

The SDK admin client separately authors request/response types, runtime predicates, HTTP methods and paths. Core admin handlers declare corresponding request/response structs separately. Generating the shared declarations and standard request handling could remove actual independent upkeep. Credential validation, trusted-origin checks and session behavior would still have an implementation owner. See [SDK admin](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/admin.ts#L11) and [Core admin handler](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/services/core/internal/api/handlers/handler_admin_auth.go#L13).

Modernization already generates TypeScript types/predicates and Go validators, but manually authors the Go types and maintains a projection table to check them against the schema. Removing that second authored representation is a credible improvement if generated Go types remain usable without recreating equivalent adapter definitions. See [authored Go types](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/generated/go/atlasprotocol/types.go#L1) and [projection table](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/go_contracts.go#L18).

The current [artifact manifest](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/manifest.go#L70) emits eight artifacts, with no SDK method or Core endpoint-binding output. The proposed expansion addresses a real gap rather than renaming existing generation.

## Strongest objections

### The generator itself needs upkeep

Parent measurements counted physical lines, including comments and blank lines:

| Source area | Files | Lines |
| --- | ---: | ---: |
| Production Go under `packages/protocol/tools/internal/artifacts`, excluding `_test.go` | 17 | 3,596 |
| Tests in that directory | 3 | 1,384 |
| Authored Go contract `types.go` | 1 | 714 |
| Generated TypeScript files | 2 | 1,268 |

These counts locate maintenance surfaces. They do not compare equivalent implementations, measure change frequency or prove that the current generator costs more than it saves. They exclude other Protocol validation and tooling code, so they are not total subsystem counts.

A supported external generator may reduce the custom implementation burden, but version pinning, upgrades, configuration and any template overrides still count. Existing generator documentation explicitly supports custom templates and custom generators; those are code we would own, not free configuration. [OpenAPI Generator customization](https://openapi-generator.tech/docs/customization/)

### One file can still contain repeated facts

The existing TaskResource schema declares common fields such as `task_id` in seven object shapes across its outer declaration and status variants. The Go projection also contains explicit optional-value overrides and synthetic fields. A single schema file does not by itself ensure one authored definition of each fact. Reuse must preserve validation semantics rather than merely shorten the schema. [Task resource](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/schema/jsonschema/atlas.schema.json#L2663)

### Consistency can propagate a mistake

Generated Core and SDK declarations may agree with each other while sharing an incorrect rule. Missing versus null values, integer fidelity, enum evolution and serialization are concrete risks. Existing TypeScript validator generation rejects some unsupported keywords, which is useful, but also couples supported contract features to generator implementation. [Validator generation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/typescript_validators.go#L241)

Preserve independently authored expected outcomes and cross-language wire examples. A generated client succeeding against a generated server is useful integration evidence, but not enough to establish the intended contract. Modernization already has an independent request conformance corpus, including distinctions between structural and semantic validity; preserve that discipline. [Protocol validation workflow](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/README.md#L32)

### Generation does not make all endpoints uniform

The SDK client currently includes resource normalization, special headers, idempotency options, cache updates and synchronization behavior. Mechanical mappings such as an operation's method, path and declared headers can be generated; the behavior around them may still need handwritten code. Avoid producing a generated client plus an equally large duplicate wrapper API, or encoding each exceptional endpoint in the generator. [SDK client](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/sdk/src/client.ts#L120)

A real generator also illustrates the distinction: oapi-codegen describes separate request-validation middleware and application authentication callbacks. Generation is not proof that those behaviors are enforced. This is supporting evidence, not a tool selection. [Validation and security integration](https://github.com/oapi-codegen/oapi-codegen#implementing-security)

### Compatibility survives regeneration

Modernization hashes raw schema bytes for its revision. That token excludes generator/projection implementation changes, while harmless schema edits can change the hash. New and old clients still need compatibility checks independent of rebuilding everything together. [Revision calculation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/8edee4e2743fbf0f85c16dfe638d9222141cf279/packages/protocol/tools/internal/artifacts/revision.go#L12)

Generated source compatibility and wire compatibility are also different promises. Buf's documented compatibility categories make that distinction explicit; this principle applies without adopting Protobuf or Buf. [Compatibility categories](https://buf.build/docs/breaking/)

## Review claims corrected during synthesis

- The alternative of a shared Go/TypeScript operation catalog is not free. It needs generated artifacts or interpreters and adapters. Count that machinery, or compare against ordinary handwritten bindings using generated shared models.
- Editing a generator is not an automatic failure. A reusable change benefiting many ordinary operations can be economical. Endpoint-specific policy additions and manual patches to generated output are much stronger warning signs.
- One review inferred overly narrow conformance coverage from `lifecycle.json`. The parent found additional `outcomes.json`, `restart.json` and `scheduling.json` cases, including failures and rejected cancellation. No broad missing-test finding is accepted. Independent behavioral tests remain a design requirement.

## Small comparison that could prove or reject the approach

Use the same small Core/SDK slice and requirements for both alternatives:

- Baseline: shared generated models and structural validation, with thin handwritten Core and SDK bindings.
- Candidate: the same shared models plus generated standard Core bindings and typed SDK transport calls. Keep the same handwritten business behavior in both.

Apply a few realistic changes:

| Change | What it tests |
| --- | --- |
| Add an optional response field | Whether one contract edit replaces separate Go, TS, validator and docs edits |
| Add an operation with a path parameter, declared header and typed error | Whether API binding generation saves upkeep beyond plain CRUD |
| Introduce a nullable field or additional enum value | Whether omission, serialization and older-client behavior remain correct |
| Change the successful-scan completion rule | Whether genuine Core behavior changes remain explicit and independently tested |
| Upgrade the generator with an unchanged contract | Whether changes are explainable and compatible without output patching |

Record authored semantic touchpoints, including schema repetitions, templates, adapters, configuration and tests; debugging/review effort; generated diff readability; and compatibility results. Treat code and line counts as supporting context. Do not count a behavioral implementation change as a failure of generation.

Continue expansion when ordinary structural/API changes reduce independent edits without endpoint-specific generator work, output patches or duplicate wrapper definitions. Fall back to the smaller generated layer when total maintenance and diagnosis are as hard or harder. Pin tools, require deterministic regeneration, and validate protocol behavior against independently authored expectations.

## Recommendation to carry forward

Use Protocol as the authoritative external contract. Generate repeated representations of that contract wherever a small, understandable toolchain actually removes upkeep. Keep Core and SDK behavior in ordinary code, with a deliberate interface between generated and handwritten files. Optimize maintenance of changes, not the percentage of code generated.

No performance, productivity or generator-comparison experiment was run in this review. The evidence supports a bounded trial and clear adoption criteria, not a measured claim that all proposed generation will save work.
