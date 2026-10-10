# Coding standards

These standards govern code quality. The [system design](docs/architecture/system-design.md), [ADRs](docs/adr/) and [topic pages](docs/topics/README.md) govern behavior and ownership. Follow the [documentation guide](docs/agents/domain.md) when changing those decisions.

## Review and completion

- **Coverage.** Implementers and reviewers check every section of this file, including every recurring defect, against the affected behavior and its indirect effects outside the edited files.
- **Two axes.** Check conventions separately from the requested behavior. Check the behavior against its issue or specification and the applicable accepted documents; passing conventions does not prove that the right behavior was implemented.
- **Requirement mapping.** For substantial changes, record a compact mapping from requirements to implementation and validation, with reasons for material exclusions.
- **Findings.** Cite the convention or requirement, and the concrete consequence for behavior or maintenance cost. Distinguish defects from suggestions.
- **Validation and background work.** For validation changes, assess the reusable adapter alone and with its wrappers, agreement between validation and the consuming parser, and writes that may commit before response rejection. For background-work changes, identify the surviving cleanup owner when callers, workers or observers stop, including nested fixtures. A passing fixture proves only its exercised combinations. Use focused public-interface probes for relevant untested cases and report the combinations exercised under the [testing strategy](docs/testing-strategy.md#real-boundaries-and-independent-expectations).
- **Safety and progress.** Check them separately: prevent incorrect transitions, and examine how a legitimate workflow can finish when a participant never returns. Challenge a requirement that creates an avoidable dead end before adding coordination machinery; never resolve uncertainty by fabricating an outcome.
- **Mechanical rules.** Enforce them with the repository's required automated checks. As implementation introduces rules that tooling can reliably decide, add the corresponding required checks. Report missing or failing enforcement; manual review does not substitute for a required check.
- **Preserved checks.** Keep every guarantee that checks enforce. Never disable checks, suppress failures, exclude failing cases or weaken assertions or thresholds to make an implementation pass. Justify changed expectations against the governing specification or an authorized requirement change; replacement checks must preserve required coverage. Follow the [test evidence rules](docs/testing-strategy.md#continuous-integration-and-completion-evidence) for test changes.
- **Completion.** Implementation is complete only when every applicable required build, type, lint, formatting and other check has passed against the final diff (`python3 scripts/verify.py --bootstrap` runs the current required set) and the [testing strategy's completion criteria](docs/testing-strategy.md#continuous-integration-and-completion-evidence) are satisfied. Report commands, outcomes and missing evidence. Report work with failed, skipped or unavailable required checks as unverified, not complete. After further edits, rerun every check whose evidence those edits invalidate.
- **Pre-existing failures.** Support claims that a failure is pre-existing or unrelated with evidence, such as reproducing it on the unchanged base under equivalent conditions. If that evidence is unavailable, report the cause as unresolved. Explaining a failure does not turn a required failing check into a pass.
- **Maintenance.** Update a standard when an accepted change makes it obsolete. Cite paths and reference implementations here only after the corresponding code exists.

## Structure and interfaces

- Follow established patterns in the affected area that satisfy current requirements. Inspect an existing implementation before introducing another way to solve the same problem. Hold new code to these standards even where existing code violates them. Consolidate only when it is relevant to the requested change.
- Prefer deep modules that hide complex behavior behind small, explicit interfaces. Put coupled behavior and private data access behind those interfaces so callers do not reconstruct the rules or read the module's tables.
- Judge a boundary by the total knowledge and coordination it removes from callers and collaborators, not by making each implementation smaller. Keep a complete required workflow behind one owner; do not export transport, storage or reconciliation choices merely to simplify that owner's code. Internal decomposition also must earn its interfaces rather than hide a tightly coupled network behind a facade.
- Hide mechanisms, not consequential facts: readiness, stale or incomplete coverage, unknown outcomes and the difference between accepted intent and confirmed execution must remain understandable. Different internal paths alone do not justify separate public APIs. Removing a supported capability is a scope decision, not automatically a deeper-module design.
- Share utilities for concrete repeated needs. An interface, framework or dependency should remove demonstrated complexity or serve a required integration, rather than prepare for hypothetical variation.
- Keep transport adapters focused on translating requests and results. Domain decisions belong to their owning modules. Wire types can be used directly where their meaning fits; convert explicitly where internal meaning differs.
- Make collaborators, transaction ownership and background-work lifetime explicit. A caller should be able to tell who commits, cancels and stops work without following hidden global state.
- Explain a necessary cross-module change instead of hiding it in unrelated cleanup.

## Types and language conventions

- Required checks enforce formatting (gofmt, Prettier, Ruff) and the [TypeScript structural lint](Atlas%20SDK/README.md) (explicit `any`, type-error suppressions, nested assertions, cast-only functions). Run `python3 scripts/format.py` before committing; it applies Prettier and Ruff, and Go is formatted with `gofmt`.
- In handwritten TypeScript, use inferred types and concrete contracts. Negative type tests must fail when the intended type error disappears. Use `unknown` for untrusted values and validate them at the boundary.
- A type or non-null assertion requires an identified compiler or library limitation and evidence of the invariant that establishes the value's type. Keep it at the narrowest affected boundary and document that evidence; calling it necessary is insufficient. Assertions cannot replace runtime validation of untrusted values. Const assertions and `satisfies` remain available for preserving and checking inferred types.
- In Go, use typed inputs and results for known shapes. Return errors with useful operation context while preserving their cause. Handle errors explicitly, including failures in background work.
- Keep optional, absent and null values distinct wherever the contract distinguishes them.
- Name handwritten TypeScript identifiers and SDK-authored object members in camelCase, including acronyms written as in `maxJSONBytes`. Values that mirror Protocol, such as generated types, wire bodies and copied Protocol metadata, keep Protocol's snake_case names; each object's own members use one style.
- Use [domain vocabulary](GLOSSARY.md) in public interfaces, tests and messages. Comments explain intent, constraints or non-obvious behavior; update them with the code they describe.

## Protocol and generation

- Protocol owns shared external contract facts. Author them in Protocol and regenerate their representations. Never hand-edit or post-process generated files. Private storage schemas and queries own storage representation. Keep business implementations separate from generated interfaces and types.
- Use supported generator output with small configuration. Avoid endpoint-specific templates, duplicate wrapper APIs and patches that recreate the maintenance removed by generation.
- When a required case does not fit, simplify the contract's representation while preserving accepted behavior, reconsider the tool choice under the accepted stack decision, or keep that binding handwritten. Changes to accepted behavior or tooling follow [decision authority](docs/agents/domain.md#decision-authority). Explain the tradeoff before expanding generator machinery.
- Keep SDK conveniences separate from generated bindings. Helpers may compose supported operations for an actual consumer workflow; they must preserve the contract and Core's authority.
- Regeneration must be deterministic. Validate wire examples and public behavior independently of generated output; matching generated snapshots alone does not establish correctness. See [generation and testing](docs/architecture/system-design.md#generation-and-testing).

## State, errors and background work

- Keep related state transitions and their commit boundaries visible in the owning module. Handle partial failure and retries according to the accepted contract rather than inferring success from one intermediate step.
- Keep resource use bounded where work can accumulate: queues, retries, buffers and concurrent work. Make cancellation, shutdown and failure reporting part of the component's interface.
- Distinguish a rejected operation, an unknown outcome and a confirmed result. Preserve that distinction through errors and retries.
- Keep credentials and other secrets out of logs and test artifacts. Include enough nonsecret context to diagnose the failed operation.
- Follow [Dataset lifecycle](docs/topics/dataset-lifecycle.md) for retention and cleanup. Storage and recovery changes must preserve those guarantees.

## Tests

The [testing strategy](docs/testing-strategy.md) owns test selection, required scenarios, fault coverage and completion evidence; start from its [workflow-first policy](docs/testing-strategy.md#end-to-end-workflows-first). These rules add to it for every test:

- Test deep modules through their small public interfaces, exercising observable behavior rather than internal implementation details.
- Author expected outcomes independently of the implementation and generator.
- Execute behavior instead of reading source text to infer correctness.
- Preserve the real failure mode. A mock that removes the failure being tested cannot prove recovery.
- Preserve failing seeds or schedules when randomness is used.
- Add coverage for new promises and demonstrated defects.

## Recurring defects

These patterns were found and corrected in this codebase. Each instance looks locally reasonable, so check new and changed code for them explicitly.

- **Restated facts.** The same identifier, limit, timeout, edition set or mode list appears as literals in several places, or once as a type and again as a runtime list. Give each fact one named definition and derive the others from it: derive a union type from an `as const` array, interpolate a limit into the message that reports it, and call one predicate wherever a rule applies.
- **Copied scaffolding.** Setup is repeated across files with small variations, such as client construction, request deadlines, schema compilation, stub servers, storage encode/decode pairs or absence checks. Extract it by the third copy. Contract-test scaffolding lives in `tests/contract/support.ts` and S1 scaffolding in `tests/s1/support.ts`; expected outcomes stay literal in each test.
- **Duplicate defensive checks.** A handler re-implements a rule that an upstream boundary already enforces. The copy is unreachable, untested and drifts. Enforce each rule at one boundary; a second layer that genuinely needs the rule calls the same function.
- **Reimplemented primitives and impossible branches.** Code hand-builds identifiers, encoders or timer races that the standard library or an already-locked dependency provides, or handles errors the API documents as impossible. Use the existing facility and delete branches that cannot execute. A handwritten parser needs a stated tooling gap.
- **Hidden control flow.** A helper that throws is called as a statement in some places and returned in others. Have it return the error and `throw` at each call site, so readers and the compiler see every exit.
- **Mixed phases.** One long function both compiles configuration and handles each request, with inline anonymous types and per-request recomputation of fixed decisions. Separate one-time construction from per-call work, name the intermediate structure and precompute what does not vary.
- **Import-time work.** A library module compiles schemas, reads files or starts work when imported. Define values at import; build on first use.
- **Steering through global state.** A test mutates environment variables or other process-wide state so the code under test finds a different input. Pass the input as a parameter and read the environment only at the entry point.
- **Cleanup that replaces the failure.** A `finally` block or deferred close throws its own error and hides the original failure. Report both, using `errors.Join` or `AggregateError`.
- **Unbacked claims.** An evidence report lists checks from a hand-written list instead of recording what ran. Documentation cites local or temporary files a reader cannot retrieve. Prose promises a universal property, such as a deadline on every request, that some instances lack. Record evidence as each step passes, cite only committed files or CI artifacts, and route every instance of a promised property through the helper that provides it.
- **Inconsistent idioms.** The same check or construct has several spellings, such as three ways to assert that a process exited. Use one idiom, preferably the shortest standard form, through its shared helper. When one instance differs from its siblings, remove the difference or cite the requirement that causes it; do not invent a rationale for an accident.
