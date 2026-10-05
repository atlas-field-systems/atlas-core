# Automated checks

Proposal only. Mechanical patterns should get executable enforcement. This task creates suggestions; it does not install the checks.

## Existing enforcement

The [PR/push workflow](../../../.github/workflows/contract-foundation.yml) runs [scripts/verify.py](../../../scripts/verify.py). That entry point already runs:

- Tool checksum/version refusal checks, dependency verification and two clean generations.
- Go formatting, build, fresh tests and vet.
- TypeScript structural lint and independent lint-rule probes.
- Prettier and Ruff formatting, plus Ruff lint.
- Strict TypeScript, SDK build and ordinary package-consumer checks.
- Package artifact isolation and generated-transport/direct-Protocol workflows using real storage.

The custom [TypeScript lint](../../../scripts/lint-typescript.mjs) rejects explicit `any`, adjacent double assertions, simple cast-only functions and prohibited type-error suppression. [Independent probes](../../../scripts/lint-typescript-checks.mjs) verify rejected and allowed examples.

There is no absent-CI finding here. The explicit Bash shell provides pipeline failure propagation through `tee`. Generated outputs are intentionally ignored, rebuilt from clean directories and compared twice; requiring a tracked generated-file diff would misread the setup. Branch-protection requirements were not inspected.

## Unsafe finalizers

Priority: medium; strong recurrence across repositories.

[Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175233368), [easymanet #58](https://github.com/the-Drunken-coder/easymanet/pull/58#discussion_r3785947416) and [Ridgeline #102](https://github.com/the-Drunken-coder/Ridgeline/pull/102#discussion_r4187454710) identified cleanup throws hiding the primary failure. A separate [easymanet finding](https://github.com/the-Drunken-coder/easymanet/pull/58#discussion_r3778441141) identified a return from `finally`.

The active conventions already specify preserving both failures. The custom lint has no corresponding rule.

Suggested implementation:

1. Extend the existing compiler-AST checker to reject abrupt control flow escaping a finalizer. Cover returns, throws and break/continue exits, accounting for nested functions, loops and caught exceptions.
2. Include maintained JavaScript scripts in the appropriate structural-rule scope. Current discovery covers TypeScript under SDK source/checks and contract tests, not `scripts/*.mjs`.
3. Add independent prohibited and permitted programs to the existing lint probes. Include nested function returns, local loop exits, internally caught errors and an error aggregated after cleanup.
4. Retain behavioral coverage for cleanup calls that reject. Syntax cannot establish that every awaited cleanup preserves the primary error or attempts the other cleanups.

The normal fixture runner now aggregates failures. However, [the timeout supervisor test](../../../tests/contract/lifetime-timeout.supervisor-test.ts) still throws from its finalizer and awaits removal there. Review that path during rollout. Do not introduce a blanket test exemption or claim the current tree already satisfies the proposed rule.

## Executable Python assertions

Priority: medium; inexpensive regression prevention.

Two comments in PR #93 describe one incident: [CodeRabbit](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172124880) and [Codex](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172153081) found checksums/version checks removed by optimized Python.

Current [toolchain checks](../../../scripts/toolchain.py) and [refusal probes](../../../scripts/toolchain_checks.py) use explicit exceptions that remain active under optimized Python. The defect is fixed. The verifier and CI currently invoke the probes through ordinary Python; the optimized self-test is available as a manual command. [Ruff configuration](../../../ruff.toml) enables its default rules, without assertion prohibition.

Suggested implementation:

1. Enable Ruff's S101 assertion rule for executable verification/bootstrap scripts through its supported configuration or an explicit scoped invocation in the verifier.
2. Preserve intentional test-assertion scopes and the existing exclusion of historical research source. Keep executable refusal checks explicit.
3. Prove that an assertion added to a maintained verification script is rejected, while intended test assertions remain usable.
4. Add `python3 -O scripts/verify.py --toolchain-self-test` to required execution, alongside the ordinary verifier, to exercise checksum/version refusal under optimization. Keep the existing refusal probes; lint is supplemental evidence.

No new lint dependency is needed.

## Supported contract profile

Priority: high consequence, with unresolved qualification.

The current [response adapter](../../../Atlas%20SDK/src/response.ts) admits explicit statuses from 100 through 599. [PR #108](https://github.com/atlas-field-systems/atlas-core/pull/108#discussion_r4186881946) challenges 1xx support through its Fetch transport. No resolution was present in the collected history. This does not establish an operational route returning an invalid response.

Suggested implementation:

1. Qualify the supported declaration range through the actual pinned transport. Distinguish informational responses from final responses.
2. Reject declarations that the selected transport cannot expose at adapter construction, unless a separately tested transport supports them.
3. Add independent construction refusals and real HTTP probes to the existing response-declaration scenarios.
4. Derive the accepted profile from one definition and update its documentation. Preserve Protocol's authority and generation policy.

Reuse the current adapter's declaration checks for normalized collisions and unsupported constructs. Avoid a second checker that independently restates its profile.

## Completion

For any adopted guardrail, demonstrate an invalid input producing nonzero status and an allowed input passing, then run the existing required verifier. Fix existing violations deliberately before enabling enforcement. Do not waive the rule to pass CI.

The manual optimized-Python checksum/version self-test passed during this retrospective. No proposed check was implemented, and the full foundation verifier was not run. A read-only TypeScript lint probe could not execute because this checkout lacks installed SDK dependencies; its enforcement gaps come from inspection of the checker and configuration.
