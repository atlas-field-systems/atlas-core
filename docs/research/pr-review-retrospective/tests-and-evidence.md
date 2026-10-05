# Tests and evidence

Proposal only. Priority: high. This makes the existing testing policy easier to assess during review.

## Evidence

| Finding | Consequence | Source |
| --- | --- | --- |
| A feed-only convergence check permitted reconnect HTTP recovery | Correct final values did not prove feed delivery | [Modernization #413](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/413#discussion_r3998375151), [instrumented regression response](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/413#discussion_r3998408419) |
| A required renderer assertion sat behind an unmet fixture guard | The test passed without running the promised assertion | [Ridgeline #31](https://github.com/the-Drunken-coder/Ridgeline/pull/31#discussion_r4127675574), [confirmed response](https://github.com/the-Drunken-coder/Ridgeline/pull/31#discussion_r4127706155) |
| A validator checked only discovered directories | A missing required registration passed | [DCS #1](https://github.com/the-Drunken-coder/DCS/pull/1#discussion_r3773375550), [negative-fixture response](https://github.com/the-Drunken-coder/DCS/pull/1#discussion_r3773396870) |
| Cleanup failure was induced with permissions that root bypasses | The supposed failure condition depended on runner privileges | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178226014) |
| A direct handler test exercised an unreachable router branch | Passing handler coverage did not establish public behavior | [Modernization #30](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/30#discussion_r3408549183), [removal response](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/30#discussion_r3408712751) |
| Configuration artifact hashes were declared without verification | Evidence could certify inputs different from those claimed | [cvbench-dataset #1](https://github.com/the-Drunken-coder/cvbench-dataset/pull/1#discussion_r3771192648), [confirmed response](https://github.com/the-Drunken-coder/cvbench-dataset/pull/1#discussion_r3771259156) |
| Imported output was not tied to its completed job digest | Published evidence could refer to different bytes | [cvbench-studio #1](https://github.com/the-Drunken-coder/cvbench-studio/pull/1#discussion_r3772031529), [verified-byte response](https://github.com/the-Drunken-coder/cvbench-studio/pull/1#discussion_r3772057493) |

## Existing coverage

The [testing strategy](../../testing-strategy.md) already requires complete workflows, independent expectations, real failure boundaries, deterministic coordination and recorded completion evidence. The conventions already reject source-text tests and unbacked claims. `scripts/verify.py` records check names after they succeed and removes the previous report before starting.

These incidents do not justify requiring a unit test for every function, mandatory mutation testing or a second acceptance suite.

## Proposed text

Add this paragraph to the testing strategy's real-boundary guidance:

> For a consequential test claim, identify the realistic broken behavior that must fail its assertion. Establish required fixture prerequisites explicitly; a missing prerequisite must fail the scenario rather than skip its assertion. When the promise concerns a particular path, observe that path as well as the final result, including alternate recovery paths that could satisfy the assertion. Use a focused negative probe when it materially strengthens the evidence.

Add this clarification to its completion-evidence guidance:

> Tie reported results to the revision, inputs, configuration and artifacts actually used by the producer. Preserve the distinction between executed passing checks, failed checks, deliberately recorded failing experiments and unrun coverage. Where an artifact contract declares a digest, verify it against the bytes consumed or published.

Keep one pointer from code conventions to these paragraphs.

## Review procedure

1. Map each changed promise to an observable outcome and the appropriate existing workflow.
2. Identify meaningful failure branches, fixture prerequisites and routes that could make the assertion pass accidentally.
3. Check that the relevant assertion executes. Inspect optional guards, empty iterations, discovery-based input lists and early successful returns.
4. Confirm that fault injection produces the intended failure in the supported environment. Preserve the real database, filesystem or transport integration implicated by it.
5. Check changed SDK/Protocol combinations through the real boundary. Record which routes, editions and conditions ran; a generic adapter passing one example does not qualify every declaration.
6. Compare the completion claim with produced evidence. Link to committed fixtures or retained CI artifacts that a reviewer can retrieve.

## Adoption criteria

Extend existing workflows for demonstrated defects; justify additional focused probes by the coverage they provide. Do not make every test demonstrate a synthetic mutation.

The evidence provenance examples concern systems with artifact identity contracts. They support verifying such contracts, not adding hashes to every Atlas test input.

The [Modernization benchmark finding](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/318#discussion_r3946627593) was [withdrawn](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/318#discussion_r3947490209) after its purpose as a recorded failing experiment was explained. A failing required acceptance check still leaves work unverified; an accurately labeled failed experiment can be useful research.
