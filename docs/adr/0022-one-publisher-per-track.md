---
status: accepted
---

# Give each Track one publisher for observed data

Each Track has one publisher responsible for its observed data. Different publishers describing the same subject create separate Tracks. Core does not automatically combine their observations or choose which publisher is correct.

Current rules: [Tracks](../topics/tracks-and-geofeatures.md#tracks).

## Decision

Entities records each Track's publisher and enforces that boundary on every path that can write its observed fields. Descriptive edits remain separate, and broad operational read access does not grant authorship. A Plugin may deliberately combine observations from several Tracks and publish a separate Track as its publisher.

Within one Dataset, the same authenticated publisher may continue its Tracks with fresh observations after Plugin uninstall and reinstall. A silent Track keeps its last-known data and exposes observation age, with no universal expiry; each Command that needs current observations defines its acceptable age. The publisher may correct current observations without making them fresh or rewriting recorded history. Publisher transfers are outside the initial scope.

Decision history:

- 28 September 2026: the user approved one publisher per Track in the first documentation grilling round.
- 28 September 2026: publisher continuity after reinstall was accepted in response to Q5, and retained observation age for silent Tracks in response to Q8.
- 28 September 2026: the user approved Command-specific Track freshness (Q12), corrections to current observations (Q13) and the exclusion of publisher transfers from the initial scope (Q14).

## Rationale and alternatives

- One publisher per Track keeps interpretation with the integration that understands the observations. The cost is potentially showing several Tracks for one real subject until an integration combines them.
- It is an ownership rule, not a new component extension system or a separate observation service.
- Retaining the publisher association lets Core distinguish continuity from another source taking over.
- Corrections permit recovery from a bad current value without rewriting the record of what was reported.

## Consequences

- Protocol must distinguish observed fields from operator-managed fields.
- Removing a Plugin does not itself delete its published Tracks under the [uninstall contract](0021-manage-plugin-operational-storage-through-reset.md#uninstall-and-reinstall).
- Exact thresholds and stale-data responses belong to each Protocol-defined Command, and the Asset applies them.
- Any future transfer workflow requires a successor decision rather than an exception to this ownership rule.
- Publisher identity encoding, authentication and binding, report ordering, timestamp fields and correction correlation remain contract work.
