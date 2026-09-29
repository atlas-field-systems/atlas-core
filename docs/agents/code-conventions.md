# Code conventions

Implementers and reviewers assess every section against the affected behavior, including indirect effects outside the edited files. Check conventions separately from the requested behavior. For substantial changes, record a compact mapping from requirements to implementation and validation, with reasons for material exclusions. Cite the convention and concrete consequence when reporting a violation; distinguish defects from suggestions.

These conventions govern code quality. The [system design](../architecture/system-design.md), [ADRs](../adr/) and accepted API and SDK plans govern behavior and ownership. Follow the [documentation guide](domain.md) when changing those decisions. This checkout is a design workspace; paths and reference implementations should be added only after the corresponding code exists.

## Structure and interfaces

- Follow established patterns in the affected area that satisfy current requirements. Inspect an existing implementation before introducing another way to solve the same problem. Existing violations do not justify new ones. Consolidate only when it is relevant to the requested change.
- Prefer deep modules that hide complex behavior behind small, explicit interfaces. Put coupled behavior and private data access behind those interfaces so callers do not reconstruct the rules or read the module's tables.
- Judge a boundary by the total knowledge and coordination it removes from callers and collaborators, not by making each implementation smaller. Keep a complete required workflow behind one owner; do not export transport, storage or reconciliation choices merely to simplify that owner's code. Internal decomposition also must earn its interfaces rather than hide a tightly coupled network behind a facade.
- Hide mechanisms, not consequential facts: readiness, stale or incomplete coverage, unknown outcomes and the difference between accepted intent and confirmed execution must remain understandable. Different internal paths alone do not justify separate public APIs. Removing a supported capability is a scope decision, not automatically a deeper-module design.
- Share utilities for concrete repeated needs. An interface, framework or dependency should remove demonstrated complexity or serve a required integration, rather than prepare for hypothetical variation.
- Keep transport adapters focused on translating requests and results. Domain decisions belong to their owning modules. Wire types can be used directly where their meaning fits; convert explicitly where internal meaning differs.
- Make collaborators, transaction ownership and background-work lifetime explicit. A caller should be able to tell who commits, cancels and stops work without following hidden global state.
- Keep changes within the requested scope. Explain a necessary cross-module change instead of hiding it in unrelated cleanup.

## Types and language conventions

- Use the language's normal idioms and the repository's configured tools. Let formatters and linters enforce mechanical style.
- In handwritten TypeScript, use inferred types and concrete contracts. Do not introduce `any`, double assertions or functions whose only purpose is a cast. Do not suppress type errors in implementation code. Negative type tests must fail when the intended type error disappears. Use `unknown` for untrusted values and validate them at the boundary.
- A type or non-null assertion requires an identified compiler or library limitation and evidence of the invariant that establishes the value's type. Keep it at the narrowest affected boundary and document that evidence; calling it necessary is insufficient. Assertions cannot replace runtime validation of untrusted values. Const assertions and `satisfies` remain available for preserving and checking inferred types.
- In Go, use typed inputs and results for known shapes. Return errors with useful operation context while preserving their cause. Handle errors explicitly, including failures in background work.
- Keep optional, absent and null values distinct wherever the contract distinguishes them. Do not erase those differences for implementation convenience.
- Use [domain vocabulary](../../CONTEXT.md) in public interfaces, tests and messages. Comments explain intent, constraints or non-obvious behavior; update them with the code they describe.

## Protocol and generation

