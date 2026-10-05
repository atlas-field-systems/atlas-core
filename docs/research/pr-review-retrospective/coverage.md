# Coverage and method

This is a dated evidence record for the [proposal bundle](README.md). It establishes the scope and limits of the retrospective, not new coding requirements.

## Collection

GitHub was accessed read-only through the authenticated `gh` account `the-Drunken-coder`. Collection completed on 5 October 2026. Repository conventions were compared against checkout `e642fe43b98f96f8cabffa870e54eefe359d785c`.

The [query manifest](evidence/collection-manifest.json) preserves the recovered endpoint templates, search partitions, pagination and deduplication rules. The [frozen result summary](evidence/result-summary.json) was recomputed from the original saved collection. It includes per-repository counts, source snapshot hashes, search completeness and the cited record identities and body hashes. These files preserve this collection's results; a new query can return different results as repositories and comments change.

| Measure | Result |
| --- | ---: |
| Repositories returned by the owner/collaborator/organization-member inventory | 108 |
| Additional repositories discovered by account-involvement search | 3 |
| PRs fetched | 1,879 |
| Repositories represented by those PRs | 68 |
| Repositories with comment or review records | 62 |
| Inline comments | 10,364 |
| Root inline comments, excluding replies linked by GitHub | 7,627 |
| PR conversation comments | 7,061 |
| Formal review records | 5,609 |
| Formal reviews with nonempty bodies | 2,377 |
| Total comment and review records | 23,034 |
| Account-involvement search results retrieved | 1,792 |
| Reviewed-by-account search results retrieved | 221 |
| Unresolved collection errors | 0 |

The records span 18 September 2025 through 5 October 2026. Empty approvals, review commands, bot summaries and deployment notices contribute to collection counts, but are not separate engineering findings.

| Repository group | PRs | Inline | Conversation | Reviews | Total records |
| --- | ---: | ---: | ---: | ---: | ---: |
| atlas-field-systems/atlas-core | 37 | 407 | 177 | 222 | 806 |
| the-Drunken-coder/Atlas-Modernization | 423 | 3,637 | 3,266 | 2,431 | 9,334 |
| the-Drunken-coder/ATLAS-retired | 820 | 1,887 | 1,408 | 706 | 4,001 |
| Other repositories, 65 with PRs | 599 | 4,433 | 2,210 | 2,250 | 8,893 |
| Total | 1,879 | 10,364 | 7,061 | 5,609 | 23,034 |

All PR states were included. Full PR/comment histories were paginated for the inventory repositories and two additional repositories found in the initial involvement search. A complete partitioned search found five more involved PRs in `gnarzilla/deadmesh`; their metadata, inline comments, conversation comments and reviews were fetched individually. Those five had no comment/review records.

GitHub's 1,000-result search limit was handled by splitting the involvement query into nonoverlapping creation periods: before 2026, January through June 2026, July, August, September and October onward. Each partition's fetched count matched its reported total, with no incomplete-result flag. All 221 reviewed-by results were also fetched, and every resulting PR was already in the corpus.

Formal reviews were fetched by PR node with cursor pagination. Five initial batches encountered PRs with more than 100 reviews; those batches were retried with full pagination and deduplicated by review ID. Repository REST collections were fully paginated.

This covers the authenticated repository inventory and the two account searches. It is not a claim to cover every public GitHub PR, inaccessible private repositories, deleted comments, local coding sessions or reviews that were never posted.

## Attribution

The corpus includes 7,117 records under `the-Drunken-coder`, alongside Codex, CodeRabbit, Copilot, Greptile, Macroscope and other bots. REST and GraphQL sometimes use different login forms for the same app; those forms were not counted as independent reviewers.

