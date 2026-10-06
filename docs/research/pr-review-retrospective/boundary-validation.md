# Validation boundaries

Proposal only. Priority: high. Existing rules need a concrete review procedure.

## Evidence

| Finding | Consequence | Source |
| --- | --- | --- |
| An outer body-limit wrapper replaced the no-body sentinel | Required binary-body validation accepted a request it should reject | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175233357) |
| Path Item metadata was treated as an HTTP operation | A valid contract with shared parameters failed during adapter construction | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175233366) |
| Validation decoded invalid UTF-8 through a replacement decoder | Corrupted response data could become a schema-valid success | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175563459) |
| Media declarations collided after normalization | One validator silently replaced another | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4178218763) |
| A report handler returned the current edition after selecting an older supported edition | The write committed, but SDK response validation rejected its context | [Atlas Core #101](https://github.com/atlas-field-systems/atlas-core/pull/101#discussion_r4175563460) |
| Success schemas omitted required mutation cursors and errors omitted shared headers | Handwritten behavior exceeded the authored shared contract | [Atlas Core #93 cursors](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172153083), [headers](https://github.com/atlas-field-systems/atlas-core/pull/93#discussion_r4172153086) |
| A homegrown frontmatter validator repeatedly missed invalid YAML | Patching the checker prolonged disagreement with the consuming parser | [DCS #1](https://github.com/the-Drunken-coder/DCS/pull/1#discussion_r3772911288), [parser replacement](https://github.com/the-Drunken-coder/DCS/pull/1#discussion_r3773212243) |

## Existing coverage

[Protocol and generation](../../../CODING_STANDARDS.md#protocol-and-generation) already gives Protocol ownership of shared facts. The [review paragraph](../../../CODING_STANDARDS.md#review-and-maintenance) explicitly calls for adapter/wrapper checks, parser agreement and writes that commit before response rejection. [Public wire conventions](../../architecture/system-design.md#public-wire-conventions) owns Atlas representations and typed errors.

The proposed change makes that paragraph executable as a review procedure. It adds no blanket requirement for stricter input acceptance.

## Proposed text

Move the validation portion of the current review paragraph into the proposed `docs/agents/boundary-validation.md`, with this procedure:

1. Trace the affected input or response from the authored contract through admission, structural validation, the consuming parser and the public adapter. Identify transformations before validation.
2. Exercise the reusable adapter by itself and with the production wrappers that can change what it sees. Include relevant body limits, authentication/error mapping and streaming behavior.
3. Cover valid contract variations as well as malformed values. Select relevant absent/null, metadata, normalization, media, status and version cases from the supported profile.
4. Check that normalized declaration keys remain unique and that unsupported declarations fail at construction with a useful error.
5. For mutation responses, verify the selected context, required headers and committed-result fields. Distinguish rejection before mutation from a committed mutation whose response cannot be interpreted.
6. Report the combinations exercised and any unsupported or unverified combinations. A passing representative fixture establishes only its tested profile.

Keep Protocol facts authored in Protocol and regenerate their representations. Preserve the existing preference for supported parsers and generators; a tooling gap must justify handwritten machinery.

## Adoption criteria

Retain a short conditional pointer in code conventions. Keep wire behavior in Protocol and the existing topic pages, rather than copying it into the new review reference.

The current adapter still accepts explicit 1xx response declarations while using Fetch. [PR #108's unresolved finding](https://github.com/atlas-field-systems/atlas-core/pull/108#discussion_r4186881946) challenges whether that transport can expose those responses. This is a capability-profile question, not evidence that operational Atlas routes currently return 1xx. The [automated-check proposal](automated-checks.md#supported-contract-profile) describes the required qualification.

Use independently authored valid and invalid fixtures through the actual consuming transport. Generated snapshots alone cannot prove the boundary.
