# Evidence admission and current sections

**Accepting report evidence does not always replace a current section.**
These rules apply to Asset and Observation reports under [Reports](reports.md).
History-only admission retains evidence without changing the current section.

## Admission outcomes

Validate authorization, Dataset, source context, complete sections, and constituent
identities before committing new evidence. Historical submission does not bypass
process-generation or publisher checks. No partial section or subfield update is allowed.

| Submission | Evidence outcome | Current-section outcome |
| --- | --- | --- |
| Valid new current section with a newer source sequence | Accept its new evidence | Replace the whole section, including classification, result, and source times |
| Valid previously unseen section with an older source sequence | Accept new evidence into history only | Preserve the current section and its sequence |
| Valid history-only correction | Retain a higher revision against the original constituent identity and source time | Preserve the current section and its sequence |
| Exact replay of an accepted submission | Return its retained result | No repeated effects |
| Invalid new submission | Reject the whole submission, including history effects | No change |

Resolve exact accepted-submission replays from retained retry facts before treating
them as new evidence. A replay remains harmless after a later correction.
For a new submission, conflicting identity reuse or a constituent revision below
the highest accepted revision rejects all effects, even with a newer section sequence.
This preserves [Telemetry correction rules](components/telemetry.md#constituent-observation-identity).

A history-only correction targets retained evidence explicitly. Its correction
revision is independent of current-section ordering. A new delivery identity,
delivery time, or enclosing sequence cannot turn that correction into a current
section replacement. It retains the complete original source context and section
data with the corrected constituent. Exact envelope fields remain undecided.

Admit history and any eligible current replacements atomically under [Reports](reports.md#shared-context).
Use the [movement rules](reports.md#movement-and-recovery) for retained readings.
For the default fusion policy, history-only evidence and corrections remain
attributable through the existing Observation/Track association. They do not replace
either current section, change either Entity ID, or create another Track.
Receipt and correction times never replace source measurement times.

## Independent acceptance example

Use Observation O17 and its default Track T42 in one Dataset and publisher scope.
Every submission supplies complete valid Telemetry. Other required quantities keep
their original valid identities, revisions, values, and times throughout this example.
Position P1 is `51,-1`, P2 is `51.001,-1`, and corrected P1 is `51.0001,-1`.
The source times are `2026-10-21T12:00:10Z` for P1 and `2026-10-21T12:00:11Z` for P2.

| In delivery order | Expected position history | Expected current position in both O17 and T42 |
| --- | --- | --- |
| Accept report R11, section seq11, P2 revision 0 | One reading, P2 | P2 revision 0 at its original source time |
| Accept unseen report R10, section seq10, P1 revision 0 | Two readings, P1 and P2 | Unchanged P2 and seq11 |
| At 12:05, accept history-only C10 correcting P1 to revision 1 | Still two readings, with P1's correction retained | Unchanged P2 and seq11 |
| Replay R10 and C10 exactly, then R11, through another gateway | No extra reading or correction | Unchanged P2 and seq11, with no repeated public effect |
| Submit a new report with seq12 but stale P1 revision 0 | Reject atomically, history unchanged | Unchanged P2 and seq11 |

C10 keeps P1's original `12:00:10Z` source time. P2 keeps `12:00:11Z`.
At 12:05 their ages are 290 and 289 seconds. Correction and replay do not restart
either age. Repeat with both source times null and with equal known times.
Null ages remain unknown, and equal times do not merge the distinct P1/P2 identities.
These are required expected outcomes, not results of an executed runtime test.

[Reports](reports.md)