GitHub account identity does not distinguish the user from an agent using their credentials. Explicit model tags and signatures were used where available. For example, the [earliest Atlas review summary](https://github.com/atlas-field-systems/atlas-core/pull/1#pullrequestreview-5270808121) identifies Claude Code, and [a later response](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178564165) identifies gpt-6.1-sol. Other account-authored remarks remain unattributed.

## Analysis

All 7,627 root inline comments were screened through headings and keyword families, divided between current Atlas, the two main historical Atlas repositories and the remaining repositories. Representative full findings and replies were then read for each proposed theme. Conversation and formal-review records were filtered for substantive summaries, fix confirmations and rebuttals. Three read-only agent investigations checked existing enforcement, historical Atlas patterns and cross-repository patterns.

This is broad screening followed by close reading of selected evidence. It is not a claim that a human-style reading of every body or every PR diff occurred.

The result summary records which primary sources each proposal cites, including the linked rebuttals and withdrawals. The original keyword lists and every individual screening decision were not retained. The surviving evidence therefore supports the cited incidents and collection counts, without establishing an independently replayable exhaustive screening process.

For each candidate:

1. Identify the concrete failure and its observable consequence.
2. Read available replies for acceptance, correction, withdrawal or an authorized scope change.
3. Compare the failure with current conventions, the testing strategy and relevant accepted Atlas architecture/topics/ADRs.
4. Classify it as a new clarification, an existing rule needing a review procedure, a mechanical enforcement gap or unsuitable historical guidance.
5. Cite representative primary comments directly in the corresponding proposal.

Recurring themes are supported by distinct incidents, often across repositories. No exact defect-frequency ranking is claimed. Duplicate bot summaries, copied prompts, repeated reviews of the same change and replies confirming one fix are not independent incidents. The two optimized-Python reviews in Atlas #93 are one example of this deduplication.

Fix-confirmation replies establish what participants reported. They do not establish an independent reproduction in this retrospective. Most historical defects were already fixed; current unresolved concerns are explicitly marked.

## Calibration and exclusions

| Candidate | Treatment | Evidence |
| --- | --- | --- |
| Claimed missed socket-close event in the pinned Node test | Excluded as a withdrawn false positive | [Evidence response](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178564165), [withdrawal](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178565383) |
| Rejecting intentionally recorded failing benchmark measurements | Excluded as an acceptance-policy inference contradicted by research purpose | [Finding](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/318#discussion_r3946627593), [withdrawal](https://github.com/the-Drunken-coder/Atlas-Modernization/pull/318#discussion_r3947490209) |
| Additional URI validation beyond the governing contract | Excluded as unsupported stricter behavior | [Finding](https://github.com/the-Drunken-coder/DCS/pull/3#discussion_r3777478955), [rebuttal](https://github.com/the-Drunken-coder/DCS/pull/3#discussion_r3777484727) |
| Universal compatibility inferred from one historical root export | Excluded because the repository intentionally changed that boundary | [Finding](https://github.com/the-Drunken-coder/Atlas-Mesh/pull/2#discussion_r3756840414), [rebuttal](https://github.com/the-Drunken-coder/Atlas-Mesh/pull/2#discussion_r3756870439) |
| Restoring old scan-result completion gates or enforcing a bot's docstring percentage | Excluded as superseded or unowned requirements | [Atlas #93 response](https://github.com/atlas-field-systems/atlas-core/pull/93#issuecomment-5966850834) |
| Historical write-response updates to synchronized pictures | Excluded as successor guidance | [Current ADR-0018](../../adr/0018-confirm-writes-when-core-commits.md) |
| Missing CI or a required tracked-output generation diff | Excluded after inspecting the existing workflow and verifier | [Workflow](../../../.github/workflows/contract-foundation.yml), [verifier](../../../scripts/verify.py), [generation](../../../scripts/generate.py) |

Historical client-disconnect cancellation, hybrid synchronization, old storage architectures and reused Entity-ID recipes were not imported into current Atlas requirements.

The primary evidence did not establish a standing tool-economy or information-access deficiency. Large review comments contain generated scripts and copied instructions, but that alone does not demonstrate expensive tool use in the implementation sessions.

## Verification scope

The active conventions, domain authority guide, glossary, testing strategy, applicable architecture/topics/ADRs, CI workflow, verifier, structural lint/probes, Ruff configuration and representative current adapters/fixture cleanup were inspected.

Initial verification covered the eight proposal documents. Local links/anchors, GitHub evidence URLs against the fetched corpus, aggregate counts, proposal status and whitespace passed, including 42 local references and 77 GitHub evidence references. The review follow-up also added repository navigation and the committed evidence files, and recomputed collection counts and cited-record hashes from the saved inputs.

The existing manual command `python3 -O scripts/verify.py --toolchain-self-test` passed, demonstrating checksum refusal before extraction and wrong-version refusal under optimization. Application tests and the full foundation verifier were not rerun for documentation-only suggestions. A read-only TypeScript lint probe was unavailable because installed SDK dependencies were absent.

Raw fetched records remain outside the repository because the corpus includes private repositories and comment bodies. The result summary replaces private repository identities with anonymous keys and omits raw bodies. Its counts and hashes do not grant access to those sources or reproduce their omitted contents. GitHub links retain the selected primary evidence; the committed manifest and summary retain collection provenance without depending on temporary paths.
