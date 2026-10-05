# Review and navigation

Proposal only. Priority: medium. The purpose is to make existing rules easier to apply and prevent review feedback from inventing requirements.

## Evidence

The earliest Atlas review under the user's account identified [stale retention wording](https://github.com/atlas-field-systems/atlas-core/pull/1#discussion_r4065552804), [Task results confused with activity history](https://github.com/atlas-field-systems/atlas-core/pull/1#discussion_r4065552840) and [undefined lifecycle terms](https://github.com/atlas-field-systems/atlas-core/pull/1#discussion_r4065552861). The associated [review summary](https://github.com/atlas-field-systems/atlas-core/pull/1#pullrequestreview-5270808121) identifies itself as generated with Claude Code. Account attribution alone therefore cannot distinguish the user from their agents.

Later reviews found the same form of cross-document omission: retirement was absent from the [central testing plan](https://github.com/atlas-field-systems/atlas-core/pull/56#discussion_r4117172097), and selected management coordination still appeared open in the [comparison register](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172153097).

Review suggestions also sometimes overshot the actual contract:

- A claimed socket-close race was [rebutted with pinned-runtime evidence](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178564165) and [withdrawn by the reviewer](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178565383).
- The [PR #93 response](https://github.com/atlas-field-systems/atlas-core/pull/93#issuecomment-5966850834) distinguished superseded completion gates and a bot's docstring metric from current requirements.
- DCS's extra URI validation was [challenged](https://github.com/the-Drunken-coder/DCS/pull/3#discussion_r3777478955) and [rebutted against the normative contract](https://github.com/the-Drunken-coder/DCS/pull/3#discussion_r3777484727).

## Existing coverage

[AGENTS.md](../../../AGENTS.md) is already mostly conditional navigation and hard guardrails. The conventions already require separate standards/specification checks and distinguish defects from suggestions. The [domain guide](../../agents/domain.md#documentation-completion) already requires reconciling all affected authoritative documents.

Do not add a second `CODING_STANDARDS.md`, repeat authority rules in AGENTS.md, or remove existing authority boundaries in the name of shortening context.

## Proposed organization

| Home | Responsibility | Trigger |
| --- | --- | --- |
| Existing code-conventions entry point | Common quality rules and reading pointers | Every implementation and review |
| Proposed boundary-validation reference | Contract, parser, transport and wrapper review procedure | Validation, generated bindings, serialization or API/SDK boundary changes |
| Proposed background-work reference | Resource expansion, commit/cancellation, lifetime and cleanup review procedures | Accumulating work, stateful writes, asynchronous operations, storage cleanup or process supervision |
| Existing testing strategy | Scenario selection, meaningful failure coverage and completion evidence | Test planning, implementation and review |
| Existing domain guide | Decision authority and current-document reconciliation | Behavior/design decisions and their documentation |
| This retrospective | Dated findings, sources and adoption rationale | Evaluating these proposals |

Move the dense boundary/lifetime review guidance into those two references if the user adopts the split. The rest of the conventions need no wholesale reorganization.

Suggested pointer wording in the conventions:

> For validation, serialization, generated bindings or API/SDK boundaries, apply the boundary-validation review procedure. For accumulating work, stateful writes, asynchronous operations, storage cleanup or process supervision, apply the background-work review procedures.

These are proposed destinations, not links to files that exist today. Implementers consult the references for affected work; reviewers enforce every applicable rule separately from the specification.

## Proposed review procedure

1. Establish the current specification and accepted decisions, including changes that supersede the originating issue. Inspect the relevant implementation and affected collaborators outside the diff.
2. Assess every applicable convention. For each finding, cite the rule, a concrete triggering case and its consequence.
3. Assess the requested behavior separately. Passing conventions or CI does not prove the intended workflow was delivered.
4. Verify bot suggestions against current code, pinned dependencies and the governing specification. Distinguish a reproduced defect, a supported but unexercised concern and a design suggestion.
5. For a documentation change, record a compact impact list covering affected vocabulary, topics, routes/SDK operations, architecture, test requirements and comparison entries. Mark unaffected areas with a brief reason where that avoids ambiguity.
6. Report missing evidence explicitly. A withdrawal or reply claiming a fix is historical evidence, not an independent reproduction.

Completion means every relevant branch has been assessed, required checks have evidence, and affected documents agree with current authority. A reviewer cannot accept a changed requirement on the user's behalf.

## Adoption criteria

The impact list operationalizes the existing completion rule; it must not become a second copy of the behavior contract. Keep the current instruction to inspect existing implementations. Preserve access to safety and ownership rules for implementers rather than hiding them exclusively in review instructions.

The fetched history does not establish a persistent expensive-tool or missing-information problem. Corpus collectors were bounded and paginated for this retrospective, but that alone does not justify adding a custom agent tool, standing integration or global instruction.
