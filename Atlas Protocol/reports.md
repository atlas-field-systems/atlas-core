# Reports, time, and contact

`UpdateAsset` changes Asset descriptions, status, and measurements. Accepting
evidence and establishing fresh contact are distinct outcomes. Observation reports
describe detected subjects separately from the reporting Asset's own measurements.

## Shared context

The exact [report metadata](report-format.md) defines Dataset/source identity,
process generation, original evidence identity, ordering, and current/history intent.
Sections carry original [quantity times](components/README.md#shared-section-results).
Unknown time stays null. New packets cannot make retained evidence fresh.
Observation reports retain their recorded publisher rather than an Asset process.

Apply [section classifications](entities.md#reported-sections) independently.
Omission preserves the accepted result, classification, and times. An eligible
supplied section replaces the prior result completely, whether value, error, or
withdrawal. Apply [evidence admission](report-evidence.md) before current replacement.
Validate the complete candidate. Missing required fields reject the update.
Never merge subfields or inherit old optional values. Null is valid only where defined.

The source reports actual section failures with an error code and optional message.
Core exposes that error without diagnosing hardware, reconstructing healthy
subfields, or falling back to old values. Normal validation and ordering apply.
The [section result layout](components/README.md#shared-section-results) carries
classification and exactly one result alternative. Fresh contact or bundling never
refreshes original measurement times.

Withdrawal explicitly ends a state-until-changed assertion. Retain its ordering
evidence so an older report cannot restore it. Omission still preserves state.
Required section containers remain present with a withdrawn result.

Validate identity, authority, original facts, and every effect atomically.
Classify accepted, duplicate, or rejected evidence separately from freshness.
Duplicates alone cannot refresh contact, append movement, repeat activity, or
produce a public change. Order each section, Task stream, and queue stream
independently. New telemetry cannot discard an earlier unseen Task outcome.
Core deduplicates at its IP boundary independently of key, gateway, packet identity,
and optional edge-link deduplication. Source identity is separate from delivery.

## Process generations

Direct and gateway reports use [API-key permissions](identity.md#principals).
Keep the reported Asset/process separate from the submitting key. Preserve validated
original identifier and timestamp spellings in retained report facts.
Registration records the initial generation without establishing contact.
The [contact exchange](contact.md) defines challenge allocation, first check-in,
and atomic process replacement. Reconnect is not replacement; an obsolete process
cannot publish new execution state. A gateway restart is not an Asset restart.
A gateway preserves attributable Asset proof; its own proof cannot replace it.
Radio encoding and edge-link retries remain external.

## Time and contact

Deployment supplies correct UTC clocks. Atlas does not estimate offsets, correct
drift, or rewrite source times. Measurement time, Core receipt time, and actual
state-change time remain separate. Unchanged fresh status is not a new change time.
Core compares each new reading's effective source time with Core UTC at first successful admission.
Otherwise valid future-dated measurements are time-uncertain, without usable fresh
age. Null time is unknown; other accepted times are known. Retain this classification
with the scoped reading through retries, carry-forward, fusion, and Restart.
Elapsed time never promotes an uncertain reading to known. Source time stays unchanged.
History exposes this retained classification as `time_status`; frozen views and new
queries agree about the same reading. Clock-uncertainty metadata adds no offset calculation.

Fresh contact requires accepted current-process evidence created after a Core
challenge and received within its monotonic expiry. The [contact exchange](contact.md)
fixes proof fields and the ten-second maximum lifetime. Restart invalidates challenges.
Historical reports, duplicates, Observation-only reports, fusion updates, open
connections, and description changes alone do not establish contact. Gateway IP
health does not prove downstream reachability.

Communications is `healthy` for less than 15 seconds after accepted fresh contact,
`degraded` from 15 seconds until 60 seconds, and `offline` at 60 seconds.
No proven contact in the current Core run means offline. Core uses monotonic elapsed
time; source timestamps never reset this timer. Expiry transitions are public
committed changes without needing a new packet. These defaults remain unqualified.
Bandwidth capability is separate. High-bandwidth links can be offline, and gateway
connectivity proves neither an Asset's health nor its bandwidth. Unknown stays unknown.

## Movement and recovery

Append only newly accepted position readings, including late historical evidence,
under [Telemetry identity rules](components/telemetry.md#constituent-reading-identity).
Carried readings and retries add nothing. Existing scoped reading facts are immutable.
Latest Telemetry retains speed and altitude without historical queries.
Never sample a merged Entity image into history. History survives Entity deletion
until Reset. Bounded queries distinguish unknown IDs from known-empty history.
Both SDK modes read [position history](movement-history.md) explicitly through HTTP.

On reconnect, reconcile retained reports and current instructions. A new connection
or process cannot authorize automatically repeating uncertain physical work.
Keep uncertainty visible until evidence or an explicit operator decision resolves it.

[Next: movement history](movement-history.md)