- Protocol owns shared external contract facts. Private storage schemas and queries own storage representation. Keep business implementations separate from generated interfaces and types.
- Use supported generator output with small configuration. Avoid endpoint-specific templates, duplicate wrapper APIs and patches that recreate the maintenance removed by generation.
- When a required case does not fit, simplify the contract's representation while preserving accepted behavior, reconsider the tool choice under the accepted stack decision, or keep that binding handwritten. Changes to accepted behavior or tooling follow [decision authority](domain.md#decision-authority). Explain the tradeoff before expanding generator machinery.
- Keep SDK conveniences separate from generated bindings. Helpers may compose supported operations for an actual consumer workflow; they must preserve the contract and Core's authority.
- Regeneration must be deterministic. Validate wire examples and public behavior independently of generated output; matching generated snapshots alone does not establish correctness. See [generation and testing](../architecture/system-design.md#generation-and-testing).

## State, errors and background work

- Keep related state transitions and their commit boundaries visible in the owning module. Handle partial failure and retries according to the accepted contract rather than inferring success from one intermediate step.
- Keep resource use bounded where work can accumulate: queues, retries, buffers and concurrent work. Make cancellation, shutdown and failure reporting part of the component's interface.
- Distinguish a rejected operation, an unknown outcome and a confirmed result. Preserve that distinction through errors and retries.
- Keep credentials and other secrets out of logs and test artifacts. Include enough nonsecret context to diagnose the failed operation.
- Follow [Dataset lifecycle](../topics/dataset-lifecycle.md) for retention and cleanup. Storage and recovery changes must preserve those guarantees.

## Tests

- Default to end-to-end workflows under the [testing strategy's workflow-first policy](../testing-strategy.md#end-to-end-workflows-first). It owns test selection, required scenarios, fault coverage and completion evidence.
- Test deep modules through their small public interfaces, exercising observable behavior rather than internal implementation details. Justify focused integration or unit tests using that policy.
- Author expected outcomes independently of the implementation and generator. Tests that merely repeat implementation logic provide little evidence.
- Execute behavior instead of reading source text to infer correctness. Structural rules that tooling can enforce belong in lint or build checks.
- Preserve the real failure mode. Use controlled fault injection where needed, while keeping the relevant database, filesystem or transport integration real. A mock that removes the failure being tested cannot prove recovery.
- Coordinate asynchronous scenarios with observable readiness and deterministic barriers. Preserve failing seeds or schedules when randomness is used.
- Add coverage for new promises and demonstrated defects. Avoid duplicate smoke tests and tests that break on harmless internal refactors.

## Review and maintenance

- Check the requested behavior against its issue or specification and the applicable accepted documents. Passing conventions does not prove that the right behavior was implemented.
- Check interface ownership, unnecessary complexity, type safety, failure handling and the quality of test evidence. Explain findings using the affected behavior or maintenance cost, rather than personal style preference.
- Check safety and progress separately: prevent incorrect transitions, but also examine how a legitimate workflow can finish when a participant never returns. Challenge a requirement that creates an avoidable dead end before adding coordination machinery; never resolve uncertainty by fabricating an outcome.
- Enforce mechanical rules with the repository's automated checks. As implementation introduces rules that tooling can reliably decide, add the corresponding required checks. Report missing or failing enforcement; manual review does not substitute for a required check.
- Preserve the guarantees enforced by checks. Do not disable checks, suppress failures, exclude failing cases or weaken assertions or thresholds to make an implementation pass. Justify changed expectations against the governing specification or an authorized requirement change; replacement checks must preserve required coverage. Follow the [test evidence rules](../testing-strategy.md#continuous-integration-and-completion-evidence) for test changes.
- Before declaring implementation complete, run the applicable required build, type, lint, formatting and other checks against the final changes, and satisfy the [testing strategy's completion criteria](../testing-strategy.md#continuous-integration-and-completion-evidence). Report commands, outcomes and missing evidence. Failed, skipped or unavailable required checks leave the work unverified and must not be reported as complete. After further edits, rerun checks whose evidence those edits invalidate.
- Support claims that a failure is pre-existing or unrelated with evidence, such as reproducing it on the unchanged base under equivalent conditions. If that evidence is unavailable, report the cause as unresolved. Explaining a failure does not turn a required failing check into a pass.
- Update a convention when an accepted change makes it obsolete. Keep each rule in one authoritative home and link to detailed policy rather than repeating it in `AGENTS.md`.
