# Evidence admission and current sections

Accepting evidence does not always replace a current section. The [report format](report-format.md)
owns exact source, section-result, and constituent fields. These rules apply to
Asset and Observation reports and default Track effects.

## Identity and ordering

After current authority, Dataset, and [lifecycle](identity.md) checks, resolve accepted
exact replays before new admission. Replay recovers the retained result as duplicate
evidence, without effects or fresh contact.
Changed facts for a scoped `report_id` are `report_identity_conflict`. Member order
and JSON whitespace are immaterial. Omission, null, array order, and accepted string
spellings are facts.

Reserve each `(Dataset, Entity, origin, section, sequence)` for its report identity.
Another report using an occupied sequence is `section_sequence_conflict`, even with
identical values or a lower-than-current sequence. Disjoint sections can share a
sequence. Higher sequences replace current results only in `current` mode.
Unseen older sequences and `history_only` reports can add positions without replacing
current sections. History-only admission does not advance their current sequences.

The first current result from an accepted replacement Asset process supersedes the
prior-process result at any positive sequence, even 1 after 100. Omitted sections
retain their result and scope. Later comparisons use the current process's section
sequence. Unseen obsolete-process reports are refused, including historical reports.
Accepted exact replay has no effect. [Publisher continuity](observations.md#reports-and-movement)
never resets Observation sequences.

A known constituent requires identical value and original effective source time,
including null and timestamp spelling. Changed facts are `constituent_conflict`.
New report IDs, later receipts, higher section sequences, or a replacement process
cannot rewrite an existing scoped reading. New readings require new IDs.

## Atomic admission

Commit all sections, report identity, sequence reservations, newly accepted positions,
eligible current changes, default Track effects, and public log effects atomically.
Failure commits none. History-only admission preserves current sections, references,
associations, and sequences. It still adds previously unseen positions to history
through their original source scope. Receipt and fusion times never restart age.
Speed and altitude remain latest-state quantities, not historical query data.

## Independent acceptance example

O17 and default Track T42 receive complete Telemetry in one publisher scope.
P1 is `51,-1` and P2 is `51.001,-1`. Other quantities retain original reading facts.
Labels abbreviate UUIDs. Use date `2026-10-21` for all times below.

| In delivery order | Retained position history | Current O17 and T42 |
| --- | --- | --- |
| R11, sequence 11, new P2 at `12:00:11Z` | P2 | P2, sequence 11 |
| R10, sequence 10, new P1 at `12:00:10Z` | P1 and P2 | Unchanged |
| R12, sequence 12, history-only new P0 at `12:00:09Z` | P0, P1, P2 | Unchanged, sequence 11 |
| Exact R10, R11, and R12 replays through another gateway | No extra effects | Unchanged |
| New report, sequence 13, reuses P1 with `51.0001,-1` | Reject `constituent_conflict`; no effects | Unchanged |
| Different report ID at occupied sequence 11 | Reject `section_sequence_conflict` | Unchanged |
| New current report, sequence 13, carries unchanged P2 | No extra position | New section evidence, original P2 age |

The failed sequence-13 submission reserves nothing. At `12:05:00Z`, P1 is 290
seconds old and P2 is 289 seconds old. Null times stay unknown. Equal times never
merge IDs. These are required, unexecuted outcomes.

[Reports](reports.md)
