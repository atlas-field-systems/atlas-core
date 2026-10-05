# Coding conventions retrospective

Proposal only. These files suggest changes for the user's review. They do not establish requirements, change accepted Atlas behavior or replace the active [code conventions](../../agents/code-conventions.md).

Collected on 5 October 2026 against checkout `e642fe43b98f96f8cabffa870e54eefe359d785c`. The corpus contains 23,034 records from 1,879 PRs across 68 repositories: 10,364 inline comments, 7,061 conversation comments and 5,609 formal reviews. Some review bodies are empty. The [query manifest](evidence/collection-manifest.json) and [frozen result summary](evidence/result-summary.json) retain collection inputs and recomputed counts. [Coverage and method](coverage.md) distinguishes collection, screening and close reading.

The strongest finding is that Atlas already states most of the right principles. The recurring failures concern how agents apply those principles across middleware, asynchronous work, resource expansion and test evidence. Adding another general instruction would offer little benefit.

## Proposals in consequence order

| Priority | Proposal | Recommended change |
| --- | --- | --- |
| High | [Resource limits](resource-limits.md) | Clarify that limits apply before proportional allocation and across aggregate and expanded representations |
| High | [Validation boundaries](boundary-validation.md) | Give reviewers a concrete procedure for validators, consuming transports and middleware composition |
| High | [State and lifetimes](state-and-lifetimes.md) | Review irreversible effects, invalidated preconditions and surviving cleanup ownership explicitly |
| High | [Tests and evidence](tests-and-evidence.md) | Check that a required assertion runs and fails for the realistic defect, including unintended fallback paths |
| Medium, with a high consequence transport case | [Automated checks](automated-checks.md) | Extend existing enforcement for unsafe finalizers, executable Python assertions and unsupported contract declarations |
| Medium | [Review and navigation](review-and-navigation.md) | Separate standards from specification review, calibrate bot findings and make conditional references easier to reach |

Each file separates the historical evidence, existing coverage, proposed text and adoption criteria. Priorities describe the consequences of the failure class, not a claim that every cited defect remains in this checkout.

## Adoption

Start with the resource-limit clarification and the two inexpensive syntax checks. Then move the dense validation/lifetime review paragraph into conditional references and adopt the test-evidence procedure. The transport-profile check needs a supported-profile decision and executable evidence before changing its claimed range.

Keep `docs/agents/code-conventions.md` as the entry point. The proposed conditional references are `docs/agents/boundary-validation.md` and `docs/agents/background-work.md`. They would receive the corresponding current guidance and the proposed procedures. The [testing strategy](../../testing-strategy.md) continues to own scenario selection and completion evidence; the [domain guide](../../agents/domain.md) continues to own authority and documentation consistency.

Move rules when splitting files. Keep one authoritative copy and update incoming links. The evidence and rationale remain in this retrospective. The exact wording in each proposal is suitable for that future edit, but remains unaccepted here.

The retrospective leaves active instructions, conventions, implementation and checks unchanged.
