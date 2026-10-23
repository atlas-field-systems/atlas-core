# Evidence admission and current sections

Accepting evidence does not always replace a current section. The [report format](report-format.md)
owns exact source, section-result, constituent, and correction fields. These rules
apply to Asset and Observation reports and default Track effects.

## Identity and ordering

After current authority, Dataset, and [lifecycle](identity.md) checks, resolve accepted
exact replays before new admission. Replay recovers the retained result as duplicate evidence,
without effects or fresh contact.
Changed facts for a scoped `report_id` are `report_identity_conflict`. Member order and
JSON whitespace are immaterial. Omission, null, array order, and accepted string spellings are facts.

For an ordinary report, reserve each `(Dataset, Entity, origin, section, sequence)`
for its report identity. Another report using an occupied sequence is
`section_sequence_conflict`, even with identical values or a lower-than-current
sequence. Disjoint sections can share a sequence. Higher sequences replace current
results only in `current` mode. Unseen older sequences enter history only.

The first current result from an accepted replacement Asset process supersedes the
prior-process result at any positive sequence, even 1 after 100. Omitted sections retain
their result and scope. Later comparisons use the current process's section sequence.
Unseen obsolete-process reports are refused, including historical reports. Replay has no effect.
[Publisher continuity](observations.md#reports-and-movement) never resets Observation sequences.

For known constituents, equal revision requires identical value and original time.
Higher revision corrects the reading while preserving time, including null. Changed
equal-revision facts or source time are `constituent_conflict`. A new submission below
the highest revision is `stale_constituent_revision`. New report IDs, later receipts, and
higher section sequences cannot bypass these checks. Accepted exact replay still recovers old results.

## Historical corrections and atomicity

A correction requires `mode: "history_only"` and revision above its retained target's highest.
Unknown targets are `evidence_not_found`. Non-increasing new corrections are
`stale_correction_revision`. Its envelope identifies the current valid source, while
the target retains its original context. Asset corrections require the current process,
even for prior-process targets.

Supply the target's complete section set with original classifications, result alternatives,
constituent identities, and quantity times. Corrected readings increase constituent revision.
Other carried readings use their highest accepted facts. No correction adds a reading or
changes original ordering. Its sequence never competes for current state.
Retain the original report and correction provenance without overwriting them.

Commit all sections, report identity, corrections, history, eligible current changes,
default Track effects, and public changes atomically. Failure commits none. History-only
admission preserves current sections, references, associations, and sequences, even for a
reading still displayed there. A later current snapshot can carry its corrected revision.
Receipt, correction, and fusion times never restart measurement age.

## Independent acceptance example

O17 and default Track T42 receive complete Telemetry in one publisher scope.
P1 is `51,-1`, P2 is `51.001,-1`, and corrected P1 is `51.0001,-1`.
Other quantities retain original identities and highest revisions.

| In delivery order | Retained history | Current O17 and T42 |
| --- | --- | --- |
| R11, sequence 11, new P2 revision 0 at `12:00:11Z` | P2 | P2, sequence 11 |
| R10, sequence 10, new P1 revision 0 at `12:00:10Z` | P1 and P2 | Unchanged |
| C10, history-only correction of R10, revision 1, corrected P1 revision 1 | Same two readings, corrected P1 | Unchanged |
| Exact R10, C10, and R11 replays through another gateway | No extra effects | Unchanged |
| New report, sequence 12, stale P1 revision 0 | Reject all effects | Unchanged |
| Different report ID at occupied sequence 11 | Reject `section_sequence_conflict` | Unchanged |

Use date `2026-10-21`. At `12:05:00Z`, P1 is 290 seconds old and P2 is 289 seconds old.
Null times stay unknown. Equal times never merge IDs. These are required, unexecuted outcomes.

[Reports](reports.md)
